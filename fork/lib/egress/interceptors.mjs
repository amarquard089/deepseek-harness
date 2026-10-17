// Low-level interception installed by fork/egress-shim.mjs inside the probed
// process.
//
// Every patch is a pass-through: it records the target and then calls the
// original, so the probed process behaves exactly as it would without the shim.
// The layers, from the chokepoints outward:
//
//   net.Socket.prototype.connect   every TCP connection, including HTTP agents
//                                  and undici's own sockets
//   tls.connect                    every TLS handshake (the net layer records
//                                  the same attempt; the tls layer claims it
//                                  and the net layer stays quiet for that call)
//   dns                            lookup/resolve/reverse on the module,
//                                  dns.promises, and dns.Resolver
//   http.request/get               URL-level HTTP attempts
//   https.request/get              URL-level HTTPS attempts
//   globalThis.fetch               the fetch entry point
//   undici Dispatcher/Client/Pool  dispatcher-level dispatch, when undici is
//                                  resolvable from a policy-supplied anchor
//   http2.connect                  HTTP/2 sessions
//   dgram.Socket.prototype.send    UDP datagrams
//   child_process.*                child launches, recorded for visibility only:
//                                  a non-Node child cannot be intercepted in
//                                  process, so its command line is the evidence
//
// {@link installInterceptors} reports `installed` or a failure string per layer,
// and the heartbeat carries that map, so a layer that silently failed to install
// is visible in the evidence instead of being assumed to work.

import { createRequire } from 'node:module'
import { captureStack } from './recorder.mjs'
import { classifyTarget } from './classify.mjs'

const require = createRequire(import.meta.url)

/** Longest recorded command line kept per child-process record. */
const COMMAND_CHARS = 400

/** Longest recorded path kept per request record. */
const PATH_CHARS = 300

/**
 * Read the target fields out of `Socket.prototype.connect` arguments.
 * Handles `connect(options)`, `connect(port[, host][, cb])`, `connect(path[, cb])`,
 * and the internal form Node uses when `net.connect`/`net.createConnection`
 * forward their normalized argument array as a single argument.
 * @param {unknown[]} args Arguments as passed by the caller.
 * @returns {{host: string|null, port: number|null, path: string|null}} Target fields.
 */
export function parseConnectArgs(args) {
  const effective = args.length === 1 && Array.isArray(args[0]) ? args[0] : args
  const first = effective[0]
  if (typeof first === 'number') {
    return {
      host: typeof effective[1] === 'string' ? effective[1] : null,
      port: first,
      path: null,
    }
  }
  if (typeof first === 'string') {
    // A bare string is a Unix-domain socket or pipe path: an IPC endpoint the
    // caller named directly, never a peer.
    return { host: null, port: null, path: first }
  }
  if (typeof first === 'object' && first !== null) {
    const options = /** @type {{host?: unknown, hostname?: unknown, port?: unknown, path?: unknown}} */ (first)
    const host = typeof options.host === 'string' ? options.host : typeof options.hostname === 'string' ? options.hostname : null
    const port = typeof options.port === 'number' ? options.port : options.port === undefined ? null : Number(options.port)
    return { host, port, path: typeof options.path === 'string' ? options.path : null }
  }
  return { host: null, port: null, path: null }
}

/** Default port for a scheme with no explicit port, or null when it has none. */
function defaultPort(protocol) {
  if (protocol === 'https' || protocol === 'wss') return 443
  if (protocol === 'http' || protocol === 'ws') return 80
  return null
}

/**
 * Read the target fields out of `http(s).request` arguments.
 * The URL path is reported as `urlPath`, which classification ignores: only
 * `path` names an IPC endpoint.
 * @param {unknown[]} args Arguments as passed by the caller.
 * @param {string} defaultProtocol Protocol implied by the module (`http` or `https`).
 * @returns {{host: string|null, port: number|null, protocol: string, urlPath: string|null}} Target fields.
 */
export function parseRequestArgs(args, defaultProtocol) {
  const first = args[0]
  if (typeof first === 'string' || first instanceof URL) {
    try {
      const url = new URL(String(first))
      const protocol = url.protocol.replace(/:$/u, '') || defaultProtocol
      return {
        host: url.hostname,
        port: url.port === '' ? defaultPort(protocol) : Number(url.port),
        protocol,
        urlPath: `${url.pathname}${url.search}`.slice(0, PATH_CHARS),
      }
    } catch {
      return { host: null, port: null, protocol: defaultProtocol, urlPath: null }
    }
  }
  if (typeof first === 'object' && first !== null) {
    const options = /** @type {{host?: unknown, hostname?: unknown, port?: unknown, protocol?: unknown, path?: unknown}} */ (first)
    const host = typeof options.host === 'string' ? options.host : typeof options.hostname === 'string' ? options.hostname : null
    const protocol = typeof options.protocol === 'string' ? options.protocol.replace(/:$/u, '') : defaultProtocol
    const port = typeof options.port === 'number' ? options.port : options.port === undefined ? defaultPort(protocol) : Number(options.port)
    return {
      host,
      port,
      protocol,
      urlPath: typeof options.path === 'string' ? options.path.slice(0, PATH_CHARS) : null,
    }
  }
  return { host: null, port: null, protocol: defaultProtocol, urlPath: null }
}

/**
 * Read the target of a `fetch` input.
 * @param {unknown} input First `fetch` argument: a URL, a string, or a Request.
 * @returns {{host: string|null, port: number|null, protocol: string, urlPath: string|null}} Target fields.
 */
export function parseFetchInput(input) {
  const raw = typeof input === 'object' && input !== null && 'url' in input
    ? /** @type {{url: unknown}} */ (input).url
    : input
  try {
    const url = new URL(String(raw))
    const protocol = url.protocol.replace(/:$/u, '') || 'fetch'
    return {
      host: url.hostname,
      port: url.port === '' ? defaultPort(protocol) : Number(url.port),
      protocol,
      urlPath: `${url.pathname}${url.search}`.slice(0, PATH_CHARS),
    }
  } catch {
    return { host: null, port: null, protocol: 'fetch', urlPath: null }
  }
}

/**
 * Read the target of an undici dispatch call from its options.
 * @param {{origin?: unknown, path?: unknown}} [options] Dispatch options.
 * @returns {{host: string|null, port: number|null, protocol: string, urlPath: string|null}} Target fields.
 */
export function parseDispatchOptions(options) {
  if (typeof options === 'string' || options instanceof URL) return parseRequestArgs([options], 'undici')
  const source = options?.origin instanceof URL
    ? options.origin
    : typeof options?.origin === 'string'
      ? options.origin
      : typeof options?.path === 'string' && /^https?:\/\//u.test(options.path)
        ? options.path
        : null
  if (source === null) return { host: null, port: null, protocol: 'undici', urlPath: null }
  return parseRequestArgs([source], 'undici')
}

/** Wrap an own function property so each call first records, then delegates. */
function wrapFunction(target, property, before) {
  const original = target[property]
  if (typeof original !== 'function') return false
  const replacement = function (...args) {
    before(args, this)
    return Reflect.apply(original, this, args)
  }
  Object.defineProperty(replacement, 'name', { value: original.name, configurable: true })
  target[property] = replacement
  return true
}

/** Install one layer, turning a throw into a reported layer status. */
function installLayer(layers, name, install) {
  try {
    layers[name] = install() ?? 'installed'
  } catch (error) {
    layers[name] = `failed: ${error.message}`
  }
}

/**
 * Install every interception layer.
 * @param {{record: (record: object) => boolean}} recorder Recorder from createRecorder.
 * @param {{undiciAnchors?: string[], shimUrl?: string, shimPath?: string}} [options] Directories whose
 *   `undici` dependency may be patched, and this shim's URL and path for worker-thread preloading.
 * @returns {Record<string, string>} Layer name to `installed` or `failed: …` or `unavailable: …`.
 */
export function installInterceptors(recorder, options = {}) {
  const layers = {}
  // True exactly while tls.connect runs, so the tls layer claims the socket
  // connect that tls.connect performs synchronously before it returns.
  const state = { inTls: false }

  /** Record one interception; a throwing recorder must never break the probe. */
  const safeRecord = (fields) => {
    try {
      recorder.record({
        classification: classifyTarget(fields),
        stack: captureStack(),
        ...fields,
      })
    } catch {
      // The probed process keeps running even when evidence cannot be written;
      // the recorder already reported the failure on stderr.
    }
  }
  const recordConnect = (layer, protocol, args) => {
    safeRecord({ kind: 'connect', layer, protocol, ...parseConnectArgs(args) })
  }

  installLayer(layers, 'net', () => {
    const net = require('node:net')
    const prototype = net.Socket?.prototype
    if (prototype === undefined || typeof prototype.connect !== 'function') {
      throw new Error('net.Socket.prototype.connect is not a function')
    }
    wrapFunction(prototype, 'connect', args => {
      if (state.inTls) return
      recordConnect('net', 'tcp', args)
    })
  })

  installLayer(layers, 'tls', () => {
    const tls = require('node:tls')
    const original = tls.connect
    if (typeof original !== 'function') throw new Error('tls.connect is not a function')
    tls.connect = function (...args) {
      recordConnect('tls', 'tls', args)
      state.inTls = true
      try {
        return Reflect.apply(original, this, args)
      } finally {
        state.inTls = false
      }
    }
  })

  installLayer(layers, 'dns', () => {
    const dns = require('node:dns')
    const names = [
      'lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx',
      'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse',
    ]
    const record = (args) => {
      safeRecord({
        kind: 'dns',
        layer: 'dns',
        protocol: 'dns',
        host: typeof args[0] === 'string' ? args[0] : null,
        port: null,
        path: null,
      })
    }
    let installed = 0
    for (const target of [dns, dns.promises, dns.Resolver?.prototype]) {
      if (target === undefined) continue
      for (const name of names) {
        if (wrapFunction(target, name, record)) installed += 1
      }
    }
    if (installed === 0) throw new Error('no dns entry point could be wrapped')
    return `installed (${installed} entry points)`
  })

  for (const name of ['http', 'https']) {
    installLayer(layers, name, () => {
      const module = require(`node:${name}`)
      let installed = 0
      for (const method of ['request', 'get']) {
        const wrapped = wrapFunction(module, method, args => {
          safeRecord({ kind: 'request', layer: name, ...parseRequestArgs(args, name) })
        })
        if (wrapped) installed += 1
      }
      if (installed === 0) throw new Error(`${name}.request and ${name}.get could not be wrapped`)
    })
  }

  installLayer(layers, 'fetch', () => {
    if (typeof globalThis.fetch !== 'function') throw new Error('globalThis.fetch is not a function')
    const original = globalThis.fetch
    globalThis.fetch = function (...args) {
      safeRecord({ kind: 'fetch', layer: 'fetch', ...parseFetchInput(args[0]) })
      return Reflect.apply(original, this, args)
    }
  })

  installLayer(layers, 'undici', () => resolveUndici(createRequire, options.undiciAnchors ?? [], safeRecord))

  installLayer(layers, 'http2', () => {
    const http2 = require('node:http2')
    wrapFunction(http2, 'connect', args => {
      const first = args[0]
      const authority = typeof first === 'string' || first instanceof URL ? first : null
      const options = typeof first === 'object' && first !== null && !(first instanceof URL)
        ? first
        : typeof args[1] === 'object' && args[1] !== null ? args[1] : {}
      const parsed = parseDispatchOptions({ origin: authority ?? options.origin ?? options })
      safeRecord({
        kind: 'http2',
        layer: 'http2',
        protocol: 'http2',
        host: parsed.host ?? (typeof options.host === 'string' ? options.host : null),
        port: parsed.port ?? (typeof options.port === 'number' ? options.port : null),
        path: null,
        urlPath: parsed.urlPath,
      })
    })
  })

  installLayer(layers, 'dgram', () => {
    const dgram = require('node:dgram')
    const prototype = dgram.Socket?.prototype
    if (prototype === undefined || typeof prototype.send !== 'function') {
      throw new Error('dgram.Socket.prototype.send is not a function')
    }
    wrapFunction(prototype, 'send', args => {
      // send(msg, port[, address][, cb]) or send(msg, offset, length, port[, address][, cb])
      const offsetForm = typeof args[1] === 'number' && typeof args[2] === 'number' && typeof args[3] === 'number'
      const port = offsetForm ? args[3] : typeof args[1] === 'number' ? args[1] : null
      const address = offsetForm
        ? typeof args[4] === 'string' ? args[4] : null
        : typeof args[2] === 'string' ? args[2] : null
      safeRecord({ kind: 'udp', layer: 'dgram', protocol: 'udp', host: address, port, path: null })
    })
  })

  installLayer(layers, 'worker_threads', () => {
    const workerThreads = require('node:worker_threads')
    const OriginalWorker = workerThreads.Worker
    const shimPath = options.shimPath
    if (typeof OriginalWorker !== 'function') throw new Error('worker_threads.Worker is not a constructor')
    if (typeof shimPath !== 'string') throw new Error('the shim path is required to cover worker threads')
    // A worker gets its own module registry, so none of the patches above exist
    // there, and NODE_OPTIONS is not re-read for workers. Node ignores `--import`
    // in a worker's execArgv but honors `--require`, and `require()` of this
    // synchronously-evaluated ESM shim loads it in the worker thread. The
    // harness constructs several workers with `execArgv: []`, so the preload is
    // appended to the worker's own argv instead of being inherited.
    class ShimmedWorker extends OriginalWorker {
      constructor(...args) {
        const withShim = (workerOptions) => {
          const base = workerOptions?.execArgv ?? process.execArgv ?? []
          if (base.includes(shimPath)) return workerOptions
          return { ...(workerOptions ?? {}), execArgv: [...base, '--require', shimPath] }
        }
        if (args.length >= 2) args[1] = withShim(args[1])
        else args.push(withShim(undefined))
        super(...args)
      }
    }
    workerThreads.Worker = ShimmedWorker
  })

  installLayer(layers, 'child_process', () => {
    const childProcess = require('node:child_process')
    const record = (args) => {
      const first = args[0]
      const command = typeof first === 'string' ? first : String(first?.command ?? first?.file ?? '')
      const commandArgs = Array.isArray(args[1]) ? args[1] : typeof args[1] === 'string' ? [args[1]] : []
      // A non-Node child cannot be intercepted in process; its command line is
      // what the gate can see, so it is recorded as evidence.
      safeRecord({
        kind: 'spawn',
        layer: 'child_process',
        protocol: 'spawn',
        host: null,
        port: null,
        path: command.slice(0, COMMAND_CHARS),
        command: command.slice(0, COMMAND_CHARS),
        args: commandArgs.slice(0, 20).map(value => String(value).slice(0, COMMAND_CHARS)),
      })
    }
    let installed = 0
    for (const method of ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']) {
      if (wrapFunction(childProcess, method, record)) installed += 1
    }
    if (installed === 0) throw new Error('no child_process entry point could be wrapped')
  })

  return layers
}

/**
 * Patch undici's dispatcher choke points when undici resolves from a policy
 * anchor. undici is a transitive dependency of this repository, so it is often
 * not resolvable from the repository root; the anchors name packages that
 * declare it directly.
 * @param {typeof createRequire} createRequireFromShim `createRequire` implementation to bind.
 * @param {string[]} anchors Directories or `package.json` paths to resolve from.
 * @param {(fields: object) => void} safeRecord Sink that never throws.
 * @returns {string} Layer status: `installed …` or `unavailable: …`.
 */
export function resolveUndici(createRequireFromShim, anchors, safeRecord) {
  const failures = []
  for (const anchor of anchors) {
    try {
      const anchorPath = anchor.endsWith('.json') ? anchor : `${anchor.replace(/[/\\]+$/u, '')}/package.json`
      const anchorRequire = createRequireFromShim(anchorPath)
      const resolved = anchorRequire.resolve('undici')
      return patchUndiciDispatcher(anchorRequire(resolved), resolved, safeRecord)
    } catch (error) {
      failures.push(`${anchor}: ${error.message}`)
    }
  }
  const detail = failures.length === 0 ? 'no anchors configured' : failures.join('; ')
  return `unavailable: undici did not resolve from any anchor (${detail})`
}

/**
 * Wrap the dispatcher choke points on an already-resolved undici module.
 *
 * The effective choke point is an internal base class (`DispatcherBase`) whose
 * `dispatch` shadows the exported `Dispatcher.prototype.dispatch` that
 * `undici.request` never reaches, so every prototype in the chain of each
 * exported dispatcher class is walked, and each own `dispatch` is wrapped once.
 * @param {object} undici Resolved undici module namespace.
 * @param {string} resolvedPath Path undici resolved to, for the layer status.
 * @param {(fields: object) => void} safeRecord Sink that never throws.
 * @returns {string} Layer status.
 */
export function patchUndiciDispatcher(undici, resolvedPath, safeRecord) {
  const recordDispatch = (args) => {
    safeRecord({ kind: 'undici', layer: 'undici', ...parseDispatchOptions(args[0]) })
  }
  const wrapped = new Set()
  let installed = 0
  for (const className of ['Dispatcher', 'Client', 'Pool', 'Agent', 'ProxyAgent', 'EnvHttpProxyAgent']) {
    let prototype = undici?.[className]?.prototype
    while (prototype !== null && prototype !== undefined && prototype !== Object.prototype) {
      if (!wrapped.has(prototype)) {
        wrapped.add(prototype)
        if (Object.prototype.hasOwnProperty.call(prototype, 'dispatch')
          && wrapFunction(prototype, 'dispatch', recordDispatch)) installed += 1
      }
      prototype = Object.getPrototypeOf(prototype)
    }
  }
  for (const method of ['request', 'fetch', 'stream', 'pipeline']) {
    if (wrapFunction(undici, method, (args) => {
      safeRecord({ kind: 'undici', layer: `undici.${method}`, ...parseDispatchOptions(args[0]) })
    })) installed += 1
  }
  if (installed === 0) {
    return `unavailable: undici resolved at ${resolvedPath} but no dispatcher entry point could be wrapped`
  }
  return `installed (${installed} entry points via ${resolvedPath})`
}

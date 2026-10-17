// Deliberate interception self-check for the runtime egress gate.
//
// The gate runs this file inside the probed process, with the shim loaded, and
// then asserts that the evidence file contains exactly these attempts. It is
// the control that keeps the gate from passing vacuously:
//
//   * a closed local port proves the interception fires and that the patch is a
//     pass-through (the socket really connects and the kernel really refuses);
//   * a reserved external-looking address proves an egress attempt is recorded
//     and classified as `egress` rather than silently treated as local;
//   * a reserved DNS name proves a name lookup is recorded even when no
//     connection follows;
//   * a request through the resolved `undici` package proves the dispatcher
//     layer intercepts real traffic from the library, not just the net layer
//     underneath it;
//   * a spawned child process proves the shim's NODE_OPTIONS propagation covers
//     subprocesses.
//
// The addresses are IANA-reserved documentation ranges (RFC 5737) and the name
// is under the reserved `.invalid` TLD (RFC 2606): none of them can reach a real
// service. The script declares every attempt on one machine-readable line so the
// gate can detect drift between this file, the policy, and the evidence.
//
// This file never runs in a normal build: only the gate starts it.

import { spawn } from 'node:child_process'
import dns from 'node:dns'
import { createRequire } from 'node:module'
import { createServer, connect as netConnect } from 'node:net'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

/** Marks the machine-readable summary line on stdout. */
export const SELF_CHECK_MARKER = 'DSH_FORK_EGRESS_SELFCHECK'

/** Reserved parent-process target (RFC 5737 TEST-NET-3); never routed. */
export const RESERVED_PARENT = { host: '203.0.113.1', port: 443 }

/** Reserved child-process target (RFC 5737 TEST-NET-2); never routed. */
export const RESERVED_CHILD = { host: '198.51.100.7', port: 9443 }

/** Reserved target for the undici dispatcher attempt (RFC 5737 TEST-NET-3). */
export const RESERVED_UNDICI = { host: '203.0.113.11', port: 8443 }

/** Reserved target for the worker-thread attempt (RFC 5737 TEST-NET-1). */
export const RESERVED_WORKER = { host: '192.0.2.9', port: 7443 }

/** Reserved name under the `.invalid` TLD (RFC 2606). */
export const DNS_NAME = 'egress-self-check.invalid'

/** Longest an attempt waits for the kernel before the socket is abandoned. */
const ATTEMPT_TIMEOUT_MS = 900

/** Longest the undici attempt waits before the script stops waiting for it. */
const UNDICI_ABANDON_MS = 2000

/**
 * Reserve and release a loopback port so the next connect is refused.
 * @returns {Promise<number>} A port that is closed at the moment it is returned.
 */
function closedLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => { resolve(port) })
    })
  })
}

/**
 * Attempt one TCP connection and report how the kernel answered.
 * @param {{host: string, port: number}} target Connect target.
 * @param {number} timeoutMs Longest wait before the socket is abandoned.
 * @returns {Promise<{errorCode: string|null, connected: boolean}>} Kernel outcome.
 */
function attemptConnect(target, timeoutMs = ATTEMPT_TIMEOUT_MS) {
  return new Promise(resolve => {
    const socket = netConnect({ host: target.host, port: target.port })
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(outcome)
    }
    socket.once('connect', () => { finish({ errorCode: null, connected: true }) })
    socket.once('error', error => { finish({ errorCode: error.code ?? 'unknown', connected: false }) })
    socket.setTimeout(timeoutMs, () => { finish({ errorCode: 'timeout', connected: false }) })
  })
}

/**
 * Resolve a name that cannot exist, reporting how the resolver answered.
 * @param {string} name Name to look up.
 * @returns {Promise<string|null>} Error code, or null when the name unexpectedly resolved.
 */
function lookupFailure(name) {
  return new Promise(resolve => {
    dns.lookup(name, (error) => { resolve(error === null ? null : error.code ?? 'unknown') })
  })
}

/**
 * Spawn a Node child that attempts one reserved connection, and wait for it.
 * The child's shim is inherited through `NODE_OPTIONS`, which only the shim set.
 * @param {{host: string, port: number}} target Connect target for the child.
 * @returns {Promise<{pid: number|null, code: number|null}>} Child identity and exit code.
 */
function spawnChildAttempt(target) {
  const script = [
    "const net = require('node:net')",
    `const socket = net.connect({ host: ${JSON.stringify(target.host)}, port: ${target.port} })`,
    "socket.on('error', () => {})",
    'setTimeout(() => { socket.destroy(); process.exit(0) }, 400)',
  ].join('\n')
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['-e', script], {
      // A fresh copy of this process's environment: the shim is what put itself
      // into NODE_OPTIONS, so the child is covered only because that worked.
      env: { ...process.env },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    const pid = child.pid ?? null
    child.once('exit', code => { resolve({ pid, code }) })
    child.once('error', () => { resolve({ pid, code: null }) })
  })
}

/**
 * Resolve the `undici` package from a policy-supplied anchor.
 * Node's built-in fetch uses an internal undici copy that userland cannot patch,
 * so this proves the layer against the library the repository itself depends on.
 * @returns {{undici: object|null, anchor: string|null}} Resolved library, if any.
 */
function loadUndici() {
  const raw = process.env.DSH_FORK_EGRESS_UNDICI_ANCHORS ?? ''
  const anchors = raw.split(process.platform === 'win32' ? ';' : ':').map(value => value.trim()).filter(Boolean)
  for (const anchor of anchors) {
    try {
      const anchorRequire = createRequire(anchor.endsWith('.json') ? anchor : join(anchor, 'package.json'))
      return { undici: anchorRequire(anchorRequire.resolve('undici')), anchor }
    } catch {
      // The next anchor may resolve; the summary reports when none does.
    }
  }
  return { undici: null, anchor: null }
}

/**
 * Issue one `undici.request` to a reserved address and report what happened.
 * @param {{host: string, port: number}} target Request target.
 * @returns {Promise<{available: boolean, anchor: string|null, outcome: string}>} Attempt outcome.
 */
async function undiciAttempt(target) {
  const loaded = loadUndici()
  if (loaded.undici === null) {
    return { available: false, anchor: null, outcome: 'undici did not resolve from any configured anchor' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, 400)
  const attempt = loaded.undici
    .request(`http://${target.host}:${target.port}/egress-self-check`, { signal: controller.signal })
    .then(() => 'completed-unexpectedly')
    .catch(error => error?.name ?? 'error')
  const outcome = await Promise.race([
    attempt,
    new Promise(resolve => { setTimeout(() => { resolve('abandoned') }, UNDICI_ABANDON_MS) }),
  ])
  clearTimeout(timer)
  return { available: true, anchor: loaded.anchor, outcome }
}

/**
 * Run one reserved-address connect inside a worker thread and wait for it.
 * A worker gets its own module registry and the harness constructs workers with
 * `execArgv: []`, so the shim has to inject itself into the worker's argv; this
 * attempt fails if that injection does not happen.
 * @param {{host: string, port: number}} target Connect target for the worker.
 * @returns {Promise<{threadId: number, code: number|null}>} Worker identity and exit code.
 */
function workerAttempt(target) {
  const code = [
    "const net = require('node:net')",
    `const socket = net.connect({ host: ${JSON.stringify(target.host)}, port: ${target.port} })`,
    "socket.on('error', () => {})",
    'setTimeout(() => { socket.destroy(); process.exit(0) }, 400)',
  ].join('\n')
  return new Promise((resolve) => {
    // Read the constructor at call time: the shim replaced the module export.
    const { Worker } = require('node:worker_threads')
    const worker = new Worker(code, { eval: true, stdout: true, stderr: true })
    const threadId = worker.threadId
    worker.once('exit', code => { resolve({ threadId, code }) })
    worker.once('error', () => { resolve({ threadId, code: null }) })
  })
}

/**
 * Run every attempt and print the summary the gate reads.
 * @returns {Promise<void>} Resolves once the summary is written.
 */
async function main() {
  const localPort = await closedLoopbackPort()
  const localTarget = { host: '127.0.0.1', port: localPort }

  const localOutcome = await attemptConnect(localTarget)
  const parentOutcome = await attemptConnect(RESERVED_PARENT)
  const undiciOutcome = await undiciAttempt(RESERVED_UNDICI)
  const workerOutcome = await workerAttempt(RESERVED_WORKER)
  const childOutcome = await spawnChildAttempt(RESERVED_CHILD)
  const dnsError = await lookupFailure(DNS_NAME)

  const summary = {
    attempts: [
      { label: 'local-closed-port', kind: 'connect', layer: 'net', protocol: 'tcp', host: localTarget.host, port: localTarget.port, expected: 'local' },
      { label: 'reserved-parent', kind: 'connect', layer: 'net', protocol: 'tcp', host: RESERVED_PARENT.host, port: RESERVED_PARENT.port, expected: 'egress' },
      { label: 'reserved-undici', kind: 'undici', layer: 'undici', protocol: 'http', host: RESERVED_UNDICI.host, port: RESERVED_UNDICI.port, expected: 'egress' },
      { label: 'reserved-worker', kind: 'connect', layer: 'net', protocol: 'tcp', host: RESERVED_WORKER.host, port: RESERVED_WORKER.port, expected: 'egress' },
      { label: 'reserved-child', kind: 'connect', layer: 'net', protocol: 'tcp', host: RESERVED_CHILD.host, port: RESERVED_CHILD.port, expected: 'egress' },
      { label: 'reserved-dns', kind: 'dns', layer: 'dns', protocol: 'dns', host: DNS_NAME, port: null, expected: 'egress' },
    ],
    localConnect: localOutcome,
    parentConnect: parentOutcome,
    undici: undiciOutcome,
    worker: workerOutcome,
    dnsError,
    child: childOutcome,
    rootPid: process.pid,
    shim: process.env.NODE_OPTIONS ?? '',
  }
  process.stdout.write(`${SELF_CHECK_MARKER} ${JSON.stringify(summary)}\n`)
  // Pending sockets to reserved addresses are abandoned here; the gate only
  // needs the interception records, which were written when the calls were made.
  process.exit(0)
}

await main()

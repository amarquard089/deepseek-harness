// Runtime egress shim for the fork's authoritative network gate.
//
// Load it into the process under test with `--import`, or let fork/verify-egress.mjs
// inject it through NODE_OPTIONS (which this module also does for children, so
// spawned subprocesses stay covered):
//
//   DSH_FORK_EGRESS_LOG=/tmp/egress.jsonl node --import ./fork/egress-shim.mjs app.mjs
//
// The shim only records. It never blocks, rewrites, or delays a connection, so
// a probe that the gate observes was a probe that really ran.
//
// Anti-vacuity is the point of this file:
//   * it writes a heartbeat record at load time, carrying the installed layer
//     map, the absolute shim path, and the Node options it propagated;
//   * a run whose heartbeat is missing is reported by the gate as
//     `status=error` (exit 2), never as a pass — a shim that silently failed to
//     load must not look like a clean run;
//   * when the evidence file cannot be written it says so on stderr and
//     disables itself visibly instead of failing quietly.

import { fileURLToPath } from 'node:url'
import { EGRESS_LOG_ENV, EGRESS_UNDICI_ANCHORS_ENV, SHIM_PREFIX, createRecorder } from './lib/egress/recorder.mjs'
import { installInterceptors } from './lib/egress/interceptors.mjs'

/** Guards against a second installation when the shim is loaded twice. */
const INSTALLED = Symbol.for('dsh.fork.egress-shim.installed')

/** Absolute path of this shim, as Node resolved it. */
const SHIM_URL = import.meta.url

/**
 * Add this shim to `NODE_OPTIONS` so every Node child of the probed process is
 * intercepted too. The token is the shim's own URL, so a re-run is idempotent
 * and a child never loads it twice.
 * @returns {{propagated: boolean, nodeOptions: string}} Whether this call added the token, and the result.
 */
function propagateToChildren() {
  const current = process.env.NODE_OPTIONS ?? ''
  if (current.includes(SHIM_URL)) return { propagated: false, nodeOptions: current }
  const next = `--import ${SHIM_URL}${current === '' ? '' : ` ${current}`}`
  process.env.NODE_OPTIONS = next
  return { propagated: true, nodeOptions: next }
}

/**
 * Read the undici resolution anchors the gate configured.
 * @returns {string[]} Anchor paths, empty when unset.
 */
function undiciAnchors() {
  const raw = process.env[EGRESS_UNDICI_ANCHORS_ENV] ?? ''
  return raw.split(process.platform === 'win32' ? ';' : ':').map(value => value.trim()).filter(value => value !== '')
}

/**
 * Install interception once per process and write the load-time heartbeat.
 * @returns {void}
 */
function install() {
  if (globalThis[INSTALLED] === true) return
  globalThis[INSTALLED] = true

  const recorder = createRecorder()
  const layers = installInterceptors(recorder, {
    undiciAnchors: undiciAnchors(),
    shimUrl: SHIM_URL,
    shimPath: fileURLToPath(SHIM_URL),
  })
  const propagation = propagateToChildren()

  recorder.heartbeat({
    shim: SHIM_URL,
    logPath: recorder.path,
    recorderEnabled: recorder.enabled,
    recorderProblem: recorder.reason,
    layers,
    node: process.version,
    execPath: process.execPath,
    cwd: process.cwd(),
    argv: process.argv.slice(0, 4),
    nodeOptions: propagation.nodeOptions,
    propagatedToChildren: propagation.propagated,
    envLogName: EGRESS_LOG_ENV,
  })

  if (!recorder.enabled) {
    process.stderr.write(`${SHIM_PREFIX} interception installed without evidence: ${recorder.reason}\n`)
  }
}

install()

// Interception recorder shared by the shim (inside the probed process) and the
// gate (which reads the JSONL file back).
//
// Every record carries the fields the gate relies on — `host`, `port`,
// `protocol`, `stack`, `at`, `pid` — plus `kind`, `layer`, and the shim's own
// `classification`. `at` and `pid` are filled here so no caller can forget them.
//
// The recorder is deliberately synchronous: probes are stopped with a signal,
// so a buffered or asynchronous write could be lost exactly when the evidence
// matters. A recorder that cannot write says so on stderr and disables itself
// visibly; the gate turns a missing heartbeat into `status=error`, never into a
// silent pass.

import { closeSync, openSync, writeSync } from 'node:fs'
import { threadId } from 'node:worker_threads'

/** Environment variable naming the JSONL evidence file. */
export const EGRESS_LOG_ENV = 'DSH_FORK_EGRESS_LOG'

/** Environment variable naming undici resolution anchors, `path.delimiter`-separated. */
export const EGRESS_UNDICI_ANCHORS_ENV = 'DSH_FORK_EGRESS_UNDICI_ANCHORS'

/** Record kind the gate requires before it trusts any other record. */
export const HEARTBEAT_KIND = 'heartbeat'

/** Diagnostic prefix for every shim message on stderr. */
export const SHIM_PREFIX = '[dsh-fork-egress]'

/** Frames of the caller stack kept per record. */
const STACK_FRAMES = 8

/** Longest stack line kept per record. */
const STACK_LINE_CHARS = 220

/**
 * Capture the caller's stack, dropping the shim's own frames.
 * @param {number} [extraSkip] Additional frames to drop above the shim.
 * @returns {string[]} Short, filtered stack lines, outermost call last.
 */
export function captureStack(extraSkip = 0) {
  const stack = new Error('egress-record').stack ?? ''
  return String(stack)
    .split('\n')
    .slice(1)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.includes('fork/lib/egress/') && !line.includes('fork/egress-shim.mjs'))
    .slice(extraSkip, extraSkip + STACK_FRAMES)
    .map(line => (line.length > STACK_LINE_CHARS ? `${line.slice(0, STACK_LINE_CHARS)}…` : line))
}

/**
 * Create the JSONL recorder for one process.
 * @param {{logPath?: string, now?: () => string, onDisabled?: (reason: string) => void}} [options]
 *   Evidence path (defaults to {@link EGRESS_LOG_ENV}), clock, and disable sink.
 * @returns {{enabled: boolean, reason: string|null, path: string|null, record: (record: object) => boolean,
 *   heartbeat: (fields?: object) => boolean}} Recorder handle.
 */
export function createRecorder(options = {}) {
  const now = options.now ?? (() => new Date().toISOString())
  const configured = options.logPath ?? process.env[EGRESS_LOG_ENV]
  const onDisabled = options.onDisabled ?? (reason => { process.stderr.write(`${SHIM_PREFIX} ${reason}\n`) })
  let reason = null
  if (typeof configured !== 'string' || configured === '') {
    reason = `${EGRESS_LOG_ENV} is not set: interception is installed but nothing is recorded, so this run proves nothing`
  }
  let fd = null
  if (reason === null) {
    try {
      fd = openSync(configured, 'a')
    } catch (error) {
      reason = `cannot open evidence file ${configured}: ${error.message}`
    }
  }
  if (reason !== null) onDisabled(reason)

  const emit = (fields) => {
    if (reason !== null || fd === null) return false
    const record = {
      at: now(),
      pid: process.pid,
      // Worker threads share the pid, so the thread id is what proves which
      // execution context an interception came from.
      threadId,
      kind: 'event',
      layer: 'shim',
      protocol: null,
      host: null,
      port: null,
      path: null,
      classification: 'local',
      stack: [],
      ...fields,
    }
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`)
      return true
    } catch (error) {
      reason = `write to ${configured} failed: ${error.message}`
      onDisabled(reason)
      try {
        closeSync(fd)
      } catch {
        // The descriptor is already unusable; the recorded reason is what matters.
      }
      fd = null
      return false
    }
  }

  return {
    get enabled() {
      return reason === null
    },
    get reason() {
      return reason
    },
    get path() {
      return typeof configured === 'string' ? configured : null
    },
    record: emit,
    heartbeat(fields = {}) {
      return emit({ kind: HEARTBEAT_KIND, ...fields })
    },
  }
}

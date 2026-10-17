// Gate execution for the upstream sync.
// Gate commands come from `core.gates[].command`; this module never hardcodes a
// gate path. It resolves the script each command runs so a missing gate stops the
// run before anything mutates, executes the gate non-interactively, and classifies
// the result by the shared exit-code contract: 0 pass, 1 fail, 2 error.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'

/** Render window of one gate's captured output. */
const OUTPUT_LIMIT = 6000

/** Longest a single gate may run before the run treats it as an error. */
const GATE_TIMEOUT_MS = 45 * 60 * 1000

/** Largest gate JSON report embedded in the sync report. */
const REPORT_LIMIT_BYTES = 512 * 1024

/**
 * Extract the script path a gate command executes.
 * @param {string} command Command string from the policy.
 * @returns {string|null} Repository-relative or absolute script path.
 */
export function gateScript(command) {
  const tokens = command.split(/\s+/).filter(token => token !== '')
  for (const token of tokens) {
    if (/\.(mjs|cjs|js|ts)$/.test(token)) return token
  }
  return null
}

/**
 * Check that every required gate command names a script that exists.
 * @param {string} root Repository root.
 * @param {object[]} gates Gate entries from the policy.
 * @returns {Array<{id: string, command: string, script: string|null, present: boolean}>} Resolved gate scripts.
 */
export function resolveGateScripts(root, gates) {
  return gates.map(gate => {
    const script = gateScript(gate.command)
    if (script === null) return { id: gate.id, command: gate.command, script: null, present: false }
    const absolute = isAbsolute(script) ? script : resolve(root, script)
    return { id: gate.id, command: gate.command, script, present: existsSync(absolute) }
  })
}

/**
 * Run every required gate and collect its verdict.
 * @param {object} input Gate run inputs.
 * @param {string} input.root Repository root.
 * @param {object[]} input.gates Gate entries from the policy.
 * @param {string} input.date Run date, used to find the reports gates write.
 * @param {(message: string) => void} [input.log] Progress sink.
 * @returns {object[]} One result per gate, in policy order.
 */
export function runGates({ root, gates, date, log = () => {} }) {
  const results = []
  for (const gate of gates) {
    const startedAt = Date.now()
    const before = reportFiles(root)
    log(`gate ${gate.id}: ${gate.command}`)
    const executed = spawnSync('/bin/sh', ['-c', gate.command], {
      cwd: root,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        LC_ALL: 'C',
        DSH_FORK_SYNC_DATE: date,
      },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: GATE_TIMEOUT_MS,
    })
    const exitCode = executed.status === null ? 124 : executed.status
    const collected = collectGateReport(root, gate.id, before, date)
    results.push({
      id: gate.id,
      command: gate.command,
      description: gate.description ?? '',
      required: gate.required === true,
      exitCode,
      verdict: verdictFor(exitCode),
      durationMs: Date.now() - startedAt,
      timedOut: executed.error?.code === 'ETIMEDOUT' || executed.signal === 'SIGTERM',
      stdoutTail: tail(executed.stdout ?? ''),
      stderrTail: tail(executed.stderr ?? ''),
      reportPath: collected?.path ?? null,
      report: collected?.report ?? null,
    })
    log(`gate ${gate.id}: ${results[results.length - 1].verdict} (exit ${exitCode}, ${results[results.length - 1].durationMs} ms)`)
  }
  return results
}

/**
 * Prove the policy's required-gate list can actually be satisfied. The hard
 * requirement is a universal over the gates ("merge only when every gate
 * reports pass"), which an empty or all-optional list satisfies vacuously, so
 * this runs before anything mutates.
 * @param {object[]} gates Gate entries from the policy.
 * @param {string[]} requiredGateIds Gate ids `fork/policy/core.json` requires.
 * @returns {{ok: boolean, problems: string[], required: object[]}} Validation result.
 */
export function validateRequiredGates(gates, requiredGateIds) {
  const problems = []
  if (!Array.isArray(requiredGateIds) || requiredGateIds.length === 0) {
    problems.push('core.json lists no requiredGateIds, so the gate list cannot be proven non-vacuous')
    return { ok: false, problems, required: [] }
  }
  const required = []
  for (const id of requiredGateIds) {
    const gate = gates.find(entry => entry.id === id)
    if (gate === undefined) {
      problems.push(`required gate ${id} is absent from core.gates`)
      continue
    }
    if (gate.required !== true) {
      problems.push(`required gate ${id} is present but not marked required: true`)
      continue
    }
    required.push(gate)
  }
  return { ok: problems.length === 0, problems, required }
}

/**
 * Map a gate exit code to the shared verdict vocabulary.
 * @param {number} exitCode Gate exit code.
 * @returns {'pass'|'fail'|'error'} Verdict; an unclassified code counts as an error.
 */
export function verdictFor(exitCode) {
  if (exitCode === 0) return 'pass'
  if (exitCode === 1) return 'fail'
  return 'error'
}

/**
 * Decide whether the run may continue to the protected branch. Residual references outside the
 * surfaces the strip owns never block here: the static gate adjudicates them against its
 * justified-residual policy, and this decision only requires that the strip removed everything
 * it owns.
 * @param {object[]} results Gate results.
 * @param {number} stripUnhandled Number of references the strip could not remove on its own surfaces.
 * @param {string[]} [requiredGateIds] Gate ids the policy requires; an empty list never merges.
 * @returns {{allowed: boolean, blocking: string[]}} Decision and its reasons.
 */
export function gateDecision(results, stripUnhandled, requiredGateIds = []) {
  const blocking = []
  for (const result of results) {
    if (result.required !== true) continue
    if (result.verdict !== 'pass') blocking.push(`gate ${result.id} reported ${result.verdict} (exit ${result.exitCode})`)
    if (result.report !== null && result.report !== undefined && result.report.status !== undefined && result.report.status !== 'pass') {
      blocking.push(`gate ${result.id} exited ${result.exitCode} but wrote a report with status ${result.report.status}`)
    }
  }
  const ids = Array.isArray(requiredGateIds) ? requiredGateIds : []
  if (ids.length === 0) {
    blocking.push('the policy lists no required gate, so no gate could have proven this sync')
  }
  for (const id of ids) {
    const result = results.find(entry => entry.id === id)
    if (result === undefined) blocking.push(`required gate ${id} produced no result`)
    else if (result.verdict !== 'pass') blocking.push(`required gate ${id} reported ${result.verdict} (exit ${result.exitCode})`)
  }
  if (!results.some(result => result.required === true && result.verdict === 'pass')) {
    blocking.push('no required gate reported pass')
  }
  if (stripUnhandled > 0) blocking.push(`the strip left ${stripUnhandled} reference(s) it could not remove`)
  return { allowed: blocking.length === 0, blocking }
}

/**
 * List the JSON files present in the report directory.
 * @param {string} root Repository root.
 * @returns {Map<string, number>} File name to modification time.
 */
function reportFiles(root) {
  const directory = join(root, 'fork/reports')
  const files = new Map()
  if (!existsSync(directory)) return files
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue
    const absolute = join(directory, name)
    files.set(name, statSync(absolute).mtimeMs)
  }
  return files
}

/**
 * Find the report a gate wrote during its run.
 * @param {string} root Repository root.
 * @param {string} gateId Gate identifier.
 * @param {Map<string, number>} before Report files present before the gate ran.
 * @param {string} date Run date.
 * @returns {{path: string, report: object}|null} Collected report.
 */
function collectGateReport(root, gateId, before, date) {
  const directory = join(root, 'fork/reports')
  if (!existsSync(directory)) return null
  const candidates = readdirSync(directory)
    .filter(name => name.endsWith('.json') && name.includes(gateId) && name !== `${date}-sync.json`)
    .filter(name => !before.has(name) || statSync(join(directory, name)).mtimeMs > before.get(name))
    .sort()
  for (const name of candidates) {
    const absolute = join(directory, name)
    if (statSync(absolute).size > REPORT_LIMIT_BYTES) {
      return { path: `fork/reports/${name}`, report: { note: 'report exceeded the size embedded in the sync report' } }
    }
    try {
      return { path: `fork/reports/${name}`, report: JSON.parse(readFileSync(absolute, 'utf8')) }
    } catch (error) {
      return { path: `fork/reports/${name}`, report: { note: `report is not valid JSON: ${error.message}` } }
    }
  }
  return null
}

/**
 * Keep the head and tail of a captured stream.
 * @param {string} text Captured output.
 * @returns {string} Truncated output.
 */
function tail(text) {
  const trimmed = text.trim()
  if (trimmed.length <= OUTPUT_LIMIT) return trimmed
  const half = Math.floor(OUTPUT_LIMIT / 2)
  return `${trimmed.slice(0, half)}\n... [${trimmed.length - OUTPUT_LIMIT} characters elided] ...\n${trimmed.slice(-half)}`
}

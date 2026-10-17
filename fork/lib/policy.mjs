// Shared policy loader for every fork/ gate and the upstream sync orchestrator.
// The policy is split by ownership so parallel work never edits one file:
//   fork/policy/core.json         stripped surface, merge policy, gate list (Lead-owned)
//   fork/policy/rules-static.json content rules and justified residuals (verify-static-owned)
//   fork/policy/rules-egress.json probe matrix and egress allowlist (verify-egress-owned)
// Every consumer reads the merged object and never re-implements the defaults.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root that contains this tooling; derived from the module location. */
export const FORK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Paths of the policy fragments, relative to the repository root. */
export const POLICY_PATHS = {
  core: 'fork/policy/core.json',
  staticRules: 'fork/policy/rules-static.json',
  egressRules: 'fork/policy/rules-egress.json',
}

/** Exit codes every gate shares so the orchestrator can classify a run. */
export const EXIT = {
  pass: 0,
  fail: 1,
  error: 2,
}

/**
 * Read and parse one JSON policy fragment.
 * @param {string} root Repository root.
 * @param {string} relativePath Fragment path relative to the root.
 * @param {{required?: boolean}} [options] Whether a missing fragment is fatal.
 * @returns {object} Parsed fragment, or an empty object when optional and absent.
 */
export function readPolicyFragment(root, relativePath, options = {}) {
  const absolute = join(root, relativePath)
  if (!existsSync(absolute)) {
    if (options.required === false) return {}
    throw new Error(`fork policy fragment is missing: ${relativePath}`)
  }
  try {
    return JSON.parse(readFileSync(absolute, 'utf8'))
  } catch (error) {
    throw new Error(`fork policy fragment is not valid JSON: ${relativePath}: ${error.message}`)
  }
}

/**
 * Load the merged fork policy and assert the fields every consumer relies on.
 * @param {string} [root] Repository root; defaults to the checkout containing this module.
 * @returns {{core: object, staticRules: object, egressRules: object, root: string}} Merged policy.
 */
export function loadPolicy(root = FORK_ROOT) {
  const core = readPolicyFragment(root, POLICY_PATHS.core)
  const staticRules = readPolicyFragment(root, POLICY_PATHS.staticRules, { required: false })
  const egressRules = readPolicyFragment(root, POLICY_PATHS.egressRules, { required: false })
  for (const key of [
    'strippedPackagePaths',
    'strippedPackageNames',
    'strippedDocumentationPaths',
    'gates',
    'mergePolicy',
    'reports',
    'fork',
  ]) {
    if (core[key] === undefined) throw new Error(`fork/policy/core.json must define ${key}`)
  }
  return { core, staticRules, egressRules, root }
}

/**
 * Build the report envelope every gate emits, so reports stay comparable across gates.
 * @param {object} fields Gate identity and repository coordinates.
 * @param {string} fields.gate Gate id, matching an entry in core.gates.
 * @param {string} fields.root Repository root.
 * @returns {object} Mutable report skeleton with an empty violations list.
 */
export function newReport({ gate, root }) {
  const startedAt = new Date().toISOString()
  return {
    schema: 'dsh-fork-gate-report/v1',
    gate,
    root,
    startedAt,
    finishedAt: null,
    status: 'error',
    checked: 0,
    violations: [],
    notes: [],
  }
}

/**
 * Record a policy violation on a report.
 * @param {object} report Report returned by newReport.
 * @param {object} violation Violation fields.
 * @param {string} violation.ruleId Stable rule identifier from the policy.
 * @param {string} violation.severity One of 'blocker', 'error', 'warning'.
 * @param {string} violation.path Repository-relative path, or a description for non-file evidence.
 * @param {string} [violation.line] One-based line number when the evidence is a file location.
 * @param {string} violation.detail What was found.
 * @param {string} violation.remedy What the fix is.
 * @returns {void}
 */
export function addViolation(report, violation) {
  report.violations.push({
    severity: 'error',
    ...violation,
  })
}

/**
 * Classify a finished report by violation severity and stamp its end time.
 * A 'warning' never blocks a merge; 'blocker' and 'error' always do.
 * @param {object} report Report returned by newReport.
 * @returns {object} The same report with status and finishedAt set.
 */
export function finalizeReport(report) {
  const blocking = report.violations.filter(v => v.severity !== 'warning')
  report.status = blocking.length === 0 ? 'pass' : 'fail'
  report.finishedAt = new Date().toISOString()
  return report
}

/**
 * Map a finished report to the shared process exit code.
 * @param {object} report Report returned by finalizeReport.
 * @returns {number} EXIT.pass for a clean report, otherwise EXIT.fail.
 */
export function exitCodeFor(report) {
  return report.status === 'pass' ? EXIT.pass : EXIT.fail
}

/**
 * Print a finished report as one summary line plus one line per violation.
 * @param {object} report Report returned by finalizeReport.
 * @returns {void}
 */
export function printReport(report) {
  const label = report.status === 'pass' ? 'PASS' : 'FAIL'
  console.log(
    `[${report.gate}] ${label} checked=${report.checked} violations=${report.violations.length}`,
  )
  for (const violation of report.violations) {
    const location = violation.line ? `${violation.path}:${violation.line}` : violation.path
    console.log(`  ${violation.severity.toUpperCase()} ${violation.ruleId} ${location} :: ${violation.detail}`)
    if (violation.remedy) console.log(`    remedy: ${violation.remedy}`)
  }
  for (const note of report.notes) console.log(`  note: ${note}`)
}

/**
 * Minimal argv reader shared by the gate entry points.
 * @param {string[]} argv Process arguments after the script name.
 * @returns {{flags: Set<string>, values: Map<string, string>, positionals: string[]}} Parsed arguments.
 */
export function parseArgv(argv) {
  const flags = new Set()
  const values = new Map()
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const [name, inline] = token.slice(2).split('=')
    const next = argv[index + 1]
    if (inline !== undefined) {
      values.set(name, inline)
    } else if (next !== undefined && !next.startsWith('--')) {
      values.set(name, next)
      index += 1
    } else {
      flags.add(name)
    }
  }
  return { flags, values, positionals }
}

// Static half of the fork's telemetry-strip proof.
//
// The daily upstream sync may not reach the protected branch unless this gate
// exits 0 for the exact merged commit. It reads fork/policy/core.json (the
// frozen stripped surface) and fork/policy/rules-static.json (this gate's own
// content rules, scopes, and justified residuals), then proves:
//
//   1. every path core.json declares stripped, and every file it declares
//      deleted, is absent or unreferenced in the working tree;
//   2. no stripped package name or pluggable identifier survives outside the
//      scopes that declare why it must;
//   3. no workspace manifest declares a forbidden analytics, OTLP, or
//      crash-reporting dependency, and every manifest was actually checked;
//   4. no profile, bundle, snapshot fixture, or generated catalog composes a
//      stripped plugin, with rows that only disable one reported as inert;
//   5. built output carries no telemetry endpoint or OTel SDK marker (absent
//      artifacts are reported as a note, never skipped silently);
//   6. content heuristics discover telemetry that is not yet on the denylist.
//
// Every suppression is a justifiedResiduals entry that the same run re-validates
// against the tree, so a residual cannot outlive the reason for it. The two bulk
// scans overlap their reads to a bounded concurrency and preserve job order, so
// two runs over one tree produce the same report.
//
// Usage: node fork/verify-static.mjs [--root <path>] [--json <path>] [--quiet]
//   --root scans another tree with this fork's policy, which is how a sync
//   branch or a pristine upstream checkout is checked without merging it.
// Exit codes: 0 pass, 1 violations, 2 internal error.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  EXIT,
  FORK_ROOT,
  POLICY_PATHS,
  exitCodeFor,
  finalizeReport,
  loadPolicy,
  newReport,
  parseArgv,
  printReport,
} from './lib/policy.mjs'
import { loadStaticRules } from './lib/static/rules.mjs'
import { runStaticChecks } from './lib/static/checks.mjs'

/** Gate id; must match the entry in fork/policy/core.json's gates list. */
const GATE = 'static'

/**
 * Write the finished report as JSON, creating the reports directory on demand.
 * @param {string} root Repository root the report describes.
 * @param {object} report Report returned by newReport.
 * @param {string | undefined} requested Repository-relative path from --json.
 * @returns {string} Repository-relative path that was written.
 */
function writeReport(root, report, requested) {
  const relative = requested ?? join('fork', 'reports', `${new Date().toISOString().slice(0, 10)}-${report.gate}.json`)
  const absolute = resolve(root, relative)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`)
  return relative
}

/**
 * Run the gate once.
 * @param {string[]} argv Process arguments after the script name.
 * @returns {Promise<number>} EXIT.pass, EXIT.fail, or EXIT.error.
 */
async function main(argv) {
  const { flags, values } = parseArgv(argv)
  const quiet = flags.has('quiet')
  const root = resolve(values.get('root') ?? FORK_ROOT)
  // The policy is the gate's own frozen fragment: `--root` names the tree to
  // scan, and only a tree that carries its own fork/policy supplies the policy.
  // Scanning a pristine upstream checkout still uses this fork's denylist.
  const policyRoot = existsSync(join(root, POLICY_PATHS.core)) ? root : FORK_ROOT
  const report = newReport({ gate: GATE, root })
  let reportPath
  try {
    const policy = loadPolicy(policyRoot)
    const rules = loadStaticRules(policyRoot)
    if (policyRoot !== root) {
      report.notes.push(`policy loaded from ${policyRoot}; only the scanned tree came from --root ${root}`)
    }
    await runStaticChecks({ root, report, core: policy.core, rules })
    finalizeReport(report)
    reportPath = writeReport(root, report, values.get('json'))
  } catch (error) {
    // An internal error means the gate proved nothing: never report it as a pass.
    report.status = 'error'
    report.notes.push(`internal error: ${error instanceof Error ? error.message : String(error)}`)
    report.finishedAt = new Date().toISOString()
    try {
      reportPath = writeReport(root, report, values.get('json'))
    } catch (writeError) {
      console.error(`[${GATE}] could not write report: ${writeError instanceof Error ? writeError.message : String(writeError)}`)
    }
    if (!quiet) printReport(report)
    console.error(`[${GATE}] internal error: ${error instanceof Error ? error.message : String(error)}`)
    return EXIT.error
  }
  if (!quiet) {
    printReport(report)
    if (reportPath !== undefined) console.log(`[${GATE}] report written to ${reportPath}`)
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))

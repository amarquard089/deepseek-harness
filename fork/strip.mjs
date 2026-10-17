#!/usr/bin/env node
// Standalone re-application of the fork's telemetry strip.
//
// `node fork/sync-upstream.mjs` runs this engine on the sync branch; this CLI
// exposes the same engine so a reviewer can see exactly what the strip would do
// and re-run it after a manual fix.
//
// Usage:
//   node fork/strip.mjs [--dry-run] [--baseline <rev>] [--json]
//
// Exit codes: 0 every policy reference is gone (or was already gone), 1 the
// strip could not remove a reference, 2 the policy or the tree could not be read.

import { EXIT, loadPolicy, parseArgv } from './lib/policy.mjs'
import { applyStrip, printStripOutcome } from './lib/sync/strip-engine.mjs'
import { revParse } from './lib/sync/git.mjs'

/** Flags this CLI accepts. */
const KNOWN_FLAGS = new Set(['dry-run', 'baseline', 'json', 'help'])

/**
 * Print the CLI usage text.
 * @returns {void}
 */
function usage() {
  console.log(
    [
      'Usage: node fork/strip.mjs [options]',
      '',
      '  --dry-run          Report the changes without writing them.',
      '  --baseline <rev>   Revision whose references are already accepted, so only',
      '                     references that revision does not carry block the strip.',
      '  --json             Print the machine-readable outcome instead of change lines.',
      '  --help             Print this text.',
      '',
      'Exit codes: 0 clean or already clean, 1 unremoved reference, 2 policy or tree error.',
    ].join('\n'),
  )
}

/**
 * Run the standalone strip.
 * @returns {number} Process exit code.
 */
function main() {
  const parsed = parseArgv(process.argv.slice(2))
  const unknown = [...parsed.flags, ...parsed.values.keys()].filter(name => !KNOWN_FLAGS.has(name))
  if (parsed.flags.has('help')) {
    usage()
    return EXIT.pass
  }
  if (unknown.length > 0) {
    console.error(`unknown option(s): ${unknown.map(name => `--${name}`).join(', ')}`)
    usage()
    return EXIT.error
  }
  const dryRun = parsed.flags.has('dry-run')
  const baselineRef = parsed.values.get('baseline') ?? null

  let policy
  try {
    policy = loadPolicy()
  } catch (error) {
    console.error(`[strip] ${error.message}`)
    return EXIT.error
  }
  const root = policy.root
  if (revParse(root, 'HEAD') === null) {
    console.error(`[strip] ${root} is not a git repository with a resolvable HEAD`)
    return EXIT.error
  }
  if (baselineRef !== null && revParse(root, baselineRef) === null) {
    console.error(`[strip] baseline ${baselineRef} does not resolve`)
    return EXIT.error
  }

  let outcome
  try {
    outcome = applyStrip({ root, core: policy.core, dryRun, baselineRef })
  } catch (error) {
    console.error(`[strip] ${error.stack ?? error.message}`)
    return EXIT.error
  }
  if (parsed.flags.has('json')) {
    console.log(JSON.stringify({ schema: 'dsh-fork-strip-report/v1', root, baselineRef, ...outcome }, null, 2))
  } else {
    printStripOutcome(outcome)
  }
  if (outcome.unhandled.length > 0 || outcome.newResiduals.length > 0) {
    console.error(
      `[strip] FAIL: ${outcome.unhandled.length} reference(s) the strip could not remove, ` +
        `${outcome.newResiduals.length} new reference(s) outside its surfaces`,
    )
    return EXIT.fail
  }
  return EXIT.pass
}

process.exitCode = main()

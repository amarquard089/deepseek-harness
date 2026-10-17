#!/usr/bin/env node
// Orchestrator safety regression suite for fork/sync-upstream.mjs (task-4 item 5).
//
// The property under test: no failing gate, no exit-2 gate, and no vacuous gate
// list may reach a merge into the protected branch. The load-bearing control is
// O1: with a green required-gate list the run really does merge and really does
// move the protected branch, so the blocking cases are not passing for want of a
// working merge path.
//
// Every case runs in a throwaway clone under the OS temp dir. The clone's
// `origin` remote is removed before anything runs, so no push can reach this
// repository, and `--no-push` is passed as well. The clone receives a copy of the
// on-disk `fork/` so the suite measures the working-tree revision, not the last
// committed one.
//
// Usage: node fork/tests/orchestrator-safety-checks.mjs [--keep]
// Exit 0 when every check holds.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Repository root that contains fork/; this file lives at fork/tests/. */
const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const CLONE = join(tmpdir(), 'dsh-fork-orchestrator-checks')

/** Collected check outcomes. */
const results = []

/**
 * Run one command synchronously.
 * @param {string} command Executable.
 * @param {string[]} args Arguments.
 * @param {object} [options] spawnSync options.
 * @returns {{code: number, stdout: string, stderr: string}} Outcome.
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Run git inside the clone.
 * @param {string[]} args Git arguments.
 * @returns {{code: number, stdout: string, stderr: string}} Outcome.
 */
function gitIn(args) {
  return run('git', args, { cwd: CLONE })
}

/**
 * Record one check.
 * @param {string} id Stable check id.
 * @param {boolean} ok Whether the expectation held.
 * @param {string} evidence One-line observed evidence.
 * @returns {void}
 */
function check(id, ok, evidence) {
  results.push({ id, ok, evidence })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${id} :: ${evidence}`)
}

/**
 * Build the throwaway clone: on-disk fork/ committed, origin removed, a synthetic
 * upstream one commit ahead, and a fake gate whose exit code is configurable.
 * @returns {{base: string}} The clone's protected tip before any case runs.
 */
function setup() {
  rmSync(CLONE, { recursive: true, force: true })
  const cloned = run('git', ['clone', '--local', '--no-hardlinks', '-q', REPO, CLONE])
  if (cloned.code !== 0) throw new Error(`git clone failed: ${cloned.stderr}`)
  if (gitIn(['checkout', '-q', 'master']).code !== 0) throw new Error('the clone has no master branch')
  // Never let anything in this suite reach the real repository.
  gitIn(['remote', 'remove', 'origin'])

  rmSync(join(CLONE, 'fork'), { recursive: true, force: true })
  cpSync(join(REPO, 'fork'), join(CLONE, 'fork'), { recursive: true })
  rmSync(join(CLONE, 'fork', 'reports'), { recursive: true, force: true })
  rmSync(join(CLONE, 'fork', 'state'), { recursive: true, force: true })
  writeFileSync(join(CLONE, 'fork', 'fake-gate.mjs'), 'process.exit(Number(process.env.FAKE_GATE_EXIT ?? "0"))\n')
  gitIn(['add', '-A'])
  gitIn(['commit', '-qm', 'verifier scratch: on-disk fork + fake gate'])
  const base = gitIn(['rev-parse', 'master']).stdout.trim()

  // The synthetic upstream branches from master~1 rather than master, so the
  // fork-added set between the merge base and master is non-empty — which is what
  // a real sync always has, and what the fail-closed forkLocalPreserved check now
  // requires before it will report the invariant as proven.
  gitIn(['checkout', '-q', '-b', 'fake-upstream', 'master~1'])
  writeFileSync(join(CLONE, 'UPSTREAM-NEW.txt'), 'upstream change\n')
  gitIn(['add', '-A'])
  gitIn(['commit', '-qm', 'fake upstream commit'])
  gitIn(['checkout', '-q', 'master'])
  gitIn(['remote', 'add', 'upstream', CLONE])
  gitIn(['config', '--replace-all', 'remote.upstream.fetch', '+refs/heads/fake-upstream:refs/remotes/upstream/master'])
  gitIn(['fetch', '-q', 'upstream'])
  return { base }
}

/**
 * Write a gate list into the clone's policy.
 * @param {'REQUIRED'|'EMPTY'|'OPTIONAL'|'MISSING'} shape Gate list shape.
 * @returns {void}
 */
function setGates(shape) {
  const path = join(CLONE, 'fork', 'policy', 'core.json')
  const policy = JSON.parse(readFileSync(path, 'utf8'))
  const gate = (id, required) => ({
    id,
    command: shape === 'MISSING' ? `node fork/absent-${id}.mjs` : 'node fork/fake-gate.mjs',
    required,
    description: 'verifier fake gate',
  })
  if (shape === 'EMPTY') policy.gates = []
  else if (shape === 'OPTIONAL') policy.gates = [gate('static', false), gate('egress', false)]
  else policy.gates = [gate('static', true), gate('egress', true)]
  writeFileSync(path, `${JSON.stringify(policy, null, 2)}\n`)
}

/**
 * Run one case against a freshly reset clone.
 * @param {object} input Case input.
 * @param {string} input.date Run date, also the report name.
 * @param {string} input.shape Gate list shape.
 * @param {string} input.gateExit Exit code the fake gates return.
 * @param {string} input.base Protected tip to reset to.
 * @returns {{code: number, moved: boolean, action: string, verdicts: string[]}} Outcome.
 */
function runCase({ date, shape, gateExit, base }) {
  gitIn(['checkout', '-q', 'master'])
  gitIn(['reset', '-q', '--hard', base])
  gitIn(['clean', '-qfd'])
  setGates(shape)
  gitIn(['add', '-A'])
  gitIn(['commit', '-qm', `verifier scratch: ${shape}`])
  const before = gitIn(['rev-parse', 'master']).stdout.trim()
  const executed = run('node', ['fork/sync-upstream.mjs', '--date', date, '--skip-build', '--no-push'], {
    cwd: CLONE,
    env: { ...process.env, FAKE_GATE_EXIT: gateExit },
  })
  const moved = gitIn(['rev-parse', 'master']).stdout.trim() !== before
  let action = 'no report'
  let verdicts = []
  const reportPath = join(CLONE, 'fork', 'reports', `${date}-sync.json`)
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    action = report.finalAction
    verdicts = (report.gates ?? []).map(gate => `${gate.id}=${gate.verdict}/required=${gate.required}`)
  }
  return { code: executed.code, moved, action, verdicts }
}

/** Orchestrator checks. */
function orchestratorChecks(base) {
  console.log('\n== sync-upstream.mjs: gate contract ==')
  const green = runCase({ date: '2026-12-01', shape: 'REQUIRED', gateExit: '0', base })
  check('O1-green-control-merges',
    green.code === 0 && green.moved,
    `a green required-gate list reaches the protected branch: exit ${green.code}, protected branch moved=${green.moved}, action=${green.action}, gates=[${green.verdicts.join(' ')}]`)

  const failed = runCase({ date: '2026-12-02', shape: 'REQUIRED', gateExit: '1', base })
  check('O2-exit1-does-not-merge',
    failed.code === 1 && !failed.moved && failed.action === 'gate-failed',
    `a gate exiting 1 blocks: exit ${failed.code}, moved=${failed.moved}, action=${failed.action}`)

  const errored = runCase({ date: '2026-12-03', shape: 'REQUIRED', gateExit: '2', base })
  check('O3-exit2-is-a-failure',
    errored.code !== 0 && !errored.moved && errored.verdicts.every(verdict => verdict.includes('=error/')),
    `a gate exiting 2 is classified error and blocks: exit ${errored.code}, moved=${errored.moved}, action=${errored.action}, gates=[${errored.verdicts.join(' ')}]`)

  const missing = runCase({ date: '2026-12-04', shape: 'MISSING', gateExit: '0', base })
  check('O4-missing-gate-script-blocks',
    missing.code === 2 && !missing.moved,
    `a required gate whose script is absent stops the run before it mutates: exit ${missing.code}, moved=${missing.moved}, action=${missing.action}`)

  const emptyGates = runCase({ date: '2026-12-05', shape: 'EMPTY', gateExit: '0', base })
  check('O5-empty-gate-list-does-not-merge',
    emptyGates.code === 2 && !emptyGates.moved,
    `an empty gate list cannot merge (regression for F5): exit ${emptyGates.code}, moved=${emptyGates.moved}, action=${emptyGates.action}`)

  const optionalGates = runCase({ date: '2026-12-06', shape: 'OPTIONAL', gateExit: '0', base })
  check('O6-all-optional-gate-list-does-not-merge',
    optionalGates.code === 2 && !optionalGates.moved,
    `an all-optional gate list cannot merge (regression for F5): exit ${optionalGates.code}, moved=${optionalGates.moved}, action=${optionalGates.action}`)

  console.log('\n== sync-upstream.mjs: history rewriting ==')
  const forceHits = run('grep', ['-rnE', String.raw`--force|force-with-lease`, 'sync-upstream.mjs', 'strip.mjs', 'lib/'], {
    cwd: join(CLONE, 'fork'),
  })
  const forceLines = forceHits.stdout.split('\n').filter(line => line !== '' && !/recursive: true/.test(line))
  check('O7-no-force-anywhere',
    forceLines.length === 0,
    `no --force or --force-with-lease in sync-upstream.mjs, strip.mjs or lib/${forceLines.length === 0 ? '' : `; found: ${forceLines.join(' | ')}`}`)
}

/**
 * Check the fork-local-preserved invariant against the clone's own git state.
 * @param {object} modules Imported fork modules under test.
 * @returns {Promise<void>} Resolves after the checks are recorded.
 */
async function invariantChecks(modules) {
  console.log('\n== forkLocalPreserved ==')
  const { forkLocalPreserved, addedPathsChecked, mergeBase } = modules
  gitIn(['checkout', '-q', '-b', 'fork-local-probe', 'master'])
  writeFileSync(join(CLONE, 'FORK-ADDED.txt'), 'fork-local\n')
  gitIn(['add', '-A'])
  gitIn(['commit', '-qm', 'verifier scratch: fork-local addition'])
  // forkLocalPreserved now requires the checked lister, which keeps a git failure
  // apart from a genuinely empty fork-added set.
  const call = (base) => forkLocalPreserved({ root: CLONE, listAdded: addedPathsChecked, base, protectedBranch: 'fork-local-probe' })

  const base = mergeBase(CLONE, 'fork-local-probe', 'master')
  const present = call(base)
  check('O8-invariant-detects-a-present-path',
    present.ok === true && present.checked === 1,
    `with the fork-added path present the invariant is proven: checked=${present.checked} ok=${present.ok}`)

  rmSync(join(CLONE, 'FORK-ADDED.txt'), { force: true })
  const lost = call(base)
  check('O9-invariant-detects-a-lost-path',
    lost.ok === false && lost.missing.length === 1,
    `deleting the fork-added path fails the invariant: checked=${lost.checked} ok=${lost.ok} missing=${JSON.stringify(lost.missing)}`)
  gitIn(['checkout', '-q', '--', 'FORK-ADDED.txt'])

  const nullBase = call(null)
  check('O10-unprovable-invariant-fails-closed',
    nullBase.ok === false && typeof nullBase.reason === 'string',
    `a null merge base now fails closed instead of reporting a vacuous pass (regression for F6): ok=${nullBase.ok} reason=${JSON.stringify(nullBase.reason)}`)

  const emptySet = call(gitIn(['rev-parse', 'fork-local-probe']).stdout.trim())
  check('O11-empty-fork-added-set-fails-closed',
    emptySet.ok === false && typeof emptySet.reason === 'string',
    `an empty fork-added set now fails closed instead of reporting a vacuous pass (regression for F6): ok=${emptySet.ok} reason=${JSON.stringify(emptySet.reason)}`)
}

try {
  const { base } = setup()
  orchestratorChecks(base)
  const modules = await import(pathToFileURL(join(CLONE, 'fork', 'lib', 'sync', 'conflicts.mjs')).href)
  const gitModules = await import(pathToFileURL(join(CLONE, 'fork', 'lib', 'sync', 'git.mjs')).href)
  await invariantChecks({ forkLocalPreserved: modules.forkLocalPreserved, addedPathsChecked: gitModules.addedPathsChecked, mergeBase: gitModules.mergeBase })
} finally {
  if (process.argv.includes('--keep')) console.log(`\n--keep: left ${CLONE}`)
  else rmSync(CLONE, { recursive: true, force: true })
}

const failed = results.filter(result => !result.ok)
console.log(`\n== summary ==`)
console.log(`  orchestrator checks: ${results.length - failed.length}/${results.length} hold`)
if (failed.length > 0) {
  console.log('\n  FAILURES:')
  for (const result of failed) console.log(`   - ${result.id}: ${result.evidence}`)
}
process.exitCode = failed.length === 0 ? 0 : 1

#!/usr/bin/env node
// Adversarial verification suite for the fork's telemetry gates (task-4).
//
// The question this suite answers is not "do the gates pass" but "could a gate
// report pass while telemetry is actually present". Every check therefore
// constructs an input that SHOULD be caught and asserts on the gate's own
// report, never on the gate's source code.
//
// Checks are classified:
//   control   a property the gates must hold; a failure is a gate defect
//   hole      a confirmed way for a gate to pass while telemetry is present;
//             the check asserts the hole EXISTS so a fix flips it to `control`
//
// Provenance: S1-S7, S9 and E1-E6 were controls from the start. S8, S10, S11 and
// S12 were `hole` checks for findings F2, F1, F3 and F4, and were reclassified to
// `control` when gate-static closed all four in b45c997fc8 ("close four
// static-gate false negatives"); their assertions now require the gate to catch
// the input rather than to miss it. The findings themselves are recorded in
// fork/reports/verification.md.
//
// Usage: node fork/tests/adversarial-gate-checks.mjs [--keep] [--only <id>]
// Exit 0 when every control holds and every documented hole is still present.
//
// It never writes inside the real working tree: all mutation happens in a
// detached scratch worktree and a symlink scratch root under the OS temp dir,
// both removed on exit. It does not create branches and does not touch master.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root that contains fork/; this file lives at fork/tests/. */
const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..')

const WORKTREE = join(tmpdir(), 'dsh-fork-adversarial-wt')
const SYMROOT = join(tmpdir(), 'dsh-fork-adversarial-sym')
const REPORT_DIR = join(tmpdir(), 'dsh-fork-adversarial-reports')

/** Results, in execution order. */
const results = []
/** Report of the most recent real-tree egress run, for the boot-state check. */
let realEgressReport = null
/** ids requested by --only. */
const only = []
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--only') only.push(argv[index + 1])
}
const keep = argv.includes('--keep')

/**
 * Run one command synchronously and return its exit code plus streams.
 * @param {string} command Executable.
 * @param {string[]} args Arguments.
 * @param {object} [options] spawnSync options.
 * @returns {{code: number, stdout: string, stderr: string}} Outcome.
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: REPO, maxBuffer: 64 * 1024 * 1024, ...options })
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Run the static gate against one root and return its report.
 * @param {string} root Tree to scan.
 * @param {string} tag Unique report tag.
 * @returns {{code: number, report: object}} Exit code and parsed report.
 */
function runStatic(root, tag) {
  const json = join(REPORT_DIR, `static-${tag}.json`)
  const result = run('node', ['fork/verify-static.mjs', '--root', root, '--quiet', '--json', json])
  return { code: result.code, report: JSON.parse(readFileSync(json, 'utf8')) }
}

/**
 * Run the egress gate against one root and return its report.
 * @param {string} root Tree to probe.
 * @param {string} tag Unique report tag.
 * @param {string[]} [extraArgs] Additional argv entries.
 * @param {object} [env] Extra environment.
 * @returns {{code: number, report: object|null, stderr: string}} Outcome.
 */
function runEgress(root, tag, extraArgs = [], env = {}) {
  const json = join(REPORT_DIR, `egress-${tag}.json`)
  rmSync(json, { force: true })
  const result = run('node', ['fork/verify-egress.mjs', '--root', root, '--quiet', '--json', json, ...extraArgs], {
    env: { ...process.env, ...env },
  })
  return {
    code: result.code,
    report: existsSync(json) ? JSON.parse(readFileSync(json, 'utf8')) : null,
    stderr: result.stderr,
  }
}

/** Blocking violations of a report (warnings never block a merge). */
function blockers(report) {
  return report.violations.filter(violation => violation.severity !== 'warning')
}

/**
 * Findings of one rule id in a report.
 * @param {object} report Gate report.
 * @param {string} ruleId Rule to filter on.
 * @returns {object[]} Matching violations.
 */
function ofRule(report, ruleId) {
  return report.violations.filter(violation => violation.ruleId === ruleId)
}

/**
 * Record one check outcome.
 * @param {string} kind 'control' or 'hole'.
 * @param {string} id Stable check id.
 * @param {boolean} ok Whether the expectation held.
 * @param {string} evidence One-line observed evidence.
 * @param {string} [detail] Extra detail printed on failure.
 * @returns {void}
 */
function check(kind, id, ok, evidence, detail = '') {
  results.push({ kind, id, ok, evidence, detail })
  const label = kind === 'hole' ? (ok ? 'HOLE CONFIRMED' : 'HOLE CLOSED   ') : ok ? 'ok            ' : 'FAIL          '
  console.log(`  ${label} ${id} :: ${evidence}`)
  if (!ok && detail !== '') console.log(`       ${detail}`)
}

/** Whether a check should run given --only. */
function wanted(id) {
  return only.length === 0 || only.includes(id)
}

/**
 * Build the detached scratch worktree and install a private fork/ policy copy.
 * The worktree has no fork/ of its own, so a copy makes the gate load policy
 * from the scratch root and leaves the real policy untouched.
 * @returns {string} Scratch root path.
 */
function makeWorktree() {
  rmSync(WORKTREE, { recursive: true, force: true })
  run('git', ['worktree', 'prune'])
  const added = run('git', ['worktree', 'add', '--detach', WORKTREE, 'HEAD'])
  if (added.code !== 0) throw new Error(`git worktree add failed: ${added.stderr}`)
  cpSync(join(REPO, 'fork'), join(WORKTREE, 'fork'), { recursive: true })
  rmSync(join(WORKTREE, 'fork', 'reports'), { recursive: true, force: true })
  rmSync(join(WORKTREE, 'fork', 'state'), { recursive: true, force: true })
  return WORKTREE
}

/**
 * Build a scratch root whose every entry symlinks to the real checkout except
 * fork/, which is a real copy. Probes boot for real (module resolution follows
 * the symlinks) while the shim and policy stay under this suite's control.
 * @returns {string} Scratch root path.
 */
function makeSymlinkRoot() {
  rmSync(SYMROOT, { recursive: true, force: true })
  mkdirSync(SYMROOT, { recursive: true })
  const listed = run('ls', ['-A', REPO])
  for (const entry of listed.stdout.split('\n').map(value => value.trim()).filter(value => value !== '')) {
    if (entry === 'fork') continue
    symlinkSync(join(REPO, entry), join(SYMROOT, entry))
  }
  cpSync(join(REPO, 'fork'), join(SYMROOT, 'fork'), { recursive: true })
  rmSync(join(SYMROOT, 'fork', 'reports'), { recursive: true, force: true })
  rmSync(join(SYMROOT, 'fork', 'state'), { recursive: true, force: true })
  return SYMROOT
}

/**
 * Overwrite one tracked file in the scratch worktree, returning a restore hook.
 * @param {string} relative Repository-relative path.
 * @param {string} content Replacement content.
 * @returns {() => void} Restore function.
 */
function replaceFile(relative, content) {
  const target = join(WORKTREE, relative)
  const original = readFileSync(target, 'utf8')
  writeFileSync(target, content)
  return () => writeFileSync(target, original)
}

/**
 * Delete the three dangling tsconfig references so the scratch tree starts
 * from a green static baseline. This is the same cleanup gate-static's own
 * positive control performs, and it is what makes a "green tree that still
 * ships telemetry" the honest precondition for the vacuous-pass checks.
 * @returns {() => void} Restore function.
 */
function cleanDeadReferences() {
  const restores = []
  const strip = (relative, needles) => {
    const target = join(WORKTREE, relative)
    const original = readFileSync(target, 'utf8')
    restores.push(() => writeFileSync(target, original))
    writeFileSync(target, original.split('\n').filter(line => !needles.some(needle => line.includes(needle))).join('\n'))
  }
  strip('tsconfig.host.json', ['session-log-upload.e2e.ts', 'feedback-release.e2e.ts'])
  strip('apps/web/tsconfig.json', ['feedback-release.e2e.ts'])
  return () => { for (const restore of restores) restore() }
}

/** Static-gate checks. */
function staticChecks() {
  console.log('\n== static gate: item 1 (re-introduction detection) ==')
  makeWorktree()
  // S1/S2 drive the rule with a deliberately planted reference rather than with
  // whatever residue the tree happens to carry, so they hold whether or not the
  // dangling tsconfig entries have been cleaned up yet.
  const plantPath = 'packages/core/agent/src/adversarial-reference.ts'
  const plantReference = (reference) => {
    mkdirSync(join(WORKTREE, 'packages/core/agent/src'), { recursive: true })
    writeFileSync(join(WORKTREE, plantPath), `// adversarial: ${reference}\nexport const planted = 1\n`)
  }
  const unplant = () => rmSync(join(WORKTREE, plantPath), { force: true })

  if (wanted('S1-stripped-file-rule-source')) {
    const policyPath = join(WORKTREE, 'fork', 'policy', 'core.json')
    const original = readFileSync(policyPath, 'utf8')
    plantReference('apps/web/tests/feedback-release.e2e.ts')
    const live = runStatic(WORKTREE, 'stripped-file-rule-live')
    const liveFindings = ofRule(live.report, 'static.stripped-file-reference')
      .filter(violation => violation.path === plantPath)
    const policy = JSON.parse(original)
    policy.strippedFilePaths = []
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`)
    const emptied = runStatic(WORKTREE, 'stripped-file-paths-empty')
    writeFileSync(policyPath, original)
    unplant()
    const emptiedFindings = ofRule(emptied.report, 'static.stripped-file-reference')
      .filter(violation => violation.path === plantPath)
    check('control', 'S1-stripped-file-rule-source',
      liveFindings.length === 1 && liveFindings[0].severity === 'blocker' && emptiedFindings.length === 0,
      `a planted reference to a stripped file is ${liveFindings[0]?.severity ?? 'not'} reported (${liveFindings.length} finding); emptying core.strippedFilePaths removes it (${emptiedFindings.length}), so the rule is policy-driven, not hardcoded`)
  }

  if (wanted('S2-no-over-firing-on-upstream-stale')) {
    const policyPath = join(WORKTREE, 'fork', 'policy', 'core.json')
    const original = readFileSync(policyPath, 'utf8')
    plantReference('apps/web/tests/window-controls.e2e.ts')
    const unlisted = runStatic(WORKTREE, 'upstream-stale-unlisted')
    const policy = JSON.parse(original)
    policy.strippedFilePaths = [...policy.strippedFilePaths, 'apps/web/tests/window-controls.e2e.ts']
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`)
    const listed = runStatic(WORKTREE, 'upstream-stale-listed')
    writeFileSync(policyPath, original)
    unplant()
    const mine = (outcome) => ofRule(outcome.report, 'static.stripped-file-reference').filter(violation => violation.path === plantPath)
    check('control', 'S2-no-over-firing-on-upstream-stale',
      mine(unlisted).length === 0 && mine(listed).length === 1,
      `upstream's own stale entry produces ${mine(unlisted).length} findings while unlisted and ${mine(listed).length} once added to core.strippedFilePaths, so its exclusion is a policy decision and the rule can see it`)
  }

  if (wanted('S3-restored-package-file')) {
    mkdirSync(join(WORKTREE, 'packages/telemetry/otel/src'), { recursive: true })
    const restored = run('git', ['show', 'upstream/master:packages/telemetry/otel/src/index.ts'], { cwd: REPO })
    writeFileSync(join(WORKTREE, 'packages/telemetry/otel/src/index.ts'), restored.stdout)
    const outcome = runStatic(WORKTREE, 'restored-package')
    const pathPresent = ofRule(outcome.report, 'static.stripped-path-present')
    const identifier = ofRule(outcome.report, 'static.stripped-identifier')
    check('control', 'S3-restored-package-file',
      outcome.code === 1 && pathPresent.length > 0 && identifier.length > 0,
      `restoring upstream packages/telemetry/otel/src/index.ts gives exit ${outcome.code}, ${pathPresent.length} stripped-path-present and ${identifier.length} stripped-identifier findings`)
    // Remove the whole stripped package tree, not just the leaf: the parent
    // directory is itself a stripped path and would block later checks.
    rmSync(join(WORKTREE, 'packages/telemetry'), { recursive: true, force: true })
  }

  if (wanted('S4-forbidden-dependency')) {
    const manifestPath = 'apps/cli/package.json'
    const manifest = JSON.parse(readFileSync(join(WORKTREE, manifestPath), 'utf8'))
    manifest.dependencies['@opentelemetry/api'] = '^1.9.0'
    manifest.devDependencies['@deepseek-ai/dsh-session-telemetry-otel'] = 'workspace:*'
    const restore = replaceFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const outcome = runStatic(WORKTREE, 'forbidden-dependency')
    restore()
    const dependency = ofRule(outcome.report, 'static.forbidden-dependency')
    const nameReference = ofRule(outcome.report, 'static.stripped-name-reference')
    check('control', 'S4-forbidden-dependency',
      outcome.code === 1 && dependency.length > 0 && nameReference.length > 0,
      `a manifest entry gives exit ${outcome.code}, ${dependency.length} forbidden-dependency and ${nameReference.length} stripped-name-reference findings`)
  }

  if (wanted('S5-unparseable-manifest-blocks')) {
    const restore = replaceFile('apps/cli/package.json', '{ "name": "broken", // jsonc comment\n "dependencies": { "@opentelemetry/api": "^1" } }\n')
    const outcome = runStatic(WORKTREE, 'broken-manifest')
    restore()
    const jsonFindings = ofRule(outcome.report, 'static.forbidden-dependency')
      .filter(violation => /not valid JSON/.test(violation.detail))
    check('control', 'S5-unparseable-manifest-blocks',
      outcome.code === 1 && jsonFindings.length > 0,
      `an unparseable manifest is a BLOCKER (${jsonFindings.length} finding), not a silent skip, so this gate does not share the JSON.parse silent-skip bug`)
  }

  console.log('\n== static gate: item 4 (justified-residual integrity) ==')
  const rulesPath = join(WORKTREE, 'fork', 'policy', 'rules-static.json')
  const rulesOriginal = readFileSync(rulesPath, 'utf8')
  const mutateRules = (mutator) => {
    const rules = JSON.parse(rulesOriginal)
    mutator(rules)
    writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`)
    const outcome = runStatic(WORKTREE, `rules-${Math.random().toString(36).slice(2, 8)}`)
    writeFileSync(rulesPath, rulesOriginal)
    return outcome
  }

  if (wanted('S6-residual-is-required')) {
    const outcome = mutateRules((rules) => {
      rules.justifiedResiduals = rules.justifiedResiduals.filter(entry => entry.id !== 'known-event-type-persistence-compat')
    })
    const unsuppressed = ofRule(outcome.report, 'static.stripped-identifier')
      .filter(violation => violation.path === 'packages/core/session/src/known-event-types.ts')
    check('control', 'S6-residual-is-required',
      outcome.code === 1 && unsuppressed.length > 0,
      `removing the known-event-types residual makes its finding a blocker again (exit ${outcome.code}, ${unsuppressed.length} finding), so the residual is load-bearing`)
  }

  if (wanted('S7-nonmatching-residual-is-flagged')) {
    const missing = mutateRules((rules) => {
      rules.justifiedResiduals[0].path = 'packages/core/session/src/does-not-exist.ts'
    })
    const staleMissing = ofRule(missing.report, 'static.stale-residual')
    const wrongCount = mutateRules((rules) => { rules.justifiedResiduals[0].count = 2 })
    const staleCount = ofRule(wrongCount.report, 'static.stale-residual')
    check('control', 'S7-nonmatching-residual-is-flagged',
      staleMissing.length > 0 && staleCount.length > 0,
      `a residual at a nonexistent path and one with a drifted count each raise static.stale-residual (${staleMissing.length} and ${staleCount.length} findings)`)
  }

  if (wanted('S8-residual-scope-is-per-file')) {
    const knownEventTypes = 'packages/core/session/src/known-event-types.ts'
    const original = readFileSync(join(WORKTREE, knownEventTypes), 'utf8')
    writeFileSync(join(WORKTREE, knownEventTypes), `${original}\nexport const reintroducedOtelService = "otel"\n`)
    const swallowed = runStatic(WORKTREE, 'residual-swallows-other-token')
    const withResidual = ofRule(swallowed.report, 'static.stripped-identifier')
      .filter(violation => violation.path === knownEventTypes)
    // Control: remove only the residual, keep the re-introduced identifier.
    const rules = JSON.parse(rulesOriginal)
    rules.justifiedResiduals = rules.justifiedResiduals.filter(entry => entry.id !== 'known-event-type-persistence-compat')
    writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`)
    const surfaced = runStatic(WORKTREE, 'residual-swallows-other-token-control')
    writeFileSync(rulesPath, rulesOriginal)
    writeFileSync(join(WORKTREE, knownEventTypes), original)
    const withoutResidual = ofRule(surfaced.report, 'static.stripped-identifier')
      .filter(violation => violation.path === knownEventTypes)
    // Fixed in b45c997fc8: suppression is now span-scoped, so the residual keeps
    // hiding its own token and nothing else in the file.
    const otelReported = withResidual.filter(violation => /"otel"/.test(violation.detail))
    const ownTokenReported = withResidual.filter(violation => /session-log-deepseek/.test(violation.detail))
    check('control', 'S8-residual-scope-is-per-file',
      otelReported.length === 1 && ownTokenReported.length === 0,
      `a re-introduced "otel" identifier in the residual's own file is reported (${otelReported.length} finding of ${withResidual.length}) while the residual's own token stays suppressed (${ownTokenReported.length}); without the residual there are ${withoutResidual.length} findings, so a residual no longer hides a different stripped identifier in its file`)
  }

  console.log('\n== static gate: item 6 (vacuous-pass hunt) ==')
  const restoreDead = cleanDeadReferences()
  const green = runStatic(WORKTREE, 'green-baseline')
  if (wanted('S9-green-tree-is-achievable')) {
    check('control', 'S9-green-tree-is-achievable',
      green.code === 0 && blockers(green.report).length === 0,
      `deleting only the 3 dangling tsconfig references gives exit ${green.code} with ${blockers(green.report).length} blockers, so the gate is not stuck red`)
  }

  if (wanted('S10-composition-over-suppression')) {
    const probe = 'snapshots/sdk/text-turn/adversarial.cordis.yml'
    const relative = (disabled) => `- id: llm-deepseek\n  name: '@deepseek-ai/dsh-llm-deepseek-api-key'\n  disabled: true\n\n- insert:\n    - id: llm-replay\n      name: '@deepseek-ai/dsh-llm-replay'\n${disabled ? '      disabled: true\n' : ''}    - id: telemetry-bridge\n      name: '@deepseek-ai/dsh-otel'\n`
    writeFileSync(join(WORKTREE, probe), relative(false))
    const caught = runStatic(WORKTREE, 'composition-caught')
    writeFileSync(join(WORKTREE, probe), relative(true))
    const missed = runStatic(WORKTREE, 'composition-missed')
    rmSync(join(WORKTREE, probe), { force: true })
    const caughtBlockers = blockers(caught.report).filter(violation => violation.path === probe)
    const missedBlockers = blockers(missed.report).filter(violation => violation.path === probe)
    // Fixed in b45c997fc8: the row is found by indentation, so a sibling's
    // `disabled: true` no longer reaches the nested active row.
    check('control', 'S10-composition-over-suppression',
      caughtBlockers.length > 0 && missedBlockers.length > 0,
      `an actively composed stripped plugin is a blocker in both shapes: exit ${caught.code} without a disabled sibling, and exit ${missed.code} with one (${missedBlockers.length} blocker at ${probe}), so an unrelated "disabled: true" no longer downgrades it`)
  }

  if (wanted('S11-unreadable-directory-invisible')) {
    const hidden = join(WORKTREE, 'packages/core/agent/blocked')
    mkdirSync(hidden, { recursive: true })
    writeFileSync(join(hidden, 'hidden.cordis.yml'), "- id: telemetry-bridge\n  name: '@deepseek-ai/dsh-otel'\n")
    run('chmod', ['000', hidden])
    const outcome = runStatic(WORKTREE, 'unreadable-directory')
    run('chmod', ['755', hidden])
    rmSync(hidden, { recursive: true, force: true })
    const mentioned = JSON.stringify(outcome.report).includes('blocked')
    // Fixed in b45c997fc8: walkFiles collects unreadable directories and the
    // gate raises static.unreadable-path, so an unreadable subtree is a blocker.
    const unreadableFindings = ofRule(outcome.report, 'static.unreadable-path')
    check('control', 'S11-unreadable-directory-invisible',
      unreadableFindings.length > 0 && mentioned,
      `an unreadable directory is now reported as ${unreadableFindings.length} static.unreadable-path blocker(s) and named in the report (mentioned=${mentioned}), instead of vanishing from it`)
  }

  if (wanted('S12-oversized-composition-invisible')) {
    const hidden = join(WORKTREE, 'fork', 'probe-invisible.cordis.yml')
    const padding = '  # padding aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'.repeat(300000)
    writeFileSync(hidden, `- id: pad\n${padding}- id: telemetry-bridge\n  name: '@deepseek-ai/dsh-otel'\n`)
    const outcome = runStatic(WORKTREE, 'oversized-composition')
    rmSync(hidden, { force: true })
    const mentioned = JSON.stringify(outcome.report).includes('probe-invisible')
    // Fixed in b45c997fc8: an unreadable or oversized composition file is a
    // blocker, and the note reports how many of the matched files were read.
    const unreadFindings = ofRule(outcome.report, 'static.composition-unread')
    check('control', 'S12-oversized-composition-invisible',
      unreadFindings.length > 0 && mentioned,
      `an oversized composition file is now reported as ${unreadFindings.length} static.composition-unread blocker(s) (mentioned=${mentioned}) and the coverage note states how many matched files were actually read, so a skipped composition can no longer pass as covered`)
  }

  restoreDead()
}

/** Egress-gate checks. */
function egressChecks() {
  console.log('\n== egress gate: item 2 (shim honesty) ==')
  if (wanted('E1-shim-absent-is-error')) {
    makeSymlinkRoot()
    const shim = join(SYMROOT, 'fork', 'egress-shim.mjs')
    const preserved = readFileSync(shim)
    rmSync(shim, { force: true })
    const outcome = runEgress(SYMROOT, 'shim-absent', ['--probe', 'headless-help'])
    writeFileSync(shim, preserved)
    check('control', 'E1-shim-absent-is-error',
      outcome.code === 2 && /does not exist/.test(outcome.stderr),
      `with fork/egress-shim.mjs absent the gate exits ${outcome.code} (expected 2) and says "${outcome.stderr.split('\n')[0].slice(0, 90)}"`)
  }

  if (wanted('E2-missing-heartbeat-is-error')) {
    makeSymlinkRoot()
    const shim = join(SYMROOT, 'fork', 'egress-shim.mjs')
    const original = readFileSync(shim, 'utf8')
    const start = original.indexOf('  recorder.heartbeat({')
    const endMarker = '\n  })\n'
    const end = original.indexOf(endMarker, start)
    if (start < 0 || end < 0) throw new Error('egress-shim.mjs heartbeat emission not found; the anti-vacuity test needs updating')
    writeFileSync(shim, `${original.slice(0, start)}  void recorder\n${original.slice(end + endMarker.length)}`)
    const outcome = runEgress(SYMROOT, 'no-heartbeat', ['--probe', 'headless-help'])
    writeFileSync(shim, original)
    const heartbeatFindings = (outcome.report?.violations ?? []).filter(violation => /no shim heartbeat/.test(violation.detail))
    check('control', 'E2-missing-heartbeat-is-error',
      outcome.code === 2 && outcome.report?.status === 'error' && heartbeatFindings.length > 0,
      `suppressing the load-time heartbeat makes exit ${outcome.code} and status=${outcome.report?.status} with ${heartbeatFindings.length} "no shim heartbeat" findings, so a shim that cannot prove it loaded is never a pass`)
  }

  console.log('\n== egress gate: item 3 (known-bad egress) ==')
  if (wanted('E3-known-bad-egress-caught')) {
    const root = makeSymlinkRoot()
    const probePath = join(root, 'fork', 'verifier-known-bad-egress.mjs')
    writeFileSync(probePath, KNOWN_BAD_PROBE)
    const policyPath = join(root, 'fork', 'policy', 'rules-egress.json')
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'))
    policy.probes.push({
      id: 'verifier-known-bad-egress',
      purpose: 'gate',
      description: 'adversarial probe: non-allowlisted egress from parent, child, worker and four APIs',
      command: '{node}',
      args: ['{root}/fork/verifier-known-bad-egress.mjs'],
      allowHosts: [],
      timeoutMs: 60000,
    })
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`)

    const caught = runEgress(root, 'known-bad', ['--probe', 'verifier-known-bad-egress'])
    const hosts = new Set(ofRule(caught.report ?? { violations: [] }, 'egress.not-allowed')
      .map(violation => (/to ([0-9.]+):(\d+)/.exec(violation.detail) ?? []).slice(1, 3).join(':')))
    // The four process-level paths below are guaranteed: the parent's own socket,
    // a UDP datagram, a worker thread, and a spawned child. The undici path is
    // best-effort only: undici is a pnpm transitive dependency that does not
    // resolve from the scratch root, and when it does resolve the attempt is
    // caught by the net layer rather than by the undici layer.
    const guaranteed = ['203.0.113.101:443', '203.0.113.102:8443', '203.0.113.103:9999', '203.0.113.104:7443']
    const missing = guaranteed.filter(target => !hosts.has(target))
    const undiciCaught = hosts.has('203.0.113.105:9443')
    check('control', 'E3-known-bad-egress-caught',
      caught.code === 1 && missing.length === 0,
      `exit ${caught.code}; caught ${guaranteed.length - missing.length}/4 deliberate targets across parent, child process, worker thread and UDP${missing.length === 0 ? '' : ` (missed ${missing.join(', ')})`}; undici-Client path ${undiciCaught ? 'also caught' : 'not exercised (undici did not resolve from the scratch root)'}`)

    const allowed = runEgress(root, 'known-bad-allowlisted', ['--probe', 'verifier-known-bad-egress'], {
      DSH_FORK_EGRESS_ALLOW: '203.0.113.101,203.0.113.102',
    })
    const stillFlagged = new Set(ofRule(allowed.report ?? { violations: [] }, 'egress.not-allowed')
      .map(violation => (/to ([0-9.]+):/.exec(violation.detail) ?? [])[1]))
    check('control', 'E4-allowlist-admits-and-narrows',
      !stillFlagged.has('203.0.113.101') && !stillFlagged.has('203.0.113.102')
        && stillFlagged.has('203.0.113.103') && stillFlagged.has('203.0.113.104'),
      `allowlisting two of the four guaranteed targets drops exactly those two violations and leaves ${stillFlagged.size} flagged (${[...stillFlagged].sort().join(', ')}), so the gate is not simply always-red`)
  }

  console.log('\n== both gates: item 6 (non-vacuous coverage) ==')
  if (wanted('E5-checked-counts-nonzero')) {
    const staticBaseline = run('node', ['fork/verify-static.mjs', '--quiet', '--json', join(REPORT_DIR, 'static-real.json')])
    const staticReport = JSON.parse(readFileSync(join(REPORT_DIR, 'static-real.json'), 'utf8'))
    const egressBaseline = run('node', ['fork/verify-egress.mjs', '--quiet', '--json', join(REPORT_DIR, 'egress-real.json')])
    const egressReport = JSON.parse(readFileSync(join(REPORT_DIR, 'egress-real.json'), 'utf8'))
    realEgressReport = egressReport
    const treeNote = staticReport.notes.find(note => note.startsWith('tree scan read')) ?? ''
    const probes = egressReport.evidence?.probes ?? []
    // The verdict of the egress gate may legitimately be red on a tree where a
    // profile cannot boot (a missing client bundle, for instance). What must
    // never happen is exit 2 with untrusted evidence, or a pass with no work done.
    const untrustworthy = ofRule(egressReport, 'egress.evidence-untrustworthy')
    check('control', 'E5-checked-counts-nonzero',
      staticReport.checked > 1000 && egressReport.checked > 0 && probes.length >= 8
        && staticBaseline.code !== 2 && egressBaseline.code !== 2 && untrustworthy.length === 0,
      `static checked=${staticReport.checked} (exit ${staticBaseline.code}), egress checked=${egressReport.checked} across ${probes.length} probes (exit ${egressBaseline.code}, ${untrustworthy.length} untrustworthy-evidence findings); ${treeNote.slice(0, 60)}`)
  }

  if (wanted('E6-failed-boot-is-not-a-pass')) {
    const probes = realEgressReport?.evidence?.probes ?? []
    const web = probes.find(probe => probe.id === 'web-host')
    const booted = web !== undefined && web.exitCode === 0 && web.aliveMs !== null
    const flagged = ofRule(realEgressReport ?? { violations: [] }, 'egress.probe-failed')
      .some(violation => /web-host/.test(violation.path ?? ''))
    const missingBundle = /client bundles? not found|run `pnpm run build`/.test(web?.stderr ?? '')
    check('control', 'E6-failed-boot-is-not-a-pass',
      booted || flagged,
      booted
        ? 'the web-host profile booted and stayed alive for its liveness window'
        : `the web-host profile could not boot${missingBundle ? ' (missing client bundle: the tree needs a build)' : ''} and the gate reported egress.probe-failed (exit 1) rather than passing, so a profile that never ran cannot be mistaken for a clean profile`)
  }
}

/** Known-bad egress probe used by E3/E4; reserved documentation addresses only. */
const KNOWN_BAD_PROBE = `// Generated by fork/tests/adversarial-gate-checks.mjs (check E3).
import { spawn } from 'node:child_process'
import dgram from 'node:dgram'
import { connect } from 'node:net'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, workerData } from 'node:worker_threads'
const SELF = fileURLToPath(import.meta.url)
function dial(host, port) { connect({ host, port }).on('error', () => {}) }
if (!isMainThread) {
  dial(workerData.host, workerData.port)
} else if (process.env.VERIFIER_PROBE_ROLE === 'child') {
  dial('203.0.113.102', 8443)
} else {
  dial('203.0.113.101', 443)
  dgram.createSocket('udp4').send('probe', 9999, '203.0.113.103')
  spawn(process.execPath, [SELF], { env: { ...process.env, VERIFIER_PROBE_ROLE: 'child' } }).unref()
  const worker = new Worker(SELF, { workerData: { host: '203.0.113.104', port: 7443 } })
  try {
    const undici = createRequire(import.meta.url)('undici')
    const client = new undici.Client('http://203.0.113.105:9443')
    client.request({ path: '/adversarial', method: 'GET' }).catch(() => {})
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1500))
  await worker.terminate()
}
process.exit(0)
`

/** Remove every scratch artifact this suite created. */
function cleanup() {
  run('git', ['worktree', 'remove', '--force', WORKTREE])
  // A worktree whose directory is already gone leaves a stale registration that
  // only `prune` clears, so remove the directory unconditionally and prune after;
  // otherwise an interrupted run can leave this repository listing a worktree.
  rmSync(WORKTREE, { recursive: true, force: true })
  run('git', ['worktree', 'prune'])
  rmSync(SYMROOT, { recursive: true, force: true })
}

try {
  mkdirSync(REPORT_DIR, { recursive: true })
  if (wanted('S0')) console.log(`scratch reports: ${REPORT_DIR}`)
  staticChecks()
  egressChecks()
} finally {
  if (!keep) cleanup()
  else console.log(`\n--keep: left ${WORKTREE} and ${SYMROOT} in place`)
}

const controls = results.filter(result => result.kind === 'control')
const holes = results.filter(result => result.kind === 'hole')
const failedControls = controls.filter(result => !result.ok)
const closedHoles = holes.filter(result => !result.ok)
console.log(`\n== summary ==`)
console.log(`  controls: ${controls.length - failedControls.length}/${controls.length} hold`)
console.log(`  documented holes: ${holes.length - closedHoles.length}/${holes.length} still present`)
if (failedControls.length > 0) {
  console.log('\n  GATE DEFECTS:')
  for (const result of failedControls) console.log(`   - ${result.id}: ${result.evidence}`)
}
if (closedHoles.length > 0) {
  console.log('\n  HOLES THAT APPEAR FIXED (re-verify, then reclassify as control):')
  for (const result of closedHoles) console.log(`   - ${result.id}: ${result.evidence}`)
}
process.exitCode = failedControls.length === 0 ? 0 : 1

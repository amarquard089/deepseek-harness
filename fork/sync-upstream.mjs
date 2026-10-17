#!/usr/bin/env node
// Daily upstream sync for the telemetry-free fork.
//
// The job fetches upstream, prepares a sync branch, re-applies the telemetry
// strip, proves both gates, and only then merges the sync branch into the
// protected branch. It is the only component allowed to move the protected
// branch, so it never rewrites history, never force-pushes, and never continues
// past a failed gate, a failed build, or an unresolved conflict.
//
// Usage:
//   node fork/sync-upstream.mjs [--date YYYY-MM-DD] [--dry-run] [--no-merge] [--no-push] [--skip-build]
//
// Exit codes: 0 clean (nothing to sync, or merged on green), 1 prepared but
// blocked by a gate or an unresolvable reference, 2 preflight or internal error.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve as resolvePath } from 'node:path'

import { EXIT, loadPolicy, parseArgv } from './lib/policy.mjs'
import {
  addedPathsChecked,
  branchExists,
  commitsBetween,
  conflictedPaths,
  currentBranch,
  divergence,
  git,
  gitPath,
  mergeBase,
  remoteExists,
  revParse,
  trackedChanges,
  untrackedEntries,
} from './lib/sync/git.mjs'
import { forkLocalPreserved, resolveConflicts } from './lib/sync/conflicts.mjs'
import { gateDecision, resolveGateScripts, runGates, validateRequiredGates } from './lib/sync/gates.mjs'
import { addCheck, capture, newSyncReport, reproduceCommands, writeSyncReport } from './lib/sync/report.mjs'
import { applyStrip, deriveStripSets } from './lib/sync/strip-engine.mjs'

/** Flags this CLI accepts; anything else is a usage error. */
const KNOWN_FLAGS = new Set(['date', 'dry-run', 'no-merge', 'no-push', 'skip-build', 'help'])

/** Longest commit list kept per report. */
const COMMIT_LIMIT = 200

/** Longest issue list kept per report section. */
const ISSUE_LIMIT = 200

/**
 * Print the CLI usage text.
 * @returns {void}
 */
function usage() {
  console.log(
    [
      'Usage: node fork/sync-upstream.mjs [options]',
      '',
      '  --date YYYY-MM-DD  Run date used for branch and report names (default: today).',
      '  --dry-run          Do everything except the final merge and push.',
      '  --no-merge         Prepare and prove the sync without merging it.',
      '  --no-push          Merge locally without pushing to the origin remote.',
      '  --skip-build       Skip `pnpm run build:artifacts` before the gates.',
      '  --help             Print this text.',
      '',
      'Exit codes: 0 clean, 1 prepared but blocked, 2 preflight or internal error.',
    ].join('\n'),
  )
}

/**
 * Resolve today's local date.
 * @returns {string} `YYYY-MM-DD` in the machine's local time zone.
 */
function todayLocal() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * Test for an interrupted git operation that must be resolved by hand first.
 * @param {string} root Repository root.
 * @returns {string|null} Name of the interrupted operation, or null.
 */
function interruptedOperation(root) {
  if (revParse(root, 'MERGE_HEAD') !== null) return 'merge'
  for (const [name, marker] of [
    ['rebase', 'rebase-merge'],
    ['rebase', 'rebase-apply'],
    ['cherry-pick', 'CHERRY_PICK_HEAD'],
    ['revert', 'REVERT_HEAD'],
  ]) {
    const path = gitPath(root, marker)
    if (existsSync(resolvePath(root, path))) return name
  }
  return null
}

/**
 * Extract the untracked paths a refusal to merge named.
 * @param {string} text Merge output.
 * @returns {string[]} Paths git refused to overwrite.
 */
function untrackedOverwrites(text) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /untracked working tree files would be overwritten/i.test(line))
  if (start === -1) return []
  const paths = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || !/^\s/.test(line)) break
    paths.push(line.trim())
  }
  return paths
}

/**
 * Choose a branch name that never overwrites an existing branch's history.
 * @param {string} root Repository root.
 * @param {string} base Preferred branch name.
 * @param {string} tip Commit the branch must point at to be reusable.
 * @returns {{name: string, reused: boolean}} Branch name to use.
 */
function uniqueBranchName(root, base, tip) {
  if (branchExists(root, base)) {
    if (revParse(root, base) === tip) return { name: base, reused: true }
  } else {
    return { name: base, reused: false }
  }
  const withSha = `${base}-${tip.slice(0, 7)}`
  if (branchExists(root, withSha)) {
    if (revParse(root, withSha) === tip) return { name: withSha, reused: true }
  } else {
    return { name: withSha, reused: false }
  }
  for (let index = 2; index <= 50; index += 1) {
    const candidate = `${withSha}-${index}`
    if (!branchExists(root, candidate)) return { name: candidate, reused: false }
  }
  throw new Error(`cannot find an unused branch name derived from ${base}`)
}

/**
 * Keep a bounded slice of a list for the report.
 * @param {object[]} entries Report entries.
 * @param {number} limit Maximum entries kept.
 * @returns {{entries: object[], truncated: number}} Kept entries and how many were dropped.
 */
function cap(entries, limit) {
  return { entries: entries.slice(0, limit), truncated: Math.max(0, entries.length - limit) }
}

/**
 * Run one unattended sync.
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
  const date = parsed.values.get('date') ?? todayLocal()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`--date must be YYYY-MM-DD, got ${date}`)
    return EXIT.error
  }
  const mode = {
    dryRun: parsed.flags.has('dry-run'),
    noMerge: parsed.flags.has('no-merge'),
    noPush: parsed.flags.has('no-push'),
    skipBuild: parsed.flags.has('skip-build'),
  }

  let policy
  try {
    policy = loadPolicy()
  } catch (error) {
    console.error(`[sync] ${error.message}`)
    return EXIT.error
  }
  const core = policy.core
  const root = policy.root
  const report = newSyncReport({ date, root, argv: process.argv.slice(2), mode, core })
  const upstreamRemote = core.fork.upstreamRemote
  const upstreamRef = `${core.fork.upstreamRemote}/${core.fork.upstreamBranch}`
  const originRemote = core.fork.originRemote
  const protectedBranch = core.fork.protectedBranch
  const log = message => console.log(`[sync] ${message}`)

  /**
   * Discard only the uncommitted strip edits this run made on its own sync
   * branch, so a failed run cannot block the return to the protected branch.
   * Preflight proved the tree was clean, so nothing of the owner's is at risk.
   * @returns {void}
   */
  const recoverOwnEdits = () => {
    const syncBranchName = report.syncBranch === null ? null : report.syncBranch.branch
    if (syncBranchName === null || currentBranch(root) !== syncBranchName) return
    if (trackedChanges(root).length === 0) return
    const restored = git(root, ['checkout', '--', '.'])
    report.notes.push(
      `${restored.command} discarded this run's uncommitted strip edits on ${syncBranchName} ` +
        '(exit ' + restored.exitCode + '); the merge commit is untouched and preflight had verified a clean tree',
    )
  }

  /**
   * Finish the run: record the action, restore the protected checkout, write the report.
   * @param {number} code Exit code.
   * @param {string} action Final action identifier.
   * @param {{restore?: boolean}} [options] Whether to restore the protected checkout first.
   * @returns {number} The exit code.
   */
  const finish = (code, action, options = {}) => {
    if (options.restore !== false && report.syncBranch !== null && currentBranch(root) !== protectedBranch) {
      recoverOwnEdits()
      const restored = git(root, ['checkout', protectedBranch])
      if (restored.exitCode !== 0) {
        report.notes.push(`could not restore the ${protectedBranch} checkout: ${capture(restored.stderr)}`)
        code = EXIT.error
        action = `${action}-checkout-restore-failed`
      }
    }
    report.finalAction = action
    report.exitCode = code
    report.finishedAt = new Date().toISOString()
    const paths = writeSyncReport({ root, report, core })
    log(`action=${action} exit=${code}`)
    log(`report=${paths.jsonPath} markdown=${paths.markdownPath} history=${paths.historyPath}`)
    return code
  }

  try {
    // 1. Preflight: prove the policy can be satisfied and the checkout can be synced.
    const gateContract = validateRequiredGates(core.gates, core.requiredGateIds)
    if (!gateContract.ok) {
      addCheck(report, 'required-gates', 'fail', gateContract.problems.join('; '))
      report.notes.push('an empty or all-optional gate list must never merge: the hard requirement is a universal over the gates')
      report.reproduce = ['# restore core.json gates and requiredGateIds, then re-run']
      return finish(EXIT.error, 'preflight-required-gates-invalid')
    }
    addCheck(report, 'required-gates', 'pass', `required gates: ${gateContract.required.map(gate => gate.id).join(', ')}`)
    if (revParse(root, 'HEAD') === null) {
      addCheck(report, 'git-repository', 'fail', `${root} is not a git repository with a resolvable HEAD`)
      return finish(EXIT.error, 'preflight-not-a-repository')
    }
    const dirty = trackedChanges(root)
    if (dirty.length > 0) {
      addCheck(report, 'clean-working-tree', 'fail', `tracked changes present: ${dirty.slice(0, 20).join('; ')}`)
      report.reproduce = ['git status --porcelain', 'git diff']
      return finish(EXIT.error, 'preflight-dirty-working-tree')
    }
    addCheck(report, 'clean-working-tree', 'pass', 'no tracked changes')
    report.untracked = untrackedEntries(root)
    if (report.untracked.length > 0) {
      addCheck(report, 'untracked-files', 'info', `${report.untracked.length} untracked path(s) left in place, never stashed`)
      report.notes.push(`untracked paths are not fatal and stay untouched: ${report.untracked.slice(0, 20).join('; ')}`)
    }
    const interrupted = interruptedOperation(root)
    if (interrupted !== null) {
      addCheck(report, 'interrupted-operation', 'fail', `a ${interrupted} is in progress; resolve it before syncing`)
      report.reproduce = [`git ${interrupted} --continue`, `git ${interrupted} --abort`]
      return finish(EXIT.error, 'preflight-interrupted-operation')
    }
    addCheck(report, 'interrupted-operation', 'pass', 'no merge, rebase, cherry-pick, or revert in progress')
    const branch = currentBranch(root)
    if (branch === 'HEAD') {
      addCheck(report, 'protected-branch', 'fail', 'the checkout is on a detached HEAD')
      report.reproduce = [`git checkout ${protectedBranch}`]
      return finish(EXIT.error, 'preflight-detached-head')
    }
    if (branch !== protectedBranch) {
      addCheck(report, 'protected-branch', 'fail', `on ${branch}, expected ${protectedBranch}`)
      report.reproduce = [`git checkout ${protectedBranch}`]
      return finish(EXIT.error, 'preflight-wrong-branch')
    }
    addCheck(report, 'protected-branch', 'pass', `on ${branch}`)
    if (!remoteExists(root, upstreamRemote)) {
      addCheck(report, 'upstream-remote', 'fail', `remote ${upstreamRemote} is not configured`)
      report.reproduce = [`git remote add ${upstreamRemote} <upstream url>`]
      return finish(EXIT.error, 'preflight-upstream-remote-missing')
    }
    addCheck(report, 'upstream-remote', 'pass', `remote ${upstreamRemote} configured`)
    const protectedSha = revParse(root, protectedBranch)
    if (protectedSha === null) {
      addCheck(report, 'protected-tip', 'fail', `branch ${protectedBranch} does not resolve`)
      return finish(EXIT.error, 'preflight-protected-missing')
    }
    report.protectedSha = protectedSha
    addCheck(report, 'protected-tip', 'pass', `${protectedBranch} at ${protectedSha}`)

    // 2. Fetch upstream, then derive the range that arrived.
    const fetched = git(root, ['fetch', upstreamRemote])
    if (fetched.exitCode !== 0) {
      addCheck(report, 'fetch', 'fail', `${fetched.command}: ${capture(fetched.stderr)}`)
      report.reproduce = [fetched.command]
      return finish(EXIT.error, 'fetch-failed')
    }
    addCheck(report, 'fetch', 'pass', captured(fetched))
    const upstreamSha = revParse(root, upstreamRef)
    if (upstreamSha === null) {
      addCheck(report, 'upstream-tip', 'fail', `${upstreamRef} does not resolve after fetch`)
      return finish(EXIT.error, 'preflight-upstream-missing')
    }
    const counts = divergence(root, protectedSha, upstreamRef)
    report.upstream = {
      remote: upstreamRemote,
      branch: core.fork.upstreamBranch,
      ref: upstreamRef,
      sha: upstreamSha,
      ahead: counts.ahead,
      behind: counts.behind,
      newCommits: [],
    }
    addCheck(report, 'upstream-tip', 'pass', `${upstreamRef} at ${upstreamSha}`)

    // 3. Nothing to sync ends the run before any branch is created.
    const commits = commitsBetween(root, protectedSha, upstreamRef)
    const capped = cap(commits, COMMIT_LIMIT)
    report.upstream.newCommits = capped.entries
    if (capped.truncated > 0) report.notes.push(`${capped.truncated} further upstream commit(s) omitted from the report`)
    if (commits.length === 0) {
      addCheck(report, 'upstream-range', 'pass', `${protectedBranch} already contains every commit of ${upstreamRef}`)
      const gates = resolveGateScripts(root, core.gates)
      for (const gate of gates) {
        if (!gate.present) addCheck(report, 'gate-script', 'info', `${gate.id}: ${gate.script} is absent; no gate was needed`)
      }
      log(`no changes to sync: ${protectedBranch} == ${upstreamRef}`)
      report.reproduce = [`git log --oneline ${protectedBranch}..${upstreamRef}`]
      return finish(EXIT.pass, 'no-changes')
    }
    addCheck(report, 'upstream-range', 'pass', `${commits.length} commit(s) to sync`)

    // 4. Gate scripts must exist before anything mutates.
    const gates = resolveGateScripts(root, core.gates)
    const missing = gates.filter(gate => core.gates.find(entry => entry.id === gate.id)?.required === true && !gate.present)
    for (const gate of gates) {
      const required = core.gates.find(entry => entry.id === gate.id)?.required === true
      addCheck(
        report,
        `gate-script-${gate.id}`,
        gate.present ? 'pass' : required ? 'fail' : 'info',
        gate.present ? `${gate.script}` : `${gate.script ?? gate.command} is missing${required ? '' : ' (not required)'}`,
      )
    }
    if (missing.length > 0) {
      report.reproduce = missing.map(gate => `# provide ${gate.script ?? gate.command} for gate ${gate.id}`)
      return finish(EXIT.error, 'preflight-gate-missing')
    }

    // 5. Back up the protected tip, then prepare the sync branch.
    const backup = uniqueBranchName(root, `${core.mergePolicy.backupBranchPrefix}${date}`, protectedSha)
    if (!backup.reused) {
      const created = git(root, ['branch', backup.name, protectedSha])
      if (created.exitCode !== 0) {
        addCheck(report, 'backup-branch', 'fail', `${created.command}: ${capture(created.stderr)}`)
        return finish(EXIT.error, 'backup-failed')
      }
    }
    report.backup = { branch: backup.name, sha: protectedSha, reused: backup.reused }
    addCheck(report, 'backup-branch', 'pass', `${backup.name} -> ${protectedSha}`)

    const sync = uniqueBranchName(root, `${core.mergePolicy.syncBranchPrefix}${date}`, protectedSha)
    const checkedOut = git(root, ['checkout', '-b', sync.name, protectedSha])
    if (checkedOut.exitCode !== 0) {
      addCheck(report, 'sync-branch', 'fail', `${checkedOut.command}: ${capture(checkedOut.stderr)}`)
      return finish(EXIT.error, 'sync-branch-failed')
    }
    report.syncBranch = { branch: sync.name, reused: sync.reused }
    addCheck(report, 'sync-branch', 'pass', `${sync.name} -> ${protectedSha}`)

    // 6. Merge upstream into the sync branch; a conflict is never resolved blindly.
    const merged = git(root, ['merge', '--no-ff', '-m', `Merge ${upstreamRef} into ${sync.name}`, upstreamRef])
    let conflicts = conflictedPaths(root)
    if (merged.exitCode !== 0 && conflicts.length === 0) {
      const overwritten = untrackedOverwrites(`${merged.stdout}\n${merged.stderr}`)
      if (overwritten.length > 0) {
        report.merge = {
          status: 'blocked-by-untracked-files',
          commit: null,
          conflictedPaths: [],
          untrackedConflicts: overwritten,
          command: merged.command,
          output: capture(`${merged.stdout}\n${merged.stderr}`),
        }
        report.reproduce = [
          'git status --porcelain --untracked-files=all',
          `# move, commit, or remove: ${overwritten.join(', ')}`,
          `git merge ${upstreamRef}`,
        ]
        addCheck(report, 'merge-upstream', 'fail', `${overwritten.length} untracked path(s) would be overwritten; nothing was merged`)
        return finish(EXIT.fail, 'merge-blocked-by-untracked-files')
      }
    }
    let resolution = null
    if (conflicts.length > 0) {
      resolution = resolveConflicts({
        root,
        sets: deriveStripSets(core),
        protectedBranch,
        upstreamRef,
        date,
        reportsDirectory: core.reports.directory,
        syncBranch: sync.name,
        log,
      })
      report.merge = {
        status: resolution.unresolved.length === 0 ? 'conflict-resolved' : 'conflict-unresolved',
        commit: null,
        conflictedPaths: conflicts,
        untrackedConflicts: [],
        mergeBase: resolution.mergeBase,
        resolutions: resolution.entries,
        unresolved: resolution.unresolved,
        evidence: resolution.evidence,
        evidenceIndex: resolution.index,
        command: merged.command,
        output: capture(`${merged.stdout}\n${merged.stderr}`),
      }
      if (resolution.unresolved.length === 0) {
        const completed = git(root, ['commit', '--no-verify', '--no-edit'])
        if (completed.exitCode !== 0) {
          git(root, ['merge', '--abort'])
          addCheck(report, 'merge-upstream', 'fail', `resolved merge could not be committed: ${capture(completed.stderr)}`)
          return finish(EXIT.error, 'merge-commit-failed')
        }
        report.merge.commit = revParse(root, 'HEAD')
        addCheck(
          report,
          'merge-upstream',
          'pass',
          `${conflicts.length} conflict(s) resolved by policy, merge commit ${report.merge.commit}`,
        )
        log(`merged ${upstreamRef} into ${sync.name} after resolving ${conflicts.length} conflict(s)`)
      } else {
        const abort = revParse(root, 'MERGE_HEAD') === null ? null : git(root, ['merge', '--abort'])
        report.merge.abortCommand = abort === null ? null : abort.command
        report.merge.aborted = abort === null ? null : abort.exitCode === 0
        report.reproduce = resolution.reproduce
        addCheck(report, 'merge-upstream', 'fail', `${resolution.unresolved.length} conflict(s) need judgment; merge aborted`)
        return finish(EXIT.fail, 'merge-conflict-unresolved')
      }
    } else {
      report.merge = {
        status: /Already up to date/i.test(merged.stdout) ? 'up-to-date' : 'merged',
        commit: revParse(root, 'HEAD'),
        conflictedPaths: [],
        command: merged.command,
        output: capture(merged.stdout),
      }
      addCheck(report, 'merge-upstream', 'pass', `${report.merge.status} at ${report.merge.commit}`)
      log(`merged ${upstreamRef} into ${sync.name}: ${report.merge.status}`)
    }

    // 7. Re-apply the strip and commit exactly the paths it touched.
    const strip = applyStrip({ root, core, dryRun: false, baselineRef: protectedSha })
    report.strip = {
      changed: strip.changed,
      filesChanged: strip.filesChanged,
      deletions: cap(strip.deletions, ISSUE_LIMIT).entries,
      edits: cap(strip.edits, ISSUE_LIMIT).entries,
      unhandled: cap(strip.unhandled, ISSUE_LIMIT).entries,
      newResiduals: cap(strip.newResiduals, ISSUE_LIMIT).entries,
      residuals: cap(strip.residuals, ISSUE_LIMIT).entries,
      clean: strip.clean,
      surfacesClean: strip.surfacesClean,
      residualPolicy: {
        blocks: strip.unhandled.length > 0,
        unhandled: strip.unhandled.length,
        newResiduals: strip.newResiduals.length,
        preExistingResiduals: strip.residuals.length,
        adjudicatedBy: 'gate-static',
        sample: strip.newResiduals.slice(0, 10).map(residual => `${residual.path} (${residual.detail})`),
      },
    }
    for (const section of ['deletions', 'edits', 'unhandled', 'newResiduals', 'residuals']) {
      const dropped = cap(strip[section], ISSUE_LIMIT).truncated
      if (dropped > 0) report.notes.push(`${dropped} further strip ${section} omitted from the report`)
    }
    log(
      `strip: changed=${strip.changed} deleted=${strip.deletions.length} edited=${strip.edits.length} ` +
        `unhandled=${strip.unhandled.length} newReferences=${strip.newResiduals.length}`,
    )
    if (strip.unhandled.length > 0) {
      for (const issue of strip.unhandled.slice(0, 10)) {
        log(`strip unhandled: ${issue.path}${issue.line ? `:${issue.line}` : ''} ${issue.detail}`)
      }
    }
    if (strip.newResiduals.length > 0) {
      log(
        `strip: ${strip.newResiduals.length} residual reference(s) outside the strip's surfaces are recorded for the ` +
          'static gate to adjudicate; they do not block the sync',
      )
      for (const residual of strip.newResiduals.slice(0, 10)) log(`strip residual: ${residual.path} ${residual.detail}`)
      report.notes.push(
        `${strip.newResiduals.length} residual reference(s) outside the strip's surfaces (released Session fixtures and ` +
          'prose) are recorded for the static gate to adjudicate against its justified-residual policy',
      )
    }
    if (strip.changed > 0) {
      const paths = [...new Set([...strip.deletions.map(deletion => deletion.path), ...strip.edits.map(edit => edit.path)])]
      const staged = git(root, ['add', '-A', '--', ...paths])
      if (staged.exitCode !== 0) {
        addCheck(report, 'strip-commit', 'fail', `${staged.command}: ${capture(staged.stderr)}`)
        return finish(EXIT.error, 'strip-stage-failed')
      }
      const committed = git(root, [
        'commit',
        '--no-verify',
        '-m',
        `Re-apply the telemetry strip after merging ${upstreamRef}\n\nThe strip removed ${strip.changed} reference(s) across ${strip.filesChanged} path(s) using fork/policy/core.json.`,
      ])
      if (committed.exitCode !== 0) {
        addCheck(report, 'strip-commit', 'fail', `${committed.command}: ${capture(committed.stderr)}`)
        return finish(EXIT.error, 'strip-commit-failed')
      }
      addCheck(report, 'strip-commit', 'pass', revParse(root, 'HEAD'))
    } else {
      addCheck(report, 'strip-commit', 'pass', 'nothing to re-apply: the merge did not restore a stripped surface')
    }

    if (strip.unhandled.length > 0) {
      report.reproduce = reproduceCommands(core, sync.name)
      return finish(EXIT.fail, 'strip-incomplete')
    }

    // 7b. The strip and every resolution must leave the fork's own additions alone.
    const preserved = forkLocalPreserved({
      root,
      listAdded: addedPathsChecked,
      base: mergeBase(root, protectedSha, upstreamRef),
      protectedBranch,
    })
    report.forkLocalPreserved = preserved
    if (!preserved.ok) {
      addCheck(
        report,
        'fork-local-preserved',
        'fail',
        preserved.reason ??
          `${preserved.missing.length} of ${preserved.checked} fork-added path(s) are missing: ${preserved.missing.join(', ')}`,
      )
      report.reproduce = [`git checkout ${sync.name}`, ...preserved.missing.map(path => `git checkout ${protectedSha} -- ${path}`)]
      return finish(EXIT.fail, 'fork-local-path-lost')
    }
    addCheck(report, 'fork-local-preserved', 'pass', `${preserved.checked} fork-added path(s) still present`)

    // 8. Build the artifacts the static gate scans, unless the run skips it.
    if (!mode.skipBuild) {
      const buildLogPath = join(root, 'fork/reports', `${date}-build.log`)
      mkdirSync(join(root, 'fork/reports'), { recursive: true })
      const built = spawnSync('/bin/sh', ['-c', 'pnpm run build:artifacts'], {
        cwd: root,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        timeout: 60 * 60 * 1000,
      })
      const exitCode = built.status === null ? 124 : built.status
      writeFileSync(buildLogPath, `${built.stdout ?? ''}${built.stderr ?? ''}`)
      report.build = {
        command: 'pnpm run build:artifacts',
        exitCode,
        logPath: `fork/reports/${date}-build.log`,
        tail: capture(built.stderr ?? built.stdout ?? ''),
      }
      if (exitCode !== 0) {
        addCheck(report, 'build-artifacts', 'fail', `pnpm run build:artifacts exited ${exitCode}; see ${report.build.logPath}`)
        report.reproduce = ['pnpm run build:artifacts', `tail -50 fork/reports/${date}-build.log`]
        return finish(EXIT.error, 'build-failed')
      }
      addCheck(report, 'build-artifacts', 'pass', `log ${report.build.logPath}`)
    } else {
      addCheck(report, 'build-artifacts', 'info', 'skipped by --skip-build; gates that scan built artifacts must tolerate that')
    }

    // 9. Run the gates and decide.
    report.gates = runGates({ root, gates: core.gates, date, log })
    const decision = gateDecision(report.gates, strip.unhandled.length, core.requiredGateIds)
    if (!decision.allowed) {
      report.notes.push(...decision.blocking)
      report.reproduce = reproduceCommands(core, sync.name)
      return finish(EXIT.fail, 'gate-failed')
    }

    // 10. Merge the proven sync branch into the protected branch.
    const range = `${protectedSha.slice(0, 9)}..${upstreamSha.slice(0, 9)}`
    const gateSummary = report.gates
      .filter(gate => gate.required)
      .map(gate => `${gate.id}=${gate.verdict}`)
      .join(' ')
    const mergeMessage = [
      `Sync ${date}: merge ${upstreamRef} (${range}) into ${protectedBranch}`,
      '',
      `Upstream range: ${range} (${commits.length} commit(s))`,
      `Telemetry strip re-applied: ${strip.changed} change(s) over ${strip.filesChanged} path(s)`,
      `Gates passed: ${gateSummary}`,
    ].join('\n')
    if (mode.dryRun || mode.noMerge) {
      report.reproduce = [
        `git checkout ${protectedBranch}`,
        `git merge --no-ff ${sync.name} -m "${mergeMessage.split('\n')[0]}"`,
        `git push ${originRemote} ${protectedBranch}`,
      ]
      return finish(EXIT.pass, mode.dryRun ? 'dry-run-green' : 'merge-skipped')
    }
    if (!mode.noPush) {
      if (!remoteExists(root, originRemote)) {
        addCheck(report, 'origin-remote', 'fail', `remote ${originRemote} is not configured`)
        return finish(EXIT.error, 'preflight-origin-remote-missing')
      }
      const fetchedOrigin = git(root, ['fetch', originRemote])
      if (fetchedOrigin.exitCode !== 0) {
        addCheck(report, 'origin-fetch', 'fail', `${fetchedOrigin.command}: ${capture(fetchedOrigin.stderr)}`)
        return finish(EXIT.error, 'origin-fetch-failed')
      }
      const remoteSha = revParse(root, `${originRemote}/${protectedBranch}`)
      const remoteAhead = remoteSha === null ? 0 : divergence(root, protectedSha, `${originRemote}/${protectedBranch}`).behind
      if (remoteAhead > 0) {
        addCheck(report, 'remote-protected-tip', 'fail', `${originRemote}/${protectedBranch} at ${remoteSha} moved ahead of ${protectedSha}`)
        report.reproduce = [`git log --oneline ${protectedSha}..${originRemote}/${protectedBranch}`]
        return finish(EXIT.error, 'remote-protected-branch-moved')
      }
      addCheck(report, 'remote-protected-tip', 'pass', remoteSha === null ? 'no remote tip yet' : `${originRemote}/${protectedBranch} at ${remoteSha}`)
    }
    const ontoProtected = git(root, ['checkout', protectedBranch])
    if (ontoProtected.exitCode !== 0) {
      addCheck(report, 'checkout-protected', 'fail', `${ontoProtected.command}: ${capture(ontoProtected.stderr)}`)
      return finish(EXIT.error, 'checkout-protected-failed', { restore: false })
    }
    const ontoSync = git(root, ['merge', '--no-ff', '-m', mergeMessage, sync.name])
    if (ontoSync.exitCode !== 0) {
      const conflictsOnProtected = conflictedPaths(root)
      git(root, ['merge', '--abort'])
      report.merge = { ...report.merge, status: 'conflict-on-protected', conflictedPaths: conflictsOnProtected }
      addCheck(report, 'merge-protected', 'fail', `${ontoSync.command}: ${capture(ontoSync.stderr)}`)
      return finish(EXIT.error, 'protected-merge-failed')
    }
    const mergedSha = revParse(root, 'HEAD')
    addCheck(report, 'merge-protected', 'pass', `${protectedBranch} at ${mergedSha}`)
    report.protectedSha = mergedSha
    if (mode.noPush) {
      report.reproduce = [`git push ${originRemote} ${protectedBranch}`]
      return finish(EXIT.pass, 'merged-no-push')
    }
    const pushed = git(root, ['push', originRemote, protectedBranch])
    if (pushed.exitCode !== 0) {
      addCheck(report, 'push', 'fail', `${pushed.command}: ${capture(pushed.stderr)}`)
      report.notes.push(`${protectedBranch} is merged locally at ${mergedSha} but the push failed`)
      report.reproduce = [pushed.command]
      return finish(EXIT.error, 'push-failed')
    }
    addCheck(report, 'push', 'pass', capture(pushed.stderr) || `${originRemote}/${protectedBranch} updated`)
    return finish(EXIT.pass, 'merged')
  } catch (error) {
    report.notes.push(`unexpected failure: ${error.stack ?? error.message}`)
    return finish(EXIT.error, 'internal-error')
  }
}

/**
 * Summarize one captured git invocation for the report.
 * @param {{command: string, exitCode: number, stdout: string, stderr: string}} result Captured git result.
 * @returns {string} One-line summary.
 */
function captured(result) {
  const output = capture(result.stdout || result.stderr)
  return `${result.command} -> exit ${result.exitCode}${output ? `: ${output.split('\n')[0]}` : ''}`
}

process.exitCode = main()

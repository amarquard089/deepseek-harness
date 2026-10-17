// Deterministic conflict resolution for the upstream sync.
//
// A strip fork conflicts with upstream on modify/delete for every stripped
// package, so aborting on any conflict would stop the daily sync forever. This
// module resolves only the conflicts where the correct answer follows from the
// policy, and refuses the rest:
//
//   A `strip-wins-delete`       the path is part of the strip policy, so the
//                               resolved tree deletes it again.
//   B `upstream-wins-restrip`   a content conflict whose entire fork-side change
//                               is strip-related, so upstream's version can win
//                               and the strip re-applies afterwards.
//   C `needs-judgment`          anything else. The run aborts and preserves the
//                               conflict stages for the follow-up agent.
//
// A resolution never runs over conflict markers: every resolved path is read
// back and any remaining `<<<<<<<`/`>>>>>>>` line turns the path into case C.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { git, mergeBase, stageContent, unmergedEntries } from './git.mjs'
import { escapeRegExp, stripSurfaceMatch } from './strip-engine.mjs'

/** Resolution rules recorded per conflicted path. */
export const RULES = Object.freeze({
  stripWinsDelete: 'A-strip-wins-delete',
  upstreamWinsRestrip: 'B-upstream-wins-restrip',
  needsJudgment: 'C-needs-judgment',
})

/** Conflict marker lines that must never survive a resolution. */
const MARKER = /^(<{7}|>{7})(\s|$)/

/**
 * Resolve the conflicts of an in-progress merge where the policy decides.
 * @param {object} input Resolution inputs.
 * @param {string} input.root Repository root.
 * @param {object} input.sets Strip matching sets.
 * @param {string} input.protectedBranch Protected branch name.
 * @param {string} input.upstreamRef Upstream ref being merged.
 * @param {string} input.date Run date, used for the evidence directory.
 * @param {string} input.reportsDirectory Report directory from the policy.
 * @param {string} input.syncBranch Sync branch holding the merge.
 * @param {(message: string) => void} [input.log] Progress sink.
 * @returns {{mergeBase: string|null, entries: object[], unresolved: object[], evidence: string[], index: string|null, reproduce: string[]}} Resolution outcome.
 */
export function resolveConflicts({ root, sets, protectedBranch, upstreamRef, date, reportsDirectory, syncBranch, log = () => {} }) {
  const entries = unmergedEntries(root)
  const base = mergeBase(root, protectedBranch, upstreamRef)
  const resolutions = []
  const unresolved = []
  for (const entry of entries) {
    const decision = decide({ root, sets, base, protectedBranch, path: entry.path, stages: entry.stages })
    const record = { path: entry.path, stages: entry.stages, rule: decision.rule, resolvedByPolicy: decision.rule, detail: decision.detail }
    if (decision.rule === RULES.needsJudgment) {
      unresolved.push(record)
      log(`conflict unresolved: ${entry.path} (${decision.detail})`)
      continue
    }
    const applied = decision.rule === RULES.stripWinsDelete
      ? applyDelete(root, entry.path)
      : applyTheirs(root, entry.path)
    if (!applied.ok) {
      record.rule = RULES.needsJudgment
      record.resolvedByPolicy = null
      record.detail = `${decision.detail}; resolution command failed: ${applied.error}`
      unresolved.push(record)
      log(`conflict unresolved: ${entry.path} (${record.detail})`)
      continue
    }
    const markers = conflictMarkers(root, entry.path)
    if (markers.length > 0) {
      record.rule = RULES.needsJudgment
      record.resolvedByPolicy = null
      record.detail = `conflict markers remain at line(s) ${markers.join(', ')}`
      unresolved.push(record)
      log(`conflict unresolved: ${entry.path} (${record.detail})`)
      continue
    }
    resolutions.push(record)
    log(`conflict resolved: ${entry.path} by ${record.rule}`)
  }
  if (unresolved.length === 0) {
    return { mergeBase: base, entries: resolutions, unresolved, evidence: [], index: null, reproduce: [] }
  }
  const evidence = dumpEvidence({ root, date, reportsDirectory, unresolved, syncBranch, upstreamRef })
  return {
    mergeBase: base,
    entries: resolutions,
    unresolved,
    evidence: evidence.files,
    index: evidence.index,
    reproduce: [
      `git checkout ${syncBranch}`,
      `git merge ${upstreamRef}`,
      ...unresolved.slice(0, 5).map(entry => `git checkout --merge -- ${entry.path}`),
      `# stages preserved under ${reportsDirectory}/${date}-conflicts/`,
    ],
  }
}

/**
 * Decide which rule applies to one conflicted path.
 * @param {object} input Decision inputs.
 * @param {string} input.root Repository root.
 * @param {object} input.sets Strip matching sets.
 * @param {string|null} input.base Merge base revision.
 * @param {string} input.protectedBranch Protected branch name.
 * @param {string} input.path Conflicted path.
 * @param {number[]} input.stages Index stages present.
 * @returns {{rule: string, detail: string}} Rule and its evidence.
 */
function decide({ root, sets, base, protectedBranch, path, stages }) {
  if (isStrippedPath(path, sets)) {
    return { rule: RULES.stripWinsDelete, detail: 'path is part of the strip policy' }
  }
  const contentConflict = stages.includes(2) && stages.includes(3)
  if (!contentConflict) {
    return { rule: RULES.needsJudgment, detail: `unhandled conflict shape, stages present: ${stages.join(',')}` }
  }
  if (base === null) {
    return { rule: RULES.needsJudgment, detail: 'no merge base, so the fork-side change cannot be inspected' }
  }
  const verdict = forkChangeIsStripOnly({ root, base, protectedBranch, path, sets })
  if (!verdict.ok) return { rule: RULES.needsJudgment, detail: verdict.reason }
  return {
    rule: RULES.upstreamWinsRestrip,
    detail: `fork-side change is strip-only (${verdict.removed} removed / ${verdict.added} added line(s))`,
  }
}

/**
 * Test whether the policy strips a path, including localized documentation siblings.
 * @param {string} path Repository-relative path.
 * @param {object} sets Strip matching sets.
 * @returns {boolean} True when the strip deletes the path.
 */
export function isStrippedPath(path, sets) {
  if (sets.packagePaths.some(base => path === base || path.startsWith(`${base}/`))) return true
  if (sets.filePaths.includes(path)) return true
  for (const documented of sets.documentationPaths) {
    if (path === documented) return true
    if (!documented.endsWith('.md')) continue
    const stem = documented.slice(0, -3)
    if (path === `${stem}.i18n.yaml`) return true
    if (new RegExp(`^${escapeRegExp(stem)}\\.[A-Za-z]{2}(?:-[A-Za-z0-9]+)*\\.md$`).test(path)) return true
  }
  return false
}

/**
 * Test whether every line of the fork's own change to a path is strip-related.
 * @param {object} input Inspection inputs.
 * @param {string} input.root Repository root.
 * @param {string} input.base Merge base revision.
 * @param {string} input.protectedBranch Protected branch name.
 * @param {string} input.path Repository-relative path.
 * @param {object} input.sets Strip matching sets.
 * @returns {{ok: boolean, reason?: string, removed?: number, added?: number}} Verdict.
 */
function forkChangeIsStripOnly({ root, base, protectedBranch, path, sets }) {
  const diff = git(root, ['diff', '--unified=0', '--no-renames', base, protectedBranch, '--', path])
  if (diff.exitCode !== 0) return { ok: false, reason: `git diff failed: ${diff.stderr.trim()}` }
  const removed = []
  const added = []
  for (const line of diff.stdout.split('\n')) {
    if (/^(diff |index |--- |\+\+\+ |@@|new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue
    if (line.startsWith('-')) removed.push(line.slice(1))
    else if (line.startsWith('+')) added.push(line.slice(1))
  }
  if (removed.length === 0 && added.length === 0) {
    return { ok: false, reason: 'the fork changed nothing in this path, so upstream cannot be preferred' }
  }
  const normalise = text => text.replace(/[\s,]+$/, '')
  const remaining = [...removed]
  const extra = []
  for (const line of added) {
    const index = remaining.findIndex(candidate => normalise(candidate) === normalise(line))
    if (index === -1) extra.push(line)
    else remaining.splice(index, 1)
  }
  const offenders = [...remaining, ...extra].filter(line => line.trim() !== '' && !stripSurfaceMatch(line, sets))
  if (offenders.length > 0) {
    const sample = offenders[0].trim().slice(0, 100)
    return { ok: false, reason: `${offenders.length} fork-side line(s) are not strip-related, e.g. ${JSON.stringify(sample)}` }
  }
  return { ok: true, removed: removed.length, added: added.length }
}

/**
 * Resolve a path by deleting it, which is what the strip would do after merging.
 * @param {string} root Repository root.
 * @param {string} path Repository-relative path.
 * @returns {{ok: boolean, error?: string}} Applied result.
 */
function applyDelete(root, path) {
  const removed = git(root, ['rm', '-f', '--', path])
  return removed.exitCode === 0 ? { ok: true } : { ok: false, error: removed.stderr.trim() }
}

/**
 * Resolve a path by taking upstream's version and re-applying the strip later.
 * @param {string} root Repository root.
 * @param {string} path Repository-relative path.
 * @returns {{ok: boolean, error?: string}} Applied result.
 */
function applyTheirs(root, path) {
  const checkedOut = git(root, ['checkout', '--theirs', '--', path])
  if (checkedOut.exitCode !== 0) return { ok: false, error: checkedOut.stderr.trim() }
  const staged = git(root, ['add', '--', path])
  return staged.exitCode === 0 ? { ok: true } : { ok: false, error: staged.stderr.trim() }
}

/**
 * Find conflict marker lines that survived a resolution.
 * @param {string} root Repository root.
 * @param {string} path Repository-relative path.
 * @returns {number[]} One-based line numbers holding a marker.
 */
function conflictMarkers(root, path) {
  let text
  try {
    text = readFileSync(join(root, path), 'utf8')
  } catch {
    return []
  }
  const lines = []
  for (const [index, line] of text.split('\n').entries()) {
    if (MARKER.test(line)) lines.push(index + 1)
  }
  return lines
}

/**
 * Write the conflict stages of every unresolved path into the report directory.
 * @param {object} input Evidence inputs.
 * @param {string} input.root Repository root.
 * @param {string} input.date Run date.
 * @param {string} input.reportsDirectory Report directory from the policy.
 * @param {object[]} input.unresolved Unresolved conflict records.
 * @param {string} input.syncBranch Sync branch holding the merge.
 * @param {string} input.upstreamRef Upstream ref that was merged.
 * @returns {{files: string[], index: string}} Written evidence paths.
 */
function dumpEvidence({ root, date, reportsDirectory, unresolved, syncBranch, upstreamRef }) {
  const directory = join(root, reportsDirectory, `${date}-conflicts`)
  const files = []
  const index = []
  index.push(`# Unresolved merge conflicts ${date}`)
  index.push('')
  index.push('Every path below needs judgment: its fork-side change is not derivable from `fork/policy/core.json`.')
  index.push('The merge was aborted, so nothing was merged and the protected branch is untouched.')
  index.push('')
  index.push('To inspect a path with conflict markers restored:')
  index.push('')
  index.push('```sh')
  index.push(`git checkout ${syncBranch}`)
  index.push(`git merge ${upstreamRef}`)
  index.push('git checkout --merge -- <path>')
  index.push('```')
  index.push('')
  for (const entry of unresolved) {
    index.push(`## \`${entry.path}\``)
    index.push('')
    index.push(`- Stages present: ${entry.stages.join(', ')} (1 base, 2 ours, 3 theirs)`)
    index.push(`- Reason: ${entry.detail}`)
    for (const [stage, name] of [[1, 'base'], [2, 'ours'], [3, 'theirs']]) {
      if (!entry.stages.includes(stage)) {
        index.push(`- \`${name}\`: stage absent`)
        continue
      }
      const content = stageContent(root, stage, entry.path)
      const target = join(directory, `${entry.path}.${name}`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content === null ? `(stage ${stage} could not be read)\n` : content)
      const relative = `${reportsDirectory}/${date}-conflicts/${entry.path}.${name}`
      files.push(relative)
      index.push(`- \`${name}\`: \`${relative}\` (${content === null ? 0 : content.split('\n').length - 1} line(s))`)
    }
    index.push('')
  }
  mkdirSync(directory, { recursive: true })
  const indexPath = join(directory, 'index.md')
  writeFileSync(indexPath, `${index.join('\n')}\n`)
  return { files, index: `${reportsDirectory}/${date}-conflicts/index.md` }
}

/**
 * Assert that every path the fork added is still present after the sync.
 * @param {object} input Assertion inputs.
 * @param {string} input.root Repository root.
 * @param {(root: string, from: string, to: string) => string[]} input.listAdded Added-path lister.
 * @param {string|null} input.base Merge base revision.
 * @param {string} input.protectedBranch Protected branch name.
 * @returns {{checked: number, missing: string[], ok: boolean}} Assertion result.
 */
export function forkLocalPreserved({ root, listAdded, base, protectedBranch }) {
  if (base === null) return { checked: 0, missing: [], ok: true }
  const added = listAdded(root, base, protectedBranch)
  const missing = added.filter(path => !existsSync(join(root, path)))
  return { checked: added.length, missing, ok: missing.length === 0 }
}

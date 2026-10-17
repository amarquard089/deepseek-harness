// Durable run records for the upstream sync: one machine-readable JSON report,
// one human-reviewable Markdown report, and one append-only history line.
// Every run writes all three, including runs that stop during preflight, so a
// failed unattended run is always explainable after the fact.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Report schema version emitted by this module. */
export const SYNC_REPORT_SCHEMA = 'dsh-fork-sync-report/v1'

/** Characters kept from one captured command stream. */
const CAPTURE_LIMIT = 4000

/**
 * Create the report skeleton for one run.
 * @param {object} input Run identity.
 * @param {string} input.date Run date in `YYYY-MM-DD`.
 * @param {string} input.root Repository root.
 * @param {string[]} input.argv Process arguments after the script name.
 * @param {object} input.mode Parsed CLI mode flags.
 * @param {object} input.core Parsed `fork/policy/core.json`.
 * @returns {object} Mutable report.
 */
export function newSyncReport({ date, root, argv, mode, core }) {
  return {
    schema: SYNC_REPORT_SCHEMA,
    date,
    root,
    argv,
    mode,
    policyRevision: core.policyRevision ?? null,
    fork: core.fork,
    requiredGateIds: core.requiredGateIds ?? null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    protectedBranch: core.fork.protectedBranch,
    protectedSha: null,
    upstream: { remote: core.fork.upstreamRemote, branch: core.fork.upstreamBranch, ref: null, sha: null, newCommits: [] },
    preflight: [],
    backup: null,
    syncBranch: null,
    merge: null,
    strip: null,
    build: null,
    gates: [],
    untracked: [],
    finalAction: 'running',
    exitCode: null,
    notes: [],
    reproduce: [],
  }
}

/**
 * Record one preflight check outcome.
 * @param {object} report Run report.
 * @param {string} check Check identifier.
 * @param {'pass'|'fail'|'info'} status Check outcome.
 * @param {string} detail Evidence or remedy.
 * @returns {void}
 */
export function addCheck(report, check, status, detail) {
  report.preflight.push({ check, status, detail })
}

/**
 * Truncate a captured stream to the size the report keeps.
 * @param {string} text Captured output.
 * @returns {string} Head and tail of the output with an elision marker.
 */
export function capture(text) {
  const trimmed = (text ?? '').trim()
  if (trimmed.length <= CAPTURE_LIMIT) return trimmed
  const half = Math.floor(CAPTURE_LIMIT / 2)
  return `${trimmed.slice(0, half)}\n... [${trimmed.length - CAPTURE_LIMIT} characters elided] ...\n${trimmed.slice(-half)}`
}

/**
 * Write the JSON report, the Markdown report, and one history line.
 * @param {object} input Report output.
 * @param {string} input.root Repository root.
 * @param {object} input.report Finished run report.
 * @param {object} input.core Parsed `fork/policy/core.json`.
 * @returns {{jsonPath: string, markdownPath: string, historyPath: string}} Written paths, repository-relative.
 */
export function writeSyncReport({ root, report, core }) {
  const directory = join(root, core.reports.directory)
  mkdirSync(directory, { recursive: true })
  const jsonPath = join(directory, `${report.date}-sync.json`)
  const markdownPath = join(directory, `${report.date}-sync.md`)
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(markdownPath, renderMarkdown(report))
  const historyPath = join(root, 'fork/state/history.jsonl')
  mkdirSync(join(root, 'fork/state'), { recursive: true })
  appendFileSync(historyPath, `${JSON.stringify(historyLine(report))}\n`)
  pruneReports(directory, core.reports.retainDays, report.date)
  return {
    jsonPath: toRepoPath(root, jsonPath),
    markdownPath: toRepoPath(root, markdownPath),
    historyPath: toRepoPath(root, historyPath),
  }
}

/**
 * Render the human-reviewable report.
 * @param {object} report Finished run report.
 * @returns {string} Markdown report ending in one newline.
 */
export function renderMarkdown(report) {
  const lines = []
  lines.push(`# Upstream sync ${report.date}`)
  lines.push('')
  lines.push(`- Outcome: **${report.finalAction}** (exit ${report.exitCode})`)
  lines.push(`- Protected branch: \`${report.protectedBranch}\` at \`${short(report.protectedSha)}\``)
  lines.push(`- Upstream: \`${report.upstream.ref ?? 'unresolved'}\` at \`${short(report.upstream.sha)}\``)
  lines.push(`- Mode: ${describeMode(report.mode)}`)
  lines.push(`- Started: ${report.startedAt}`)
  lines.push(`- Finished: ${report.finishedAt}`)
  lines.push('')
  lines.push('## Upstream commits that arrived')
  lines.push('')
  if (report.upstream.newCommits.length === 0) {
    lines.push('None: the protected branch already contained every commit on the upstream branch.')
  } else {
    for (const commit of report.upstream.newCommits) lines.push(`- \`${short(commit.sha)}\` ${commit.subject}`)
  }
  lines.push('')
  lines.push('## Preflight')
  lines.push('')
  if (report.preflight.length === 0) lines.push('No check recorded.')
  for (const check of report.preflight) lines.push(`- ${check.status.toUpperCase()} \`${check.check}\` ${check.detail}`)
  lines.push('')
  lines.push('## Backup and sync branch')
  lines.push('')
  lines.push(`- Backup branch: ${report.backup === null ? 'not created' : `\`${report.backup.branch}\` at \`${short(report.backup.sha)}\`${report.backup.reused ? ' (existing branch at the same tip)' : ''}`}`)
  lines.push(`- Sync branch: ${report.syncBranch === null ? 'not created' : `\`${report.syncBranch.branch}\``}`)
  lines.push(`- Merge of upstream: ${report.merge === null ? 'not attempted' : report.merge.status}`)
  if (report.merge !== null && report.merge.conflictedPaths.length > 0) {
    lines.push(`- Conflicted paths (${report.merge.conflictedPaths.length}): ${report.merge.conflictedPaths.join(', ')}`)
  }
  if (report.merge !== null && (report.merge.resolutions ?? []).length > 0) {
    lines.push('')
    lines.push('| resolved path | rule | evidence |')
    lines.push('| --- | --- | --- |')
    for (const resolution of report.merge.resolutions) {
      lines.push(`| \`${resolution.path}\` | ${resolution.rule} | ${resolution.detail} |`)
    }
  }
  if (report.merge !== null && (report.merge.unresolved ?? []).length > 0) {
    lines.push('')
    lines.push(`### Conflicts that need judgment (${report.merge.unresolved.length})`)
    lines.push('')
    for (const entry of report.merge.unresolved) {
      lines.push(`- \`${entry.path}\` stages ${entry.stages.join(',')}: ${entry.detail}`)
    }
    if (report.merge.evidenceIndex !== null && report.merge.evidenceIndex !== undefined) {
      lines.push(`- Preserved stages: \`${report.merge.evidenceIndex}\``)
    }
  }
  if (report.requiredGateIds !== undefined && report.requiredGateIds !== null) {
    lines.push(`- Required gates from the policy: ${report.requiredGateIds.join(', ')}`)
  }
  if (report.forkLocalPreserved !== undefined && report.forkLocalPreserved !== null) {
    const preserved = report.forkLocalPreserved
    lines.push(
      `- Fork-added paths preserved: ${preserved.ok} (${preserved.checked} checked` +
        `${preserved.missing.length > 0 ? `, missing: ${preserved.missing.join(', ')}` : ''}` +
        `${preserved.reason ? `, ${preserved.reason}` : ''})`,
    )
  }
  if (report.merge !== null && (report.merge.untrackedConflicts ?? []).length > 0) {
    lines.push(
      `- Untracked paths that would be overwritten (${report.merge.untrackedConflicts.length}): ` +
        report.merge.untrackedConflicts.join(', '),
    )
  }
  lines.push('')
  lines.push('## What the strip removed')
  lines.push('')
  if (report.strip === null) {
    lines.push('The strip did not run.')
  } else {
    lines.push(
      `Deleted ${report.strip.deletions.length} path(s) / ${countDeletedFiles(report.strip)} file(s); ` +
        `edited ${report.strip.edits.length} file(s) / ${report.strip.changed} change(s).`,
    )
    for (const deletion of report.strip.deletions) {
      lines.push(`- deleted \`${deletion.path}\` (${deletion.files.length} file(s))`)
    }
    for (const edit of report.strip.edits) {
      lines.push(`- edited \`${edit.path}\` (${edit.changes.length} change(s))`)
    }
    if (report.strip.unhandled.length > 0) {
      lines.push('')
      lines.push(`### References the strip could not remove (${report.strip.unhandled.length})`)
      lines.push('')
      for (const issue of report.strip.unhandled) {
        lines.push(`- \`${issue.path}${issue.line ? `:${issue.line}` : ''}\` [${issue.layer}] ${issue.detail} — ${issue.remedy}`)
      }
    }
    if (report.strip.newResiduals.length > 0) {
      lines.push('')
      lines.push(`### Residual references outside the strip's surfaces (${report.strip.newResiduals.length})`)
      lines.push('')
      lines.push(
        'These are reported, not blocking: released Session fixtures and prose legitimately keep naming a ' +
          'retired package, and the static gate adjudicates them against its justified-residual policy.',
      )
      lines.push('')
      for (const residual of report.strip.newResiduals) {
        lines.push(`- \`${residual.path}\` ${residual.detail} (${residual.justification})`)
      }
    }
  }
  lines.push('')
  lines.push('## Gates')
  lines.push('')
  if (report.gates.length === 0) {
    lines.push('No gate ran.')
  } else {
    lines.push('| gate | required | exit | verdict | duration |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const gate of report.gates) {
      lines.push(`| ${gate.id} | ${gate.required} | ${gate.exitCode} | ${gate.verdict} | ${gate.durationMs} ms |`)
    }
    for (const gate of report.gates) {
      lines.push('')
      lines.push(`### Gate \`${gate.id}\` — ${gate.verdict}`)
      lines.push('')
      lines.push(`Command: \`${gate.command}\``)
      if (gate.reportPath !== null) lines.push(`Report: \`${gate.reportPath}\``)
      if (gate.stdoutTail) {
        lines.push('')
        lines.push('```')
        lines.push(gate.stdoutTail)
        lines.push('```')
      }
      if (gate.stderrTail) {
        lines.push('')
        lines.push('stderr:')
        lines.push('')
        lines.push('```')
        lines.push(gate.stderrTail)
        lines.push('```')
      }
    }
  }
  lines.push('')
  lines.push('## Final action')
  lines.push('')
  lines.push(`${report.finalAction} (exit ${report.exitCode})`)
  if (report.strip !== null && report.strip.residualPolicy !== undefined) {
    const policy = report.strip.residualPolicy
    lines.push('')
    lines.push(
      `Strip surfaces clean: ${report.strip.surfacesClean}; unhandled on those surfaces: ${policy.unhandled}; ` +
        `residual references adjudicated by \`${policy.adjudicatedBy}\`: ${policy.newResiduals} new, ` +
        `${policy.preExistingResiduals} already on the protected branch.`,
    )
  }
  if (report.build !== null) {
    lines.push('')
    lines.push(`Build: \`${report.build.command}\` exit ${report.build.exitCode}` + (report.build.logPath ? `, log \`${report.build.logPath}\`` : ''))
  }
  if (report.notes.length > 0) {
    lines.push('')
    lines.push('## Notes')
    lines.push('')
    for (const note of report.notes) lines.push(`- ${note}`)
  }
  if (report.reproduce.length > 0) {
    lines.push('')
    lines.push('## Reproduce')
    lines.push('')
    for (const command of report.reproduce) lines.push(`- \`${command}\``)
  }
  lines.push('')
  lines.push(`Artifact: \`fork/reports/${report.date}-sync.json\``)
  lines.push('')
  return lines.join('\n')
}

/**
 * Build the append-only history record for one run.
 * @param {object} report Finished run report.
 * @returns {object} One-line history record.
 */
export function historyLine(report) {
  return {
    date: report.date,
    finishedAt: report.finishedAt,
    exitCode: report.exitCode,
    finalAction: report.finalAction,
    protectedSha: report.protectedSha,
    upstreamSha: report.upstream.sha,
    newCommits: report.upstream.newCommits.length,
    stripChanges: report.strip === null ? null : report.strip.changed,
    stripUnhandled: report.strip === null ? null : report.strip.unhandled.length,
    stripNewResiduals: report.strip === null ? null : report.strip.newResiduals.length,
    gates: Object.fromEntries(report.gates.map(gate => [gate.id, gate.verdict])),
    syncBranch: report.syncBranch === null ? null : report.syncBranch.branch,
    report: `fork/reports/${report.date}-sync.json`,
  }
}

/**
 * Build the command that re-runs the gates of a failed run for review.
 * @param {object} core Parsed `fork/policy/core.json`.
 * @param {string} branch Sync branch holding the prepared sync.
 * @returns {string[]} Review commands.
 */
export function reproduceCommands(core, branch) {
  return [`git checkout ${branch || '<sync branch>'}`, ...core.gates.map(gate => gate.command)]
}

/**
 * Describe the CLI mode for the report header.
 * @param {object} mode Parsed CLI mode flags.
 * @returns {string} One-line description.
 */
function describeMode(mode) {
  const active = []
  if (mode.dryRun) active.push('dry-run')
  if (mode.noMerge) active.push('no-merge')
  if (mode.noPush) active.push('no-push')
  if (mode.skipBuild) active.push('skip-build')
  return active.length === 0 ? 'full run' : active.join(', ')
}

/**
 * Count the files a strip deleted.
 * @param {object} strip Strip result recorded on the report.
 * @returns {number} File count.
 */
function countDeletedFiles(strip) {
  return strip.deletions.reduce((total, deletion) => total + deletion.files.length, 0)
}

/**
 * Shorten a commit id for prose.
 * @param {string|null} sha Full commit id.
 * @returns {string} Nine-character prefix, or `unknown`.
 */
function short(sha) {
  return sha === null ? 'unknown' : sha.slice(0, 9)
}

/**
 * Delete sync reports older than the retention window.
 * @param {string} directory Absolute report directory.
 * @param {number} retainDays Retention window in days.
 * @param {string} today Run date in `YYYY-MM-DD`.
 * @returns {string[]} Removed file names.
 */
function pruneReports(directory, retainDays, today) {
  const cutoff = Date.parse(`${today}T00:00:00Z`) - retainDays * 24 * 60 * 60 * 1000
  const removed = []
  for (const name of readdirSync(directory)) {
    if (!/^\d{4}-\d{2}-\d{2}-sync\.(json|md)$/.test(name) && !/^\d{4}-\d{2}-\d{2}-build\.log$/.test(name)) continue
    const absolute = join(directory, name)
    const date = name.slice(0, 10)
    const modified = Date.parse(`${date}T00:00:00Z`)
    const timestamp = Number.isNaN(modified) ? statSync(absolute).mtimeMs : modified
    if (!existsSync(absolute) || timestamp >= cutoff) continue
    unlinkSync(absolute)
    removed.push(name)
  }
  return removed
}

/**
 * Convert an absolute path to a slash-separated repository-relative path.
 * @param {string} root Repository root.
 * @param {string} absolute Absolute path.
 * @returns {string} Repository-relative path.
 */
function toRepoPath(root, absolute) {
  return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute
}

/**
 * Read a previously written sync report.
 * @param {string} root Repository root.
 * @param {string} date Run date in `YYYY-MM-DD`.
 * @returns {object|null} Parsed report, or null when absent.
 */
export function readSyncReport(root, date) {
  const path = join(root, 'fork/reports', `${date}-sync.json`)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

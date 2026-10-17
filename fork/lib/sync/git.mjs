// Non-interactive git access for the unattended upstream sync.
// Every call disables prompting, paging, and optional lock taking so a scheduled
// run can never block on stdin, and every result keeps its exact argv, exit code,
// and captured output for the run report.

import { spawnSync } from 'node:child_process'

/** Hard ceiling for one git invocation; a stalled fetch is an error, not a hang. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/** Child-process environment that keeps git non-interactive and byte-stable. */
const GIT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  SSH_ASKPASS: 'echo',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
})

/**
 * Run one git command and capture everything the report needs.
 * @param {string} root Repository root used as the working directory.
 * @param {string[]} args Arguments after the `git` executable.
 * @param {{timeoutMs?: number}} [options] Per-call timeout override.
 * @returns {{args: string[], command: string, exitCode: number, stdout: string, stderr: string, error: string|null, durationMs: number}} Captured result.
 */
export function git(root, args, options = {}) {
  const startedAt = Date.now()
  const result = spawnSync('git', args, {
    cwd: root,
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  return {
    args,
    command: ['git', ...args].join(' '),
    exitCode: result.status === null ? 124 : result.status,
    stdout,
    stderr,
    error: result.error ? `${result.error.code ?? 'ERROR'}: ${result.error.message}` : null,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Run one git command that must succeed.
 * @param {string} root Repository root.
 * @param {string[]} args Arguments after the `git` executable.
 * @param {{timeoutMs?: number}} [options] Per-call timeout override.
 * @returns {ReturnType<typeof git>} Captured result of a successful call.
 * @throws {Error} When git exits non-zero, naming the command and its stderr tail.
 */
export function gitOk(root, args, options = {}) {
  const result = git(root, args, options)
  if (result.exitCode !== 0) {
    const tail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-5).join('\n')
    throw new Error(`${result.command} failed with exit ${result.exitCode}: ${tail}`)
  }
  return result
}

/**
 * Read the checked-out branch name.
 * @param {string} root Repository root.
 * @returns {string} Branch name, or `HEAD` when the checkout is detached.
 */
export function currentBranch(root) {
  return gitOk(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
}

/**
 * Resolve a revision to a full commit id.
 * @param {string} root Repository root.
 * @param {string} ref Revision to resolve.
 * @returns {string|null} Full commit id, or null when the revision is unknown.
 */
export function revParse(root, ref) {
  const result = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return result.exitCode === 0 ? result.stdout.trim() : null
}

/**
 * List worktree and index changes to tracked files.
 * @param {string} root Repository root.
 * @returns {string[]} Porcelain status lines, empty for a clean tree.
 */
export function trackedChanges(root) {
  const result = gitOk(root, ['status', '--porcelain', '--untracked-files=no'])
  return result.stdout.split('\n').filter(line => line.trim() !== '')
}

/**
 * List untracked-but-not-ignored paths, reported for review rather than blocking.
 * @param {string} root Repository root.
 * @returns {string[]} Porcelain status lines for untracked paths.
 */
export function untrackedEntries(root) {
  const result = gitOk(root, ['status', '--porcelain', '--untracked-files=normal'])
  return result.stdout.split('\n').filter(line => line.startsWith('??'))
}

/**
 * Check whether a named remote exists.
 * @param {string} root Repository root.
 * @param {string} name Remote name.
 * @returns {boolean} True when the remote is configured.
 */
export function remoteExists(root, name) {
  const result = git(root, ['remote'])
  return result.exitCode === 0 && result.stdout.split('\n').includes(name)
}

/**
 * Check whether a local branch exists.
 * @param {string} root Repository root.
 * @param {string} name Branch name.
 * @returns {boolean} True when `refs/heads/<name>` resolves.
 */
export function branchExists(root, name) {
  return git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).exitCode === 0
}

/**
 * List local branch names.
 * @param {string} root Repository root.
 * @returns {string[]} Short branch names.
 */
export function localBranches(root) {
  const result = gitOk(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  return result.stdout.split('\n').filter(line => line.trim() !== '')
}

/**
 * Resolve a path inside the repository's git directory.
 * @param {string} root Repository root.
 * @param {string} name Path name relative to the git directory.
 * @returns {string} Absolute path inside the git directory.
 */
export function gitPath(root, name) {
  return gitOk(root, ['rev-parse', '--git-path', name]).stdout.trim()
}

/**
 * List the paths left unmerged by an in-progress merge.
 * @param {string} root Repository root.
 * @returns {string[]} Repository-relative conflicted paths.
 */
export function conflictedPaths(root) {
  const result = git(root, ['diff', '--name-only', '--diff-filter=U'])
  return result.exitCode === 0 ? result.stdout.split('\n').filter(line => line.trim() !== '') : []
}

/**
 * List the commits reachable from `to` but not from `from`, newest first.
 * @param {string} root Repository root.
 * @param {string} from Excluded revision.
 * @param {string} to Included revision.
 * @returns {Array<{sha: string, subject: string}>} Commit summary rows.
 */
export function commitsBetween(root, from, to) {
  const result = git(root, ['log', '--format=%H%x09%s', `${from}..${to}`])
  if (result.exitCode !== 0) return []
  return result.stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const [sha, subject = ''] = line.split('\t')
      return { sha, subject }
    })
}

/**
 * Count commits on each side of a revision pair.
 * @param {string} root Repository root.
 * @param {string} left Left revision.
 * @param {string} right Right revision.
 * @returns {{ahead: number, behind: number}} Commits only in `left`, and only in `right`.
 */
export function divergence(root, left, right) {
  const result = git(root, ['rev-list', '--left-right', '--count', `${left}...${right}`])
  if (result.exitCode !== 0) return { ahead: 0, behind: 0 }
  const [ahead = '0', behind = '0'] = result.stdout.trim().split(/\s+/)
  return { ahead: Number(ahead), behind: Number(behind) }
}

/**
 * Resolve the common ancestor of two revisions.
 * @param {string} root Repository root.
 * @param {string} left Left revision.
 * @param {string} right Right revision.
 * @returns {string|null} Merge base commit id, or null when the histories are unrelated.
 */
export function mergeBase(root, left, right) {
  const result = git(root, ['merge-base', left, right])
  return result.exitCode === 0 ? result.stdout.trim() : null
}

/**
 * List the paths one revision adds relative to another.
 * @param {string} root Repository root.
 * @param {string} from Excluded revision.
 * @param {string} to Included revision.
 * @returns {string[]} Repository-relative added paths.
 */
export function addedPaths(root, from, to) {
  const result = git(root, ['diff', '--name-only', '--diff-filter=A', '--no-renames', from, to])
  return result.exitCode === 0 ? result.stdout.split('\n').filter(line => line !== '') : []
}

/**
 * List the paths one revision adds relative to another, keeping the failure apart
 * from the empty result so a caller never reports a pass it did not prove.
 * @param {string} root Repository root.
 * @param {string} from Excluded revision.
 * @param {string} to Included revision.
 * @returns {{ok: boolean, paths: string[], detail: string}} Listed paths or the reason listing failed.
 */
export function addedPathsChecked(root, from, to) {
  const result = git(root, ['diff', '--name-only', '--diff-filter=A', '--no-renames', from, to])
  if (result.exitCode !== 0) {
    return { ok: false, paths: [], detail: `${result.command} exited ${result.exitCode}: ${result.stderr.trim()}` }
  }
  return { ok: true, paths: result.stdout.split('\n').filter(line => line !== ''), detail: result.command }
}

/**
 * List the unmerged index entries of a conflicted merge.
 * @param {string} root Repository root.
 * @returns {Array<{path: string, stages: number[]}>} Conflicted paths with the stages that exist.
 */
export function unmergedEntries(root) {
  const result = git(root, ['ls-files', '-u', '-z'])
  if (result.exitCode !== 0) return []
  const entries = new Map()
  for (const record of result.stdout.split('\0')) {
    if (record === '') continue
    const [meta, path] = record.split('\t')
    if (path === undefined) continue
    const stage = Number(meta.trim().split(/\s+/)[2])
    if (!entries.has(path)) entries.set(path, new Set())
    entries.get(path).add(stage)
  }
  return [...entries].map(([path, stages]) => ({ path, stages: [...stages].sort() }))
}

/**
 * Read one stage of a conflicted path.
 * @param {string} root Repository root.
 * @param {number} stage Index stage: 1 base, 2 ours, 3 theirs.
 * @param {string} path Repository-relative path.
 * @returns {string|null} Stage content, or null when that stage does not exist.
 */
export function stageContent(root, stage, path) {
  const result = git(root, ['show', `:${stage}:${path}`])
  return result.exitCode === 0 ? result.stdout : null
}

/**
 * Enumerate tracked files, which is the surface the strip may rewrite.
 * @param {string} root Repository root.
 * @returns {string[]} Repository-relative tracked paths, sorted.
 */
export function trackedFiles(root) {
  const result = git(root, ['ls-files', '-z', '--cached'])
  if (result.exitCode !== 0) throw new Error(`${result.command} failed: ${result.stderr.trim()}`)
  return result.stdout.split('\0').filter(path => path !== '').sort()
}

// Deterministic re-application of the fork's telemetry strip, driven by
// fork/policy/core.json rather than by a checked-in patch.
//
// The strip owns six surfaces:
//   1. the deleted package and documentation paths from the policy, plus the
//      localized siblings of each documented page,
//   2. dependency manifests (`package.json` dependency sections),
//   3. `tsconfig*.json` path mappings,
//   4. cordis composition files (plugin entries, matched by package name or by
//      the plugin id derived from it),
//   5. the generated catalogs `apps/cli/composition.md` and
//      `scripts/gen-cordis-catalog.ts`,
//   6. `<!-- BEGIN GENERATED ... -->` regions, whole when the region is keyed by
//      a removed package and line-wise when a row names one.
// Prose and other generated files that still mention the removed surface are
// reported as residual references. A reference the protected branch does not
// already carry is one the strip could not remove, so the caller must not treat
// the tree as stripped.
//
// Every edit is line-scoped and validated (JSON files must still parse), which
// keeps a second run byte-identical: the second run finds nothing to change.

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'

import { git, trackedFiles } from './git.mjs'

/** Generated catalogs whose line rules the strip owns, keyed by repository path. */
const CATALOG_KINDS = Object.freeze({
  'apps/cli/composition.md': 'composition',
  'scripts/gen-cordis-catalog.ts': 'catalog',
})

/** Marker wrapper of generated documentation regions. */
const GENERATED_BEGIN = /^<!-- BEGIN GENERATED ([^\s:>]+):(\S+) -->$/
const GENERATED_END = /^<!-- END GENERATED ([^\s:>]+):(\S+) -->$/

/** Matcher for cordis composition file names (`cordis.yml`, `x.cordis.patch.yml`). */
const CORDIS_FILE = /^(?:.*\.)?cordis(?:\.[a-z]+)*\.(?:yml|yaml)$/

/**
 * Derive every matching rule the strip needs from the frozen policy.
 * @param {object} core Parsed `fork/policy/core.json`.
 * @returns {{packagePaths: string[], documentationPaths: string[], filePaths: string[], packageNames: string[], pluginIds: string[], distinctiveIds: string[], docBases: string[]}} Matching sets.
 */
export function deriveStripSets(core) {
  const trim = value => String(value).replace(/\/+$/, '')
  const packagePaths = core.strippedPackagePaths.map(trim)
  const documentationPaths = core.strippedDocumentationPaths.map(trim)
  const filePaths = (core.strippedFilePaths ?? []).map(trim)
  const packageNames = [...core.strippedPackageNames]
  const pluginIds = new Set()
  for (const name of packageNames) {
    const scoped = name.replace(/^@[^/]+\//, '')
    pluginIds.add(scoped)
    pluginIds.add(scoped.replace(/^dsh-/, ''))
  }
  for (const path of packagePaths) pluginIds.add(basename(path))
  const ids = [...pluginIds].sort()
  return {
    packagePaths,
    documentationPaths,
    filePaths,
    packageNames,
    pluginIds: ids,
    distinctiveIds: ids.filter(id => id.includes('-')),
    docBases: documentationPaths.map(path => basename(path)),
  }
}

/**
 * Every policy path plus the localized siblings of each documented page.
 * @param {string} root Repository root.
 * @param {string[]} documentationPaths Documented paths from the policy.
 * @returns {string[]} Sorted repository-relative deletion targets.
 */
export function deletionTargets(root, documentationPaths) {
  const targets = new Set(documentationPaths)
  for (const relativePath of documentationPaths) {
    if (!relativePath.endsWith('.md')) continue
    const directory = join(root, dirname(relativePath))
    if (!existsSync(directory)) continue
    const stem = basename(relativePath).replace(/\.md$/, '')
    const sibling = new RegExp(`^${escapeRegExp(stem)}\\.(i18n\\.yaml|[A-Za-z]{2}(?:-[A-Za-z0-9]+)*\\.md)$`)
    for (const entry of readdirSync(directory)) {
      if (sibling.test(entry)) targets.add(`${dirname(relativePath)}/${entry}`.replace(/^\.\//, ''))
    }
  }
  return [...targets].sort()
}

/**
 * Re-apply the telemetry strip to a working tree.
 * @param {object} options Strip inputs.
 * @param {string} options.root Repository root holding the tree to strip.
 * @param {object} options.core Parsed `fork/policy/core.json`.
 * @param {boolean} [options.dryRun] Report the changes without writing them.
 * @param {string|null} [options.baselineRef] Revision that already carries the fork's accepted residual references, used to separate pre-existing references from new ones.
 * @returns {{dryRun: boolean, baselineRef: string|null, deletions: object[], edits: object[], unhandled: object[], residuals: object[], newResiduals: object[], changed: number, filesChanged: number, clean: boolean}} Strip result.
 */
export function applyStrip({ root, core, dryRun = false, baselineRef = null }) {
  const sets = deriveStripSets(core)
  const result = {
    dryRun,
    baselineRef,
    deletions: [],
    edits: [],
    unhandled: [],
    residuals: [],
    newResiduals: [],
    changed: 0,
    filesChanged: 0,
    clean: true,
  }
  // Plan every write before performing any of them: a failure while planning
  // leaves the tree untouched, so a crashed run never leaves a half-stripped tree.
  const deleted = new Set()
  const deletions = []
  const targets = [
    ...new Set([...deletionTargets(root, sets.documentationPaths), ...sets.packagePaths, ...sets.filePaths]),
  ].sort()
  for (const target of targets) {
    const absolute = join(root, target)
    if (!existsSync(absolute)) continue
    const stats = lstatSync(absolute)
    const isDirectory = stats.isDirectory()
    const files = isDirectory ? listFiles(absolute).map(path => toRepoPath(root, path)) : [target]
    for (const file of files) deleted.add(file)
    deletions.push({ path: target, kind: isDirectory ? 'directory' : 'file', files })
    result.changed += files.length
  }

  const baselineText = makeBaselineReader(root, baselineRef)
  const edits = []
  for (const relativePath of trackedFiles(root)) {
    if (deleted.has(relativePath)) continue
    if (sets.packagePaths.some(packagePath => relativePath.startsWith(`${packagePath}/`))) continue
    const absolute = join(root, relativePath)
    if (!isRegularFile(absolute)) continue
    const text = readFileSync(absolute, 'utf8')
    const kind = managedKind(relativePath, text)
    if (kind === null) {
      collectResidual(relativePath, text, sets, baselineText, result, null)
      continue
    }
    const outcome = stripManaged({ kind, relativePath, text, sets })
    for (const refused of outcome.refused) {
      result.unhandled.push({
        path: relativePath,
        layer: kind,
        detail: `refused to rewrite member ${refused}`,
        remedy: 'remove that entry by hand and re-run the strip; the strip never guesses at an ambiguous layout',
      })
    }
    if (outcome.text !== text) {
      edits.push({ path: relativePath, kind, changes: outcome.changes, text: outcome.text })
      result.changed += outcome.changes.length
    }
    for (const leftover of leftoverReferences(outcome.text, kind, sets)) {
      result.unhandled.push({
        path: relativePath,
        line: leftover.line,
        layer: kind,
        detail: `unremoved reference to ${leftover.token}`,
        remedy: 'remove the reference by hand and re-run the strip, or extend the matching rule for this layer',
      })
    }
    collectResidual(relativePath, outcome.text, sets, baselineText, result, kind)
  }

  if (!dryRun) {
    for (const deletion of deletions) rmSync(join(root, deletion.path), { recursive: true, force: true })
    for (const edit of edits) writeFileSync(join(root, edit.path), edit.text)
  }
  result.deletions = deletions
  result.edits = edits.map(({ path, kind, changes }) => ({ path, kind, changes }))
  result.filesChanged = result.deletions.length + result.edits.length
  result.clean = result.unhandled.length === 0 && result.newResiduals.length === 0
  return result
}

/**
 * Print one line per deletion and edit, then a summary.
 * @param {object} outcome Result of `applyStrip`.
 * @param {{write?: (line: string) => void}} [sink] Output sink; defaults to stdout.
 * @returns {number} Number of reported changes.
 */
export function printStripOutcome(outcome, sink = { write: line => console.log(line) }) {
  let lines = 0
  for (const deletion of outcome.deletions) {
    for (const file of deletion.files) {
      sink.write(`deleted ${file}`)
      lines += 1
    }
  }
  for (const edit of outcome.edits) {
    for (const change of edit.changes) {
      sink.write(`edited ${edit.path}:${change.line} ${change.detail}`)
      lines += 1
    }
  }
  for (const issue of outcome.unhandled) {
    sink.write(`unhandled ${issue.line ? `${issue.path}:${issue.line}` : issue.path} [${issue.layer}] ${issue.detail}`)
  }
  for (const residual of outcome.newResiduals) {
    sink.write(`new-reference ${residual.path} ${residual.detail}`)
  }
  sink.write(
    `${outcome.dryRun ? 'dry-run' : 'applied'}: changed=${outcome.changed} files=${outcome.filesChanged} ` +
      `unhandled=${outcome.unhandled.length} newReferences=${outcome.newResiduals.length} ` +
      `preExistingResiduals=${outcome.residuals.length}`,
  )
  return lines
}

/**
 * Classify a tracked file into the surface the strip may rewrite.
 * @param {string} relativePath Repository-relative path.
 * @param {string} text File text.
 * @returns {string|null} Managed layer name, or null when the strip only scans the file for residual references.
 */
function managedKind(relativePath, text) {
  const catalog = CATALOG_KINDS[relativePath]
  if (catalog !== undefined) return catalog
  const name = basename(relativePath)
  if (name === 'package.json') return 'manifest'
  if (/^tsconfig.*\.json$/.test(name)) return 'tsconfig'
  if (CORDIS_FILE.test(name)) return 'cordis'
  if (relativePath.endsWith('.md') && text.includes('<!-- BEGIN GENERATED ')) return 'generated'
  return null
}

/**
 * Apply the line rules of one managed layer.
 * @param {{kind: string, relativePath: string, text: string, sets: object}} input File text and its layer.
 * @returns {{text: string, changes: object[], refused: string[]}} Rewritten text, changes, and refused member keys.
 */
function stripManaged({ kind, relativePath, text, sets }) {
  switch (kind) {
    case 'manifest':
      return stripManifest(text, sets)
    case 'tsconfig':
      return stripTsconfig(text, sets)
    case 'cordis':
      return stripCordis(text, sets)
    case 'composition':
      return stripComposition(text, sets)
    case 'catalog':
      return stripCatalog(text, sets)
    case 'generated':
      return stripGeneratedRegions(text, sets)
    default:
      throw new Error(`unknown strip layer for ${relativePath}: ${kind}`)
  }
}

/**
 * Remove dependency entries naming a stripped package.
 * @param {string} text Manifest text.
 * @param {object} sets Strip matching sets.
 * @returns {{text: string, changes: object[], refused: string[]}} Rewritten text and changes.
 */
function stripManifest(text, sets) {
  const parsed = parseJson(text)
  const dependents = parsed === null ? null : dependencyKeys(parsed)
  return removeJsonLines(
    text,
    ({ key }) => sets.packageNames.includes(key) && (dependents === null || dependents.has(key)),
  )
}

/**
 * Remove `paths` mappings naming a stripped package or one of its subpaths.
 * @param {string} text tsconfig text.
 * @param {object} sets Strip matching sets.
 * @returns {{text: string, changes: object[], refused: string[]}} Rewritten text and changes.
 */
function stripTsconfig(text, sets) {
  return removeJsonLines(
    text,
    ({ key, line }) =>
      sets.packageNames.some(name => key === name || key.startsWith(`${name}/`)) ||
      mentionsStrippedArtifact(line, sets),
  )
}

/**
 * Remove the JSON members a predicate selects. A member is one single-line
 * member, one single-line object, or one multi-line object whose only property
 * is `path` (a TypeScript project reference).
 * The rewrite keeps every other byte, then proves the file still parses when it
 * parsed before, so an unexpected layout becomes a reported failure rather than
 * a corrupted manifest.
 * @param {string} text JSON or JSON-with-comments text.
 * @param {(member: {key: string, line: string, number: number}) => boolean} select Predicate over a candidate member.
 * @returns {{text: string, changes: object[], refused: string[]}} Rewritten text and changes.
 */
function removeJsonLines(text, select) {
  const lines = text.split('\n')
  const candidates = []
  for (let index = 0; index < lines.length; index += 1) {
    const block = /^\s*\{\s*$/.test(lines[index])
    if (block) {
      const property = /^\s*"path"\s*:\s*"[^"]*"\s*$/.exec(lines[index + 1] ?? '')
      const closing = /^\s*\}\s*,?\s*$/.test(lines[index + 2] ?? '')
      if (property !== null && closing && select({ key: 'path', line: property[0], number: index + 2 })) {
        candidates.push({ start: index, end: index + 2, key: 'path', line: index + 1 })
        index += 2
        continue
      }
    }
    const member = /^\s*"([^"]+)"\s*:/.exec(lines[index])
    if (member !== null && select({ key: member[1], line: lines[index], number: index + 1 })) {
      candidates.push({ start: index, end: index, key: member[1], line: index + 1 })
      continue
    }
    const element = /^\s*"[^"]*"\s*,?\s*$/.test(lines[index])
    if (
      (element || /^\s*\{.*\}\s*,?\s*$/.test(lines[index])) &&
      select({ key: '', line: lines[index], number: index + 1 })
    ) {
      candidates.push({ start: index, end: index, key: '', line: index + 1 })
    }
  }
  if (candidates.length === 0) return { text, changes: [], refused: [] }
  const counts = new Map()
  for (const candidate of candidates) {
    if (candidate.key === '') continue
    counts.set(candidate.key, (counts.get(candidate.key) ?? 0) + 1)
  }
  const repeated = [...counts].filter(([, count]) => count > 1).map(([key]) => key)
  if (repeated.length > 0) return { text, changes: [], refused: repeated }
  const rewritten = [...lines]
  const changes = []
  for (const candidate of [...candidates].sort((left, right) => right.start - left.start)) {
    const hadComma = /,\s*$/.test(rewritten[candidate.end])
    const label = candidate.key === '' ? 'reference to a deleted artifact' : `entry ${candidate.key}`
    rewritten.splice(candidate.start, candidate.end - candidate.start + 1)
    if (!hadComma) dropTrailingComma(rewritten, candidate.start)
    changes.push({ line: candidate.line, detail: `removed ${label}` })
  }
  const next = rewritten.join('\n')
  if (parseJson(text) !== null && parseJson(next) === null) {
    return { text, changes: [], refused: candidates.map(candidate => candidate.key || 'deleted artifact reference') }
  }
  return { text: next, changes, refused: [] }
}

/**
 * Remove the comma a deleted final member left dangling.
 * @param {string[]} lines Working lines.
 * @param {number} fromIndex Index the member occupied.
 * @returns {void}
 */
function dropTrailingComma(lines, fromIndex) {
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === '') continue
    if (/,\s*$/.test(lines[index])) lines[index] = lines[index].replace(/,\s*$/, '')
    return
  }
}

/**
 * Remove cordis plugin entries that mount or name a stripped package.
 * @param {string} text Composition file text.
 * @param {object} sets Strip matching sets.
 * @returns {{text: string, changes: object[], refused: string[]}} Rewritten text and changes.
 */
function stripCordis(text, sets) {
  const lines = text.split('\n')
  const remove = new Set()
  const changes = []
  for (let index = 0; index < lines.length; index += 1) {
    const item = /^(\s*)-\s+id:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(lines[index])
    let start = null
    let indent = 0
    let detail = null
    if (item !== null && sets.pluginIds.includes(item[2])) {
      start = index
      indent = item[1].length
      detail = `removed plugin entry id: ${item[2]}`
    } else {
      const token = firstMention(lines[index], sets)
      const enclosing = token === null ? null : findItemStart(lines, index)
      if (enclosing !== null) {
        start = enclosing
        indent = indentOf(lines[enclosing])
        detail = `removed plugin entry naming ${token}`
      }
    }
    if (start === null || remove.has(start)) continue
    let blockStart = start
    while (blockStart - 1 >= 0 && /^\s*#/.test(lines[blockStart - 1]) && indentOf(lines[blockStart - 1]) >= indent) {
      blockStart -= 1
    }
    let blockEnd = start + 1
    while (blockEnd < lines.length && (lines[blockEnd].trim() === '' || indentOf(lines[blockEnd]) > indent)) {
      blockEnd += 1
    }
    if (
      blockStart - 1 >= 0 &&
      lines[blockStart - 1].trim() === '' &&
      blockEnd < lines.length &&
      lines[blockEnd].trim() === ''
    ) {
      blockStart -= 1
    }
    for (let line = blockStart; line < blockEnd; line += 1) remove.add(line)
    changes.push({ line: start + 1, detail })
  }
  if (remove.size === 0) return { text, changes: [], refused: [] }
  return { text: lines.filter((_, index) => !remove.has(index)).join('\n'), changes, refused: [] }
}

/**
 * Remove generated composition lines that name a stripped package or its nodes.
 * @param {string} text `apps/cli/composition.md` text.
 * @param {object} sets Strip matching sets.
 * @returns {{text: string, changes: object[], refused: string[]}} Rewritten text and changes.
 */
function stripComposition(text, sets) {
  return dropLines(text, line => {
    const token = firstMention(line, sets)
    if (token !== null) return `removed composition entry naming ${token}`
    const id = nodeMention(line, sets)
    return id === null ? null : `removed composition node for ${id}`
  })
}

/**
 * Remove generator table rows that name a stripped package path or removed page.
 * @param {string} text `scripts/gen-cordis-catalog.ts` text.
 * @param {object} sets Strip matching sets.
 * @returns {{text: string, changes: object[], refused: string[]}} Rewritten text and changes.
 */
function stripCatalog(text, sets) {
  return dropLines(text, line => {
    const token = firstMention(line, sets)
    if (token !== null) return `removed catalog row naming ${token}`
    const page = pageMention(line, sets)
    return page === null ? null : `removed catalog row linking the removed page ${page}`
  })
}

/**
 * Remove generated documentation regions that name a stripped package, and rows
 * naming one inside the regions that remain.
 * @param {string} text Markdown text.
 * @param {object} sets Strip matching sets.
 * @returns {{text: string, changes: object[], refused: string[]}} Rewritten text and changes.
 */
function stripGeneratedRegions(text, sets) {
  const lines = text.split('\n')
  const kept = []
  const changes = []
  let index = 0
  while (index < lines.length) {
    const begin = GENERATED_BEGIN.exec(lines[index])
    if (begin === null) {
      const node = nodeMention(lines[index], sets)
      const mermaid = /(?:subgraph|-->|pkg_|\[")/.test(lines[index]) && mentionsStrippedArtifact(lines[index], sets)
      if (node !== null) changes.push({ line: index + 1, detail: `removed generated graph node for ${node}` })
      else if (mermaid) {
        changes.push({ line: index + 1, detail: `removed generated graph line naming ${firstMention(lines[index], sets)}` })
      } else kept.push(lines[index])
      index += 1
      continue
    }
    let end = index + 1
    while (end < lines.length) {
      const closing = GENERATED_END.exec(lines[end])
      if (closing !== null && closing[1] === begin[1] && closing[2] === begin[2]) break
      end += 1
    }
    if (end >= lines.length) {
      kept.push(lines[index])
      index += 1
      continue
    }
    if (firstMention(begin[2], sets) !== null) {
      changes.push({ line: index + 1, detail: `removed generated ${begin[1]} region for ${begin[2]}` })
      index = end + 1
      continue
    }
    kept.push(lines[index])
    for (let line = index + 1; line < end; line += 1) {
      const token = firstMention(lines[line], sets)
      if (token === null) kept.push(lines[line])
      else changes.push({ line: line + 1, detail: `removed generated ${begin[1]} row naming ${token}` })
    }
    kept.push(lines[end])
    index = end + 1
  }
  return { text: kept.join('\n'), changes, refused: [] }
}

/**
 * Drop every line the predicate explains.
 * @param {string} text File text.
 * @param {(line: string) => string|null} explain Reason to drop a line, or null to keep it.
 * @returns {{text: string, changes: object[], refused: string[]}} Rewritten text and changes.
 */
function dropLines(text, explain) {
  const lines = text.split('\n')
  const kept = []
  const changes = []
  for (let index = 0; index < lines.length; index += 1) {
    const reason = explain(lines[index])
    if (reason === null) kept.push(lines[index])
    else changes.push({ line: index + 1, detail: reason })
  }
  return { text: kept.join('\n'), changes, refused: [] }
}

/**
 * Report references the strip failed to remove from the surface it owns.
 * @param {string} text Rewritten file text.
 * @param {string} kind Managed layer name.
 * @param {object} sets Strip matching sets.
 * @returns {Array<{line: number, token: string}>} Leftover references.
 */
function leftoverReferences(text, kind, sets) {
  const leftovers = []
  const lines = text.split('\n')
  let insideGenerated = false
  for (let index = 0; index < lines.length; index += 1) {
    if (kind === 'generated' && GENERATED_BEGIN.test(lines[index])) insideGenerated = true
    const scoped = kind !== 'generated' || insideGenerated
    if (scoped) {
      if (kind === 'cordis') {
        const item = /^(\s*)-\s+id:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(lines[index])
        if (item !== null && sets.pluginIds.includes(item[2])) {
          leftovers.push({ line: index + 1, token: `id: ${item[2]}` })
        }
      }
      const token = firstMention(lines[index], sets)
      if (token !== null) leftovers.push({ line: index + 1, token })
      if (kind === 'composition') {
        const id = nodeMention(lines[index], sets)
        if (id !== null) leftovers.push({ line: index + 1, token: `composition node ${id}` })
      }
      if (kind === 'catalog') {
        const page = pageMention(lines[index], sets)
        if (page !== null) leftovers.push({ line: index + 1, token: `catalog page ${page}` })
      }
      if (kind === 'tsconfig') {
        for (const path of sets.filePaths) {
          if (lines[index].includes(path)) leftovers.push({ line: index + 1, token: `deleted file ${path}` })
        }
      }
    }
    if (kind === 'generated' && GENERATED_END.test(lines[index])) insideGenerated = false
  }
  return leftovers
}

/**
 * Record a reference outside the layers the strip rewrites, separating
 * references the protected branch already carries from new ones.
 * @param {string} relativePath Repository-relative path.
 * @param {string} text Current file text.
 * @param {object} sets Strip matching sets.
 * @param {(path: string) => string|null} baselineText Reader for the baseline revision.
 * @param {object} result Strip result under construction.
 * @param {string|null} kind Managed layer the file belongs to, when any.
 * @returns {void}
 */
function collectResidual(relativePath, text, sets, baselineText, result, kind) {
  const scanned = text
  const tokens = [
    ...sets.packageNames,
    ...sets.packagePaths,
    ...sets.documentationPaths,
    ...sets.filePaths,
    ...sets.docBases,
    ...sets.distinctiveIds,
  ]
  const matches = tokens.filter(token => scanned.includes(token))
  if (matches.length === 0) return
  const baseline = baselineText(relativePath)
  const carried = baseline !== null && matches.every(token => baseline.includes(token))
  const entry = { path: relativePath, layer: kind, matches: matches.length, detail: `mentions ${matches.join(', ')}` }
  if (carried) result.residuals.push({ ...entry, justification: `pre-existing on ${result.baselineRef}` })
  else {
    result.newResiduals.push({
      ...entry,
      justification: baseline === null ? 'file is new on this branch' : 'baseline revision does not carry every mention',
    })
  }
}

/**
 * Find a composition node identifier derived from a stripped plugin id.
 * @param {string} line Text line.
 * @param {object} sets Strip matching sets.
 * @returns {string|null} The plugin id whose node the line names.
 */
function nodeMention(line, sets) {
  for (const id of sets.pluginIds) {
    const underscored = id.replace(/-/g, '_')
    const plugin = new RegExp(`plugin_[A-Za-z0-9_]*_${underscored}(?:\\[|\\s|$)`)
    const graph = new RegExp(`pkg_${underscored}\\b`)
    if (plugin.test(line) || graph.test(line)) return id
  }
  return null
}

/**
 * Find a removed documentation page a line links to.
 * @param {string} line Text line.
 * @param {object} sets Strip matching sets.
 * @returns {string|null} The page file name.
 */
function pageMention(line, sets) {
  for (const page of sets.docBases) {
    if (line.includes(`'${page}'`) || line.includes(`"${page}"`) || line.includes(`/${page}`)) return page
  }
  return null
}

/**
 * Test whether a line references the surface the policy removes. This is the
 * single definition of "strip-related" used by both the strip and the conflict
 * resolver, so a resolution can never be broader than the strip itself.
 * @param {string} line Text line.
 * @param {object} sets Strip matching sets.
 * @returns {boolean} True when the line names a stripped package, path, page, or plugin id.
 */
export function stripSurfaceMatch(line, sets) {
  if (firstMention(line, sets) !== null) return true
  if (mentionsStrippedArtifact(line, sets)) return true
  if (nodeMention(line, sets) !== null) return true
  if (pageMention(line, sets) !== null) return true
  if (/^\s*-?\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/.test(line)) {
    const id = /^\s*-?\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line)[1]
    if (sets.pluginIds.includes(id)) return true
  }
  if (sets.docBases.some(page => line.includes(page))) return true
  if (sets.distinctiveIds.some(id => line.includes(id))) return true
  return false
}

/**
 * Find the first stripped package name, package path, or documented path a line mentions.
 * @param {string} line Text line.
 * @param {object} sets Strip matching sets.
 * @returns {string|null} Matched token.
 */
function firstMention(line, sets) {
  for (const token of sets.packageNames) if (line.includes(token)) return token
  for (const token of sets.packagePaths) if (line.includes(token)) return token
  for (const token of sets.documentationPaths) if (line.includes(token)) return token
  return null
}

/**
 * Test whether a line names a deleted package directory or a deleted file.
 * @param {string} line Text line.
 * @param {object} sets Strip matching sets.
 * @returns {boolean} True when the line points at a deleted artifact.
 */
function mentionsStrippedArtifact(line, sets) {
  return (
    sets.packagePaths.some(path => line.includes(path)) || sets.filePaths.some(path => line.includes(path))
  )
}

/**
 * Locate the list item a nested YAML line belongs to.
 * @param {string[]} lines File lines.
 * @param {number} fromIndex Index of the nested line.
 * @returns {number|null} Index of the enclosing item, or null when the line is not inside an item.
 */
function findItemStart(lines, fromIndex) {
  const indent = indentOf(lines[fromIndex])
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    if (!/^\s*-(\s|$)/.test(lines[index])) continue
    return indentOf(lines[index]) < indent ? index : null
  }
  return null
}

/**
 * Count the leading spaces of a line, with tabs counted as two columns.
 * @param {string} line Text line.
 * @returns {number} Leading whitespace width.
 */
function indentOf(line) {
  return /^\s*/.exec(line)[0].replace(/\t/g, '  ').length
}

/**
 * Collect the dependency names a manifest declares.
 * @param {object} manifest Parsed manifest.
 * @returns {Set<string>} Declared dependency names.
 */
function dependencyKeys(manifest) {
  const keys = new Set()
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const declared = manifest[section]
    if (declared === null || typeof declared !== 'object') continue
    for (const name of Object.keys(declared)) keys.add(name)
  }
  return keys
}

/**
 * Parse JSON, reporting failure as null instead of throwing.
 * @param {string} text JSON text.
 * @returns {object|null} Parsed value, or null when the text is not plain JSON.
 */
function parseJson(text) {
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Read the baseline revision of a path once per file.
 * @param {string} root Repository root.
 * @param {string|null} baselineRef Baseline revision.
 * @returns {(path: string) => string|null} Reader returning null for paths absent from the baseline.
 */
function makeBaselineReader(root, baselineRef) {
  const cache = new Map()
  return relativePath => {
    if (baselineRef === null) return null
    if (!cache.has(relativePath)) {
      const shown = git(root, ['show', `${baselineRef}:${relativePath}`])
      cache.set(relativePath, shown.exitCode === 0 ? shown.stdout : null)
    }
    return cache.get(relativePath)
  }
}

/**
 * Test for a regular file, so a tracked symlink to a directory is never read.
 * @param {string} absolute Absolute path.
 * @returns {boolean} True when the path is a regular file.
 */
function isRegularFile(absolute) {
  try {
    return lstatSync(absolute).isFile()
  } catch {
    return false
  }
}

/**
 * List every regular file below a directory.
 * @param {string} directory Absolute directory.
 * @returns {string[]} Absolute file paths.
 */
function listFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(absolute))
    else if (entry.isFile()) files.push(absolute)
  }
  return files
}

/**
 * Convert an absolute path to a slash-separated repository-relative path.
 * @param {string} root Repository root.
 * @param {string} absolute Absolute path.
 * @returns {string} Repository-relative path.
 */
function toRepoPath(root, absolute) {
  return relative(root, absolute).split(sep).join('/')
}

/**
 * Escape a literal string for a regular expression.
 * @param {string} value Literal text.
 * @returns {string} Escaped text.
 */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

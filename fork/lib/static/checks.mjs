// The static gate's checks. Every check records inspection counts on the report
// and either adds a violation or a note; nothing is skipped silently, and a
// suppression is only possible through a justifiedResiduals entry that the gate
// re-validates against the working tree on every run.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { addViolation } from '../policy.mjs'
import { matchesAny } from './glob.mjs'
import { RULE_IDS } from './rules.mjs'
import { collectMatches, extensionOf, lineNumberAt, readTextFile, readTextFileAsync, scanFileForNeedlesAsync, walkFiles } from './walk.mjs'

/** Environment flag of the removed telemetry switch, surveyed but never blocking. */
const DEAD_TELEMETRY_FLAG = 'DSH_TELEMETRY_DISABLED'

/** Build output directory names the artifact walk must enter rather than skip. */
const BUILD_OUTPUT_NAMES = new Set(['lib', 'dist', 'out'])

/** Reported path list is truncated to this many entries in one detail line. */
const DETAIL_PATH_LIMIT = 6

/**
 * Suppression key for one rule finding in one file.
 * @param {string} ruleId Rule that produced the finding.
 * @param {string} path Repository-relative path.
 * @returns {string} Key a justifiedResiduals entry must match.
 */
function suppressionKey(ruleId, path) {
  return `${ruleId}\u0000${path}`
}

/**
 * Render a bounded, comma-separated path list for one violation detail.
 * @param {readonly string[]} paths Repository-relative paths.
 * @returns {string} Detail fragment naming the paths.
 */
function pathList(paths) {
  const shown = paths.slice(0, DETAIL_PATH_LIMIT)
  const suffix = paths.length > shown.length ? `, and ${paths.length - shown.length} more` : ''
  return `${shown.join(', ')}${suffix}`
}

/**
 * Escape a literal string for use inside a regular expression.
 * @param {string} literal Literal text.
 * @returns {string} Escaped text.
 */
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether a scope exempts one path from one rule.
 * @param {readonly object[]} scopes Compiled scopes.
 * @param {string} ruleId Rule under evaluation.
 * @param {string} path Repository-relative path.
 * @returns {boolean} True when a scope covers the rule and the path.
 */
function isScopedOut(scopes, ruleId, path) {
  return scopes.some(scope => scope.appliesTo.includes(ruleId) && matchesAny(path, scope.matchers))
}

/**
 * Whether a path belongs to a shipped tree, where a telemetry-shaped file name
 * is worth reviewing.
 * @param {string} path Repository-relative path.
 * @returns {boolean} True for packages/ and apps/ source paths.
 */
function isShippedSourcePath(path) {
  return (path.startsWith('packages/') || path.startsWith('apps/')) && !path.includes('/tests/')
}

/**
 * Matchers for the files core.json declares deleted outside the removed package
 * trees. A surviving reference can be a full repository path, a path relative to
 * a config file, or a bare basename, so both forms are matched and one report per
 * line keeps a full path from being counted twice.
 * @param {string} path Stripped repository-relative file path.
 * @returns {{path: string, baseName: string, fullPath: RegExp, baseNameMatcher: RegExp}} Matchers.
 */
function strippedFileMatchers(path) {
  const baseName = path.slice(path.lastIndexOf('/') + 1)
  return {
    path,
    baseName,
    fullPath: new RegExp(escapeRegExp(path), 'g'),
    baseNameMatcher: new RegExp(`(?<![\\w.-])${escapeRegExp(baseName)}(?![\\w.-])`, 'g'),
  }
}

/**
 * Validate that core.json declares the files the strip deletes outside the
 * removed package trees, and build their matchers.
 * @param {object} context Check context.
 * @returns {object[]} Matchers for one entry per stripped file path.
 */
function strippedFilePolicy({ core, report }) {
  if (!Array.isArray(core.strippedFilePaths)) {
    addViolation(report, {
      ruleId: RULE_IDS.policyCoverage,
      severity: 'error',
      path: 'fork/policy/core.json',
      detail: 'strippedFilePaths is missing, so the deleted-file rule would scan nothing',
      remedy: 'Add strippedFilePaths to fork/policy/core.json listing every file the strip deletes outside the removed package trees.',
    })
    return []
  }
  return core.strippedFilePaths.map(strippedFileMatchers)
}

/**
 * Check that every path core.json declares stripped is really gone.
 * @param {object} context Check context.
 * @returns {void}
 */
function checkStrippedPaths({ root, report, core }) {
  const declared = [
    ...core.strippedPackagePaths.map(path => ({ path, kind: 'package' })),
    ...core.strippedDocumentationPaths.map(path => ({ path, kind: 'documentation' })),
  ]
  for (const { path, kind } of declared) {
    report.checked += 1
    if (!existsSync(join(root, path))) continue
    addViolation(report, {
      ruleId: RULE_IDS.strippedPathPresent,
      severity: 'blocker',
      path,
      detail: `stripped ${kind} path exists although fork/policy/core.json declares it removed`,
      remedy: `Delete ${path}; the fork removes this surface permanently and a sync may not restore it.`,
    })
  }
}

/**
 * Policy drift: every stripped package path needs a matching identifier rule, so
 * a new upstream package added to core.json cannot silently escape the scan.
 * @param {object} context Check context.
 * @returns {void}
 */
function checkPolicyCoverage({ report, core, rules }) {
  const covered = new Set(rules.strippedIdentifiers.map(entry => entry.derivedFrom ?? entry.token))
  const missing = core.strippedPackagePaths.filter(path =>
    ![...covered].some(entry => entry === path || entry.startsWith(`${path}/`)))
  if (missing.length === 0) return
  addViolation(report, {
    ruleId: RULE_IDS.policyCoverage,
    severity: 'error',
    path: 'fork/policy/rules-static.json',
    detail: `strippedPackagePaths entries without a strippedIdentifiers rule: ${pathList(missing)}`,
    remedy: 'Add a strippedIdentifiers entry (token, kind, derivedFrom) for each new stripped package path.',
  })
}

/**
 * Content rules over the working tree: stripped package names, the identifiers
 * derived from them, and the heuristics that discover telemetry not yet on the
 * denylist.
 * @param {object} context Check context.
 * @param {object[]} strippedFiles Matchers for the files core.json declares deleted.
 * @returns {{candidates: object[], notes: string[]}} Findings before residual
 *   suppression, plus the scan-coverage notes for the report.
 */
async function collectContentFindings({ root, report, core, rules, files }, strippedFiles) {
  const notes = []
  const nameMatchers = core.strippedPackageNames.map(name => ({
    name,
    matcher: new RegExp(escapeRegExp(name), 'g'),
  }))
  const namedFileRules = rules.contentRules
    .filter(rule => rule.id === RULE_IDS.namedFile)
    .map(rule => ({ rule, tester: new RegExp(rule.matcher.source) }))
  const textRules = rules.contentRules.filter(rule => rule.id !== RULE_IDS.namedFile)

  // Phase one decides what each file needs without touching it, so the file set
  // stays a pure function of the policy and the tree listing.
  const jobs = []
  for (const path of files) {
    const extension = extensionOf(path)
    const wanted = new Set()
    if (rules.scan.textExtensions.has(extension)) {
      wanted.add(RULE_IDS.strippedNameReference)
      wanted.add(RULE_IDS.strippedIdentifier)
      wanted.add(RULE_IDS.strippedFileReference)
      for (const rule of textRules) wanted.add(rule.id)
    }
    const named = []
    for (const { rule, tester } of namedFileRules) {
      if (!isShippedSourcePath(path) || !tester.test(path)) continue
      if (isScopedOut(rules.scopes, rule.id, path)) continue
      named.push({
        ruleId: rule.id,
        severity: rule.severity,
        path,
        detail: `file path matches the telemetry naming heuristic (${rule.reason})`,
        remedy: rule.remedy,
      })
    }
    for (const ruleId of [...wanted]) {
      if (isScopedOut(rules.scopes, ruleId, path)) wanted.delete(ruleId)
    }
    if (wanted.size === 0 && named.length === 0) continue
    jobs.push({ path, extension, wanted: [...wanted], named })
  }

  // Phase two reads and evaluates the files with bounded concurrency; the
  // chunked map preserves job order, so two runs on one tree agree exactly.
  const results = await mapChunked(jobs, async (job) => {
    const { path, extension } = job
    const found = [...job.named]
    const wanted = new Set(job.wanted)
    const outcome = { path, candidates: found, scanned: false, skipped: undefined, lossy: false, deadFlag: false, identifierHits: 0 }
    if (wanted.size === 0) return outcome
    const read = await readTextFileAsync(root, path, rules.scan.maxTextFileBytes)
    if (read.text === undefined) {
      outcome.skipped = `${path} (${read.skipped})`
      return outcome
    }
    const { text } = read
    outcome.scanned = true
    outcome.lossy = read.hasNul === true
    outcome.deadFlag = text.includes(DEAD_TELEMETRY_FLAG)
    if (wanted.has(RULE_IDS.strippedNameReference)) {
      // One occurrence is one finding: when two stripped names nest (a shorter
      // name is a prefix of a longer one), keep only the longest match so the
      // report, the counts, and any residual span stay aligned.
      const hits = []
      for (const { name, matcher } of nameMatchers) {
        for (const match of collectMatches(text, matcher)) hits.push({ name, match })
      }
      hits.sort((left, right) => left.match.offset - right.match.offset || right.match.text.length - left.match.text.length)
      const kept = []
      for (const hit of hits) {
        const covered = kept.some(previous => hit.match.offset >= previous.match.offset
          && hit.match.offset + hit.match.text.length <= previous.match.offset + previous.match.text.length)
        if (!covered) kept.push(hit)
      }
      for (const { name, match } of kept) {
        found.push({
          ruleId: RULE_IDS.strippedNameReference,
          severity: 'blocker',
          path,
          line: lineNumberAt(text, match.offset),
          offset: match.offset,
          match: match.text,
          detail: `references stripped package ${name}`,
          remedy: `Remove the reference to ${name}; the package no longer exists in this fork.`,
        })
      }
    }
    if (wanted.has(RULE_IDS.strippedIdentifier)) {
      for (const identifier of rules.strippedIdentifiers) {
        for (const match of collectMatches(text, identifier.matcher)) {
          outcome.identifierHits += 1
          found.push({
            ruleId: RULE_IDS.strippedIdentifier,
            severity: 'blocker',
            path,
            line: lineNumberAt(text, match.offset),
            offset: match.offset,
            match: match.text,
            detail: `names the removed ${identifier.kind} "${identifier.token}" (${identifier.reason})`,
            remedy: 'Remove the reference, or add a justifiedResiduals entry stating why it cannot carry telemetry.',
          })
        }
      }
    }
    if (wanted.has(RULE_IDS.strippedFileReference)) {
      for (const strippedFile of strippedFiles) {
        if (!text.includes(strippedFile.baseName)) continue
        const firstPerLine = new Map()
        for (const hit of collectMatches(text, strippedFile.fullPath)) {
          const line = lineNumberAt(text, hit.offset)
          if (!firstPerLine.has(line)) firstPerLine.set(line, hit)
        }
        for (const hit of collectMatches(text, strippedFile.baseNameMatcher)) {
          const line = lineNumberAt(text, hit.offset)
          if (!firstPerLine.has(line)) firstPerLine.set(line, hit)
        }
        for (const line of [...firstPerLine.keys()].sort((left, right) => left - right)) {
          const hit = firstPerLine.get(line)
          found.push({
            ruleId: RULE_IDS.strippedFileReference,
            severity: 'blocker',
            path,
            line,
            offset: hit.offset,
            match: hit.text,
            detail: `references ${strippedFile.path}, a file the fork strip deleted`,
            remedy: `Delete the ${strippedFile.path} reference; the fork strip removes that file and every remnant of the surface it belonged to.`,
          })
        }
      }
    }
    for (const rule of textRules) {
      if (!wanted.has(rule.id) || !text.includes(rule.needle)) continue
      const severity = rules.scan.codeExtensions.has(extension) ? rule.severity : rule.documentSeverity
      for (const match of collectMatches(text, rule.matcher)) {
        found.push({
          ruleId: rule.id,
          severity,
          path,
          line: lineNumberAt(text, match.offset),
          offset: match.offset,
          match: match.text,
          detail: `matched /${rule.matcher.source}/ on ${JSON.stringify(match.text)} in ${severity === rule.severity ? 'code' : 'a document or manifest'} (${rule.reason})`,
          remedy: rule.remedy,
        })
      }
    }
    return outcome
  }, rules.scan.ioConcurrency)

  const candidates = results.flatMap(result => result.candidates)
  const skipped = results.filter(result => result.skipped !== undefined).map(result => result.skipped)
  const scanned = results.filter(result => result.scanned).length
  report.checked += scanned
  notes.push(`tree scan read ${scanned} text file(s); ${skipped.length} unreadable or oversized file(s) skipped${skipped.length === 0 ? '' : `: ${pathList(skipped)}`}`)
  const lossy = results.filter(result => result.lossy).length
  if (lossy > 0) {
    notes.push(`tree scan decoded ${lossy} file(s) that contain an embedded NUL byte; they were scanned rather than skipped`)
  }
  const deadFlagFiles = results.filter(result => result.deadFlag).length
  if (deadFlagFiles > 0) {
    notes.push(`${DEAD_TELEMETRY_FLAG} appears in ${deadFlagFiles} file(s) (CI workflows, test launchers, and preview scripts); no source file reads it, so the removed switch leaves no live behavior`)
  }
  const identifierHits = results.reduce((total, result) => total + result.identifierHits, 0)
  if (identifierHits > 0) {
    notes.push(`identifier rule matched ${identifierHits} occurrence(s) of removed names before suppression; the scopes and justifiedResiduals entries above account for every surviving one`)
  }
  return { candidates, notes }
}

/**
 * Map over items with bounded concurrency, preserving input order in the result.
 * @param {readonly object[]} items Work items.
 * @param {(item: object) => Promise<object>} worker Per-item async worker.
 * @param {number} concurrency Maximum workers in flight.
 * @returns {Promise<object[]>} Worker results in item order.
 */
async function mapChunked(items, worker, concurrency) {
  const size = Number.isSafeInteger(concurrency) && concurrency > 0 ? concurrency : 12
  const results = []
  for (let index = 0; index < items.length; index += size) {
    const chunk = items.slice(index, index + size)
    results.push(...await Promise.all(chunk.map(worker)))
  }
  return results
}

/**
 * Dependency closure: no workspace manifest may declare a forbidden dependency.
 * @param {object} context Check context.
 * @returns {string[]} Notes about manifests the scan could not read.
 */
function checkDependencies({ root, report, rules, files }) {
  const forbidden = new Map(rules.forbiddenDependencies.map(entry => [entry.name, entry]))
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  for (const path of files) {
    if (path.slice(path.lastIndexOf('/') + 1) !== 'package.json') continue
    report.checked += 1
    const read = readTextFile(root, path, rules.scan.maxTextFileBytes)
    if (read.text === undefined) {
      // An unchecked manifest leaves the dependency half of the proof
      // incomplete, so it fails the gate instead of being skipped quietly.
      addViolation(report, {
        ruleId: RULE_IDS.forbiddenDependency,
        severity: 'blocker',
        path,
        detail: `manifest could not be read (${read.skipped}), so its dependency declarations were not checked`,
        remedy: 'Make the manifest readable; until then this gate cannot prove the workspace declares no telemetry dependency.',
      })
      continue
    }
    let manifest
    try {
      manifest = JSON.parse(read.text)
    } catch (error) {
      addViolation(report, {
        ruleId: RULE_IDS.forbiddenDependency,
        severity: 'blocker',
        path,
        detail: `manifest is not valid JSON, so its dependency declarations were not checked (${error instanceof Error ? error.message : String(error)})`,
        remedy: 'Repair the manifest; until it parses, this gate cannot prove the workspace declares no telemetry dependency.',
      })
      continue
    }
    for (const section of sections) {
      const declared = manifest[section]
      if (typeof declared !== 'object' || declared === null) continue
      for (const name of Object.keys(declared)) {
        report.checked += 1
        const entry = forbidden.get(name)
        if (entry === undefined) continue
        addViolation(report, {
          ruleId: RULE_IDS.forbiddenDependency,
          severity: 'blocker',
          path,
          detail: `declares forbidden telemetry dependency ${name} in ${section} (${entry.evidence ?? 'policy denylist'})`,
          remedy: `Remove ${name} from ${section}; the fork ships no analytics, OTLP, or crash-reporting dependency.`,
        })
      }
    }
  }
}

/**
 * Record third-party telemetry that reaches a shipped profile through a
 * transitive dependency. The static gate cannot prove such a package stays
 * inert, so this stays a warning that names the runtime gate as owner.
 * @param {object} context Check context.
 * @returns {string[]} Notes about the transitive scan.
 */
function checkTransitiveTelemetry({ root, report, rules }) {
  if (rules.transitiveTelemetryPackages.length === 0) return []
  const notes = []
  const read = readTextFile(root, 'pnpm-lock.yaml', rules.scan.maxTextFileBytes)
  report.checked += 1
  if (read.text === undefined) {
    notes.push('transitive telemetry check skipped: pnpm-lock.yaml is absent or unreadable')
    return notes
  }
  for (const entry of rules.transitiveTelemetryPackages) {
    report.checked += 1
    const matches = collectMatches(read.text, new RegExp(escapeRegExp(entry.name), 'g'))
    if (matches.length === 0) continue
    addViolation(report, {
      ruleId: RULE_IDS.transitiveTelemetryPackage,
      severity: 'warning',
      path: 'pnpm-lock.yaml',
      line: lineNumberAt(read.text, matches[0].offset),
      detail: `${entry.name} is in the dependency closure (${matches.length} lockfile reference(s), declared by ${entry.declaredBy ?? 'an upstream package'})`,
      remedy: `${entry.reason} Confirm with the egress gate that it stays inert in every shipped profile.`,
    })
  }
  return notes
}

/** Indentation of a YAML sequence-item line, or undefined when it starts no item. */
function sequenceItemIndent(line) {
  const match = /^([ ]*)-(\s|$)/.exec(line)
  return match === null ? undefined : match[1].length
}

/** Leading-space count of one line. */
function indentOf(line) {
  return /^ */.exec(line)[0].length
}

/**
 * Drop a YAML comment, ignoring `#` inside quotes.
 * @param {string} line One line without its newline.
 * @returns {string} The line up to its comment.
 */
function stripYamlComment(line) {
  let quote
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index)
  }
  return line
}

/**
 * Decide whether a composition reference sits in a row that can only turn the
 * plugin off.
 *
 * The row is the YAML sequence item the reference belongs to: the nearest
 * preceding item start, ended by the next item at the same or a shallower
 * indentation, so a nested item is its own row and never inherits its parent's
 * keys. A row counts as inert only when that same row carries a top-level
 * `disabled: true` (or `config: enabled: false`) **and** declares no `name:` or
 * `module:` anywhere. Every ambiguous shape defaults to composing, because a
 * wrongly inert row is a pass while telemetry is present.
 * @param {string} text Full composition file text.
 * @param {number} offset Offset of the reference inside the text.
 * @returns {{inert: boolean, module: string | undefined, marker: string | undefined, row: string}}
 *   Whether the row is inert, the module it declares, the marker that disabled
 *   it, and the row text.
 */
function compositionRowState(text, offset) {
  const lines = text.split('\n')
  const matchLine = lineNumberAt(text, offset) - 1
  let start = -1
  for (let index = matchLine; index >= 0; index -= 1) {
    if (sequenceItemIndent(lines[index]) !== undefined) {
      start = index
      break
    }
  }
  if (start === -1) return { inert: false, module: undefined, marker: undefined, row: '' }
  const itemIndent = sequenceItemIndent(lines[start])
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const nextIndent = sequenceItemIndent(lines[index])
    if (nextIndent !== undefined && nextIndent <= itemIndent) {
      end = index
      break
    }
  }
  const row = lines.slice(start, end).map(stripYamlComment)
  const inline = /^([ ]*)-(\s+)(\S.*)$/.exec(lines[start])
  const keyIndent = inline === null
    ? row.slice(1).find(line => line.trim() !== '') === undefined
      ? undefined
      : indentOf(row.slice(1).find(line => line.trim() !== ''))
    : inline[1].length + 1 + inline[2].length
  const topLevel = line => keyIndent !== undefined && indentOf(line) === keyIndent
  const moduleMatch = row.map(line => /^\s*(?:name|module)\s*:\s*(\S.*)$/.exec(line)).find(match => match !== null)
  const module = moduleMatch === undefined
    ? undefined
    : moduleMatch[1].trim().replace(/^['"]|['"]$/g, '')
  const disabledHere = keyIndent !== undefined && row.some(line =>
    topLevel(line) && /^disabled\s*:\s*true\b/.test(line.trim()))
  const hasConfig = keyIndent !== undefined && row.some(line => topLevel(line) && /^config\s*:/.test(line.trim()))
  const disabledByConfig = hasConfig
    && row.some(line => indentOf(line) > keyIndent && /^enabled\s*:\s*false\b/.test(line.trim()))
  const marker = disabledHere ? 'disabled: true' : disabledByConfig ? 'config.enabled: false' : undefined
  return {
    inert: module === undefined && marker !== undefined,
    module,
    marker,
    row: row.join('\n'),
  }
}

/**
 * Composition: no profile, bundle, snapshot fixture, or generated catalog may
 * compose a stripped plugin. A row that only disables a removed plugin and
 * declares no module is reported as a warning, because nothing can install it;
 * every other shape blocks, and a composition file this scan cannot read blocks
 * too, since the composition proof would otherwise be incomplete.
 * @param {object} context Check context.
 * @returns {{candidates: object[], notes: string[]}} Findings and coverage notes.
 */
function checkComposition({ root, report, core, rules, files }) {
  const candidates = []
  const unread = []
  const compositions = files.filter(path => matchesAny(path, rules.compositionMatchers))
  let read = 0
  for (const path of compositions) {
    const source = readTextFile(root, path, rules.scan.maxTextFileBytes)
    if (source.text === undefined) {
      unread.push(`${path} (${source.skipped})`)
      continue
    }
    read += 1
    report.checked += 1
    for (const name of core.strippedPackageNames) {
      for (const match of collectMatches(source.text, new RegExp(escapeRegExp(name), 'g'))) {
        candidates.push(compositionCandidate(source.text, path, match.offset, `composition names stripped package ${name}`, name))
      }
    }
    for (const identifier of rules.strippedIdentifiers) {
      for (const match of collectMatches(source.text, identifier.matcher)) {
        candidates.push(compositionCandidate(
          source.text,
          path,
          match.offset,
          `composition names the removed plugin or service "${identifier.token}"`,
          identifier.token,
        ))
      }
    }
  }
  for (const path of unread) {
    addViolation(report, {
      ruleId: RULE_IDS.compositionUnread,
      severity: 'blocker',
      path: path.slice(0, path.lastIndexOf(' (')),
      detail: `composition file could not be read (${path.slice(path.lastIndexOf(' (') + 2, -1)}), so it was not checked for stripped plugins`,
      remedy: 'Make the file readable or exclude it from the composition globs; an unchecked composition cannot be called clean.',
    })
  }
  return {
    candidates,
    notes: [`composition scan read ${read} of ${compositions.length} file(s)${unread.length === 0 ? '' : `; ${unread.length} unreadable or oversized and reported as a violation: ${pathList(unread)}`}`],
  }
}

/**
 * Whether one offset sits inside a YAML comment on its line.
 * @param {string} text Full file text.
 * @param {number} offset Offset to classify.
 * @returns {boolean} True when the rest of that line is a comment.
 */
function isInYamlComment(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  const lineEnd = text.indexOf('\n', offset)
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
  const code = stripYamlComment(line)
  return code.length < line.length && offset >= lineStart + code.length
}

/**
 * Build one composition finding with the severity its own row justifies.
 * @param {string} text Full composition file text.
 * @param {string} path Repository-relative path.
 * @param {number} offset Offset of the reference.
 * @param {string} detail What the reference names.
 * @param {string} token Stripped plugin id or package name that matched.
 * @returns {object} Candidate finding.
 */
function compositionCandidate(text, path, offset, detail, token) {
  const line = lineNumberAt(text, offset)
  const matched = text.slice(offset).split('\n')[0].trim()
  if (isInYamlComment(text, offset)) {
    // A comment cannot compose anything, but a stripped reference in one is
    // still strip residue, so it stays visible instead of passing silently.
    return {
      ruleId: RULE_IDS.compositionStrippedPlugin,
      severity: 'warning',
      path,
      line,
      offset,
      match: matched,
      detail: `${detail}, but only inside a comment, so no row composes it`,
      remedy: `Delete the stale "${token}" reference, or record it as a justifiedResiduals entry if the comment must stay.`,
    }
  }
  const { inert, module, marker } = compositionRowState(text, offset)
  return {
    ruleId: RULE_IDS.compositionStrippedPlugin,
    severity: inert ? 'warning' : 'blocker',
    path,
    line,
    offset,
    match: matched,
    detail: inert
      ? `${detail}, but its row only disables it (${marker}) and declares no module name, so nothing can be composed`
      : module === undefined
        ? `${detail} in a row that composes it`
        : `${detail} as module "${module}"`,
    remedy: inert
      ? `Delete the dead "${token}" row; keeping it re-introduces the reference on every upstream sync.`
      : `Delete the row that composes "${token}"; the plugin no longer exists in this fork.`,
  }
}

/**
 * Artifact scan: built output must carry no telemetry endpoint or OTel SDK
 * marker. Absent artifacts are reported as a note, never as a silent skip.
 * @param {object} context Check context.
 * @returns {{candidates: object[], notes: string[]}} Findings and coverage notes.
 */
async function checkArtifacts({ root, report, rules }) {
  const candidates = []
  const artifactExcludes = rules.scan.artifactExcludeDirectories
    ?? rules.scan.excludeDirectories.filter(entry => !BUILD_OUTPUT_NAMES.has(entry))
  const walk = walkFiles(root, { excludeDirectories: artifactExcludes })
  const artifactFiles = walk.files.filter(path =>
    matchesAny(path, rules.artifactRootMatchers)
    && rules.scan.artifactExtensions.has(extensionOf(path))
    && !isScopedOut(rules.scopes, RULE_IDS.artifactMarker, path))
  if (artifactFiles.length === 0) {
    return {
      candidates,
      tree: walk,
      notes: ['artifact scan skipped: no built output matched the artifact roots in fork/policy/rules-static.json; run the artifact build before relying on the artifact half of this gate'],
    }
  }
  const skipped = []
  const needles = rules.artifactMarkers.map(marker => marker.needle)
  const scans = await mapChunked(artifactFiles, async (path) => {
    const scan = await scanFileForNeedlesAsync(root, path, needles, rules.scan.maxArtifactFileBytes)
    return { path, scan }
  }, rules.scan.ioConcurrency)
  let scanned = 0
  for (const { path, scan } of scans) {
    if (scan.matches === undefined) {
      skipped.push(`${path} (${scan.skipped})`)
      continue
    }
    scanned += 1
    for (const marker of rules.artifactMarkers) {
      const match = scan.matches.find(entry => entry.needle === marker.needle)
      if (match === undefined) continue
      if (isScopedOut(rules.scopes, marker.id, path)) continue
      candidates.push({
        ruleId: RULE_IDS.artifactMarker,
        severity: marker.severity,
        path,
        line: match.line,
        detail: `built artifact contains ${JSON.stringify(marker.needle)} via marker ${marker.id} (${marker.reason})`,
        remedy: marker.remedy,
      })
    }
  }
  report.checked += scanned
  return {
    candidates,
    tree: walk,
    notes: [`artifact scan covered ${scanned} file(s) of ${artifactFiles.length} built output file(s)${skipped.length === 0 ? '' : `; ${skipped.length} skipped: ${pathList(skipped)}`}`],
  }
}

/**
 * Suppress findings covered by a justifiedResiduals entry and re-validate each
 * entry, so a residual whose target moved, shrank, or vanished fails the gate.
 * @param {object} context Check context.
 * @param {object[]} candidates Findings from the content, composition, and artifact checks.
 * @returns {void}
 */
function applyResiduals({ root, report, rules }, candidates) {
  // Each residual is validated against the file first, so suppression can be
  // keyed on the exact spans it covers rather than on the whole file.
  const states = rules.justifiedResiduals.map((entry) => {
    const read = readTextFile(root, entry.path, rules.scan.maxTextFileBytes)
    if (read.text === undefined) return { entry, problem: 'targets a file that is absent or unreadable' }
    const spans = collectMatches(read.text, entry.matcher).map(match => ({
      start: match.offset,
      end: match.offset + match.text.length,
      line: lineNumberAt(read.text, match.offset),
    }))
    if (spans.length !== entry.count) {
      return {
        entry,
        spans,
        problem: `expects ${entry.count} match(es) of /${entry.matcher.source}/ but the file has ${spans.length}`,
      }
    }
    return { entry, spans, suppressed: 0 }
  })
  const byLocation = new Map()
  for (const state of states) {
    if (state.spans === undefined) continue
    const key = suppressionKey(state.entry.ruleId, state.entry.path)
    byLocation.set(key, [...byLocation.get(key) ?? [], state])
  }
  for (const candidate of candidates) {
    const covering = (byLocation.get(suppressionKey(candidate.ruleId, candidate.path)) ?? [])
      .find(state => state.spans.some(span => spanCovers(span, candidate)))
    if (covering === undefined) {
      addViolation(report, candidate)
      continue
    }
    covering.suppressed += 1
  }
  for (const state of states) {
    report.checked += 1
    if (state.problem !== undefined) {
      addViolation(report, {
        ruleId: RULE_IDS.staleResidual,
        severity: 'error',
        path: state.entry.path,
        detail: `justifiedResiduals ${state.entry.id} ${state.problem}`,
        remedy: 'Review the new occurrence, then update or delete the entry; a residual that no longer matches its location may hide a re-introduction.',
      })
      continue
    }
    if (state.suppressed !== state.entry.count) {
      addViolation(report, {
        ruleId: RULE_IDS.staleResidual,
        severity: 'error',
        path: state.entry.path,
        detail: `justifiedResiduals ${state.entry.id} matched ${state.entry.count} location(s) but accounted for ${state.suppressed} finding(s)`,
        remedy: 'Point the entry at the rule and location it still suppresses, or delete it.',
      })
    }
  }
}

/**
 * Whether a residual span covers one finding. Findings carry the offset and text
 * of the match that produced them, so an exact span decides: a residual granted
 * for one occurrence can never hide a different one in the same file.
 * @param {{start: number, end: number, line: number}} span Residual match span.
 * @param {object} candidate Finding under evaluation.
 * @returns {boolean} True when the span produced this finding.
 */
function spanCovers(span, candidate) {
  if (typeof candidate.offset === 'number') {
    const end = candidate.offset + (candidate.match?.length ?? 0)
    return candidate.offset < span.end && span.start < Math.max(end, candidate.offset + 1)
  }
  return candidate.line !== undefined && candidate.line === span.line
}

/**
 * Validate that every declared scope still covers at least one path, so a scope
 * cannot outlive the file it was written for.
 * @param {object} context Check context.
 * @returns {void}
 */
function checkScopes({ report, rules }, files) {
  for (const scope of rules.scopes) {
    report.checked += 1
    if (scope.matchers.some(matcher => files.some(path => matcher.test(path)))) continue
    if (!scope.required) {
      report.notes.push(`scope ${scope.id} matched no file in this tree; the scope is optional, so its globs stay unverified here`)
      continue
    }
    addViolation(report, {
      ruleId: RULE_IDS.unmatchedScope,
      severity: 'error',
      path: 'fork/policy/rules-static.json',
      detail: `scope ${scope.id} matches no file for globs ${scope.globs.join(', ')}`,
      remedy: 'Delete the stale scope, or correct its globs.',
    })
  }
}

/**
 * Run every static check against one working tree.
 * @param {object} input Check input.
 * @param {string} input.root Repository root.
 * @param {object} input.report Report returned by newReport; mutated in place.
 * @param {object} input.core Merged core policy from fork/policy/core.json.
 * @param {object} input.rules Compiled rules from loadStaticRules.
 * @returns {object} The same report with violations, notes, and checked count.
 */
export async function runStaticChecks({ root, report, core, rules }) {
  const tree = walkFiles(root, { excludeDirectories: rules.scan.excludeDirectories })
  const { files } = tree
  report.checked += files.length
  const context = { root, report, core, rules, files }
  checkStrippedPaths(context)
  checkPolicyCoverage(context)
  const strippedFiles = strippedFilePolicy(context)
  // The two bulk scans overlap; their candidate lists keep a fixed order so the
  // report is identical between runs.
  const [content, artifacts] = await Promise.all([
    collectContentFindings(context, strippedFiles),
    checkArtifacts(context),
  ])
  const composition = checkComposition(context)
  report.notes.push(...content.notes, ...composition.notes, ...artifacts.notes)
  checkDependencies(context)
  report.notes.push(...checkTransitiveTelemetry(context))
  applyResiduals(context, [...content.candidates, ...composition.candidates, ...artifacts.candidates])
  checkScopes(context, files)
  reportUnreadablePaths(context, [tree, artifacts.tree])
  return report
}

/**
 * Report every path the scans could not read, and note the paths they refused
 * to follow. A gate that could not look somewhere must not be indistinguishable
 * from one that looked and found nothing.
 * @param {object} context Check context.
 * @param {readonly object[]} walks Walks performed, each with unreadable and symlink lists.
 * @returns {void}
 */
function reportUnreadablePaths({ report }, walks) {
  const unreadable = new Set()
  const symlinks = new Set()
  for (const walk of walks) {
    for (const path of walk?.unreadable ?? []) unreadable.add(path)
    for (const path of walk?.symlinks ?? []) symlinks.add(path)
  }
  for (const path of [...unreadable].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
    addViolation(report, {
      ruleId: RULE_IDS.unreadablePath,
      severity: 'blocker',
      path,
      detail: 'directory could not be read, so nothing under it was scanned',
      remedy: 'Fix the permissions or remove the directory; an unreadable subtree means this gate proved nothing about it.',
    })
  }
  if (symlinks.size > 0) {
    report.notes.push(`${symlinks.size} symlink(s) not followed: ${pathList([...symlinks].sort())}`)
  }
}

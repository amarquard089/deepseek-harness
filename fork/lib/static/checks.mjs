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
      for (const { name, matcher } of nameMatchers) {
        for (const match of collectMatches(text, matcher)) {
          found.push({
            ruleId: RULE_IDS.strippedNameReference,
            severity: 'blocker',
            path,
            line: lineNumberAt(text, match.offset),
            detail: `references stripped package ${name}`,
            remedy: `Remove the reference to ${name}; the package no longer exists in this fork.`,
          })
        }
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
            detail: `names the removed ${identifier.kind} "${identifier.token}" (${identifier.reason})`,
            remedy: 'Remove the reference, or add a justifiedResiduals entry stating why it cannot carry telemetry.',
          })
        }
      }
    }
    if (wanted.has(RULE_IDS.strippedFileReference)) {
      for (const strippedFile of strippedFiles) {
        if (!text.includes(strippedFile.baseName)) continue
        const lines = new Set()
        for (const hit of collectMatches(text, strippedFile.fullPath)) lines.add(lineNumberAt(text, hit.offset))
        for (const hit of collectMatches(text, strippedFile.baseNameMatcher)) lines.add(lineNumberAt(text, hit.offset))
        for (const line of [...lines].sort((left, right) => left - right)) {
          found.push({
            ruleId: RULE_IDS.strippedFileReference,
            severity: 'blocker',
            path,
            line,
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

/**
 * Decide whether a composition reference sits in a row that can only turn the
 * plugin off. A row that sets `disabled: true` or `enabled: false` and names no
 * module cannot install or enable anything, so it is residue rather than risk.
 * @param {string} text Full composition file text.
 * @param {number} offset Offset of the reference inside the text.
 * @returns {{inert: boolean, row: string}} Whether the row is inert, and its text.
 */
function compositionRowState(text, offset) {
  const rowStart = Math.max(0, text.lastIndexOf('\n- ', offset) + 1)
  const nextRow = text.indexOf('\n- ', offset)
  const row = text.slice(rowStart, nextRow === -1 ? text.length : nextRow + 1)
  const disabled = /(^|\n)\s*disabled:\s*true\b/.test(row)
  const disabledByConfig = /(^|\n)\s*enabled:\s*false\b/.test(row)
  return { inert: disabled || disabledByConfig, row }
}

/**
 * Composition: no profile, bundle, snapshot fixture, or generated catalog may
 * compose a stripped plugin. A row that only disables a removed plugin is
 * reported as a warning, because the plugin is not installed to disable.
 * @param {object} context Check context.
 * @returns {{candidates: object[], notes: string[]}} Findings and coverage notes.
 */
function checkComposition({ root, report, core, rules, files }) {
  const candidates = []
  const compositions = files.filter(path => matchesAny(path, rules.compositionMatchers))
  for (const path of compositions) {
    const read = readTextFile(root, path, rules.scan.maxTextFileBytes)
    if (read.text === undefined) continue
    report.checked += 1
    for (const name of core.strippedPackageNames) {
      for (const match of collectMatches(read.text, new RegExp(escapeRegExp(name), 'g'))) {
        candidates.push(compositionCandidate(read.text, path, match.offset, `composition names stripped package ${name}`, name))
      }
    }
    for (const identifier of rules.strippedIdentifiers) {
      for (const match of collectMatches(read.text, identifier.matcher)) {
        candidates.push(compositionCandidate(
          read.text,
          path,
          match.offset,
          `composition names the removed plugin or service "${identifier.token}"`,
          identifier.token,
        ))
      }
    }
  }
  return {
    candidates,
    notes: [`composition scan covered ${compositions.length} file(s)`],
  }
}

/**
 * Build one composition finding with the severity its row justifies.
 * @param {string} text Full composition file text.
 * @param {string} path Repository-relative path.
 * @param {number} offset Offset of the reference.
 * @param {string} detail What the reference names.
 * @param {string} token Stripped plugin id or package name that matched.
 * @returns {object} Candidate finding.
 */
function compositionCandidate(text, path, offset, detail, token) {
  const { inert } = compositionRowState(text, offset)
  return {
    ruleId: RULE_IDS.compositionStrippedPlugin,
    severity: inert ? 'warning' : 'blocker',
    path,
    line: lineNumberAt(text, offset),
    detail: inert
      ? `${detail}, but the row only disables it (no module name), so nothing can be composed`
      : detail,
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
  const artifactFiles = walkFiles(root, { excludeDirectories: artifactExcludes }).filter(path =>
    matchesAny(path, rules.artifactRootMatchers)
    && rules.scan.artifactExtensions.has(extensionOf(path))
    && !isScopedOut(rules.scopes, RULE_IDS.artifactMarker, path))
  if (artifactFiles.length === 0) {
    return {
      candidates,
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
  const residuals = new Map(rules.justifiedResiduals.map(entry => [suppressionKey(entry.ruleId, entry.path), entry]))
  const suppressed = new Map()
  for (const candidate of candidates) {
    const residual = residuals.get(suppressionKey(candidate.ruleId, candidate.path))
    if (residual === undefined) {
      addViolation(report, candidate)
      continue
    }
    suppressed.set(residual.id, (suppressed.get(residual.id) ?? 0) + 1)
  }
  for (const residual of rules.justifiedResiduals) {
    report.checked += 1
    const read = readTextFile(root, residual.path, rules.scan.maxTextFileBytes)
    if (read.text === undefined) {
      addViolation(report, {
        ruleId: RULE_IDS.staleResidual,
        severity: 'error',
        path: residual.path,
        detail: `justifiedResiduals ${residual.id} targets a file that is absent or unreadable`,
        remedy: 'Delete the stale entry, or correct its path.',
      })
      continue
    }
    const actual = collectMatches(read.text, residual.matcher).length
    if (actual !== residual.count) {
      addViolation(report, {
        ruleId: RULE_IDS.staleResidual,
        severity: 'error',
        path: residual.path,
        detail: `justifiedResiduals ${residual.id} expects ${residual.count} match(es) of /${residual.matcher.source}/ but the file has ${actual}`,
        remedy: 'Review the new occurrence, then update the entry count; a count that moved may hide a re-introduction.',
      })
      continue
    }
    if (!suppressed.has(residual.id)) {
      addViolation(report, {
        ruleId: RULE_IDS.staleResidual,
        severity: 'error',
        path: residual.path,
        detail: `justifiedResiduals ${residual.id} matches content that no rule reported, so it suppresses nothing`,
        remedy: 'Delete the entry, or point it at the rule and path that still reports the finding.',
      })
    }
  }
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
  const files = walkFiles(root, { excludeDirectories: rules.scan.excludeDirectories })
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
  return report
}

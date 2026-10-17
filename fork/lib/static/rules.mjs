// Loader and validator for fork/policy/rules-static.json, the static gate's own
// policy fragment. Validation fails loud at gate start: a malformed or
// incomplete rule file must stop the run as an internal error (exit 2) rather
// than let the gate report a pass it did not establish.

import { POLICY_PATHS, readPolicyFragment } from '../policy.mjs'
import { globToRegExp } from './glob.mjs'

/** Rule ids emitted by this gate, documented so reports stay machine-readable. */
export const RULE_IDS = {
  strippedPathPresent: 'static.stripped-path-present',
  strippedNameReference: 'static.stripped-name-reference',
  strippedIdentifier: 'static.stripped-identifier',
  strippedFileReference: 'static.stripped-file-reference',
  forbiddenDependency: 'static.forbidden-dependency',
  transitiveTelemetryPackage: 'static.transitive-telemetry-package',
  compositionStrippedPlugin: 'static.composition-stripped-plugin',
  compositionUnread: 'static.composition-unread',
  unreadablePath: 'static.unreadable-path',
  artifactMarker: 'static.artifact-telemetry-marker',
  staleResidual: 'static.stale-residual',
  unmatchedScope: 'static.unmatched-scope',
  policyCoverage: 'static.policy-coverage',
  /** Content rule id that inspects file paths rather than file text. */
  namedFile: 'telemetry.telemetry-named-file',
}

/** Rule ids whose findings a justifiedResiduals entry may suppress. */
const SUPPRESSIBLE = new Set([
  RULE_IDS.strippedNameReference,
  RULE_IDS.strippedIdentifier,
  RULE_IDS.strippedFileReference,
  RULE_IDS.compositionStrippedPlugin,
  RULE_IDS.artifactMarker,
])

/**
 * Compile one policy pattern, reporting an unusable pattern by its owner.
 * @param {string} pattern Regular-expression source.
 * @param {string} flags Regular-expression flags.
 * @param {string} owner Entry that declares the pattern.
 * @returns {RegExp} Compiled matcher.
 */
function compilePattern(pattern, flags, owner) {
  try {
    return new RegExp(pattern, flags)
  } catch (error) {
    throw new Error(`rules-static.json: ${owner} has an invalid pattern: ${error.message}`)
  }
}

/**
 * Assert one policy array exists before it is read.
 * @param {object} rules Parsed fragment.
 * @param {string} key Field that must hold an array.
 * @returns {object[]} The array.
 */
function requireArray(rules, key) {
  const value = rules[key]
  if (!Array.isArray(value)) throw new Error(`rules-static.json: ${key} must be an array`)
  return value
}

/**
 * Assert one string field on a rules entry.
 * @param {object} entry Policy entry.
 * @param {string} key Field that must hold a non-empty string.
 * @param {string} owner Description of the entry, for the error message.
 * @returns {string} The field value.
 */
function requireString(entry, key, owner) {
  const value = entry[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`rules-static.json: ${owner} requires a non-empty ${key}`)
  }
  return value
}

/**
 * Load, validate, and compile the static rule fragment.
 * @param {string} root Repository root that contains fork/policy.
 * @returns {object} Compiled rules: scopes with matchers, content rules with
 *   matchers and needles, artifact markers, composition matchers, residual
 *   matchers, and the scan limits.
 */
export function loadStaticRules(root) {
  const rules = readPolicyFragment(root, POLICY_PATHS.staticRules)
  if (rules.schema !== 'dsh-fork-static-rules/v1') {
    throw new Error(`rules-static.json: unsupported schema ${String(rules.schema)}`)
  }
  const scan = rules.scan
  if (typeof scan !== 'object' || scan === null) {
    throw new Error('rules-static.json: scan must be an object')
  }
  const suppressibleIds = new Set([
    ...SUPPRESSIBLE,
    ...requireArray(rules, 'contentRules').map(rule => rule.id),
  ])
  const loaded = {
    scan: {
      excludeDirectories: requireArray(scan, 'excludeDirectories'),
      maxTextFileBytes: scan.maxTextFileBytes,
      maxArtifactFileBytes: scan.maxArtifactFileBytes,
      ioConcurrency: scan.ioConcurrency ?? 12,
      textExtensions: new Set(requireArray(scan, 'textExtensions')),
      artifactExtensions: new Set(requireArray(scan, 'artifactExtensions')),
      codeExtensions: new Set(requireArray(scan, 'codeExtensions')),
    },
    artifactRootMatchers: requireArray(rules, 'artifactRoots').map(globToRegExp),
    compositionMatchers: requireArray(rules, 'compositionGlobs').map(globToRegExp),
    contentRules: requireArray(rules, 'contentRules').map((rule) => {
      const id = requireString(rule, 'id', 'contentRules entry')
      const severity = rule.severity === 'warning' ? 'warning' : 'blocker'
      return {
        id,
        needle: requireString(rule, 'needle', `contentRules ${id}`),
        matcher: compilePattern(requireString(rule, 'pattern', `contentRules ${id}`), 'g', `contentRules ${id}`),
        severity,
        // A rule may separate code that can act from a document or manifest
        // string that cannot; the static gate reports the latter as a warning.
        documentSeverity: rule.manifestSeverity === 'warning' ? 'warning' : severity,
        reason: requireString(rule, 'reason', `contentRules ${id}`),
        remedy: requireString(rule, 'remedy', `contentRules ${id}`),
        evidence: rule.evidence,
      }
    }),
    artifactMarkers: requireArray(rules, 'artifactMarkers').map((marker) => {
      const id = requireString(marker, 'id', 'artifactMarkers entry')
      return {
        id,
        needle: requireString(marker, 'needle', `artifactMarkers ${id}`),
        severity: marker.severity === 'warning' ? 'warning' : 'blocker',
        reason: requireString(marker, 'reason', `artifactMarkers ${id}`),
        remedy: requireString(marker, 'remedy', `artifactMarkers ${id}`),
        evidence: marker.evidence,
      }
    }),
    forbiddenDependencies: requireArray(rules, 'forbiddenDependencies').map((entry) => {
      const name = requireString(entry, 'name', 'forbiddenDependencies entry')
      return { name, evidence: entry.evidence }
    }),
    transitiveTelemetryPackages: requireArray(rules, 'transitiveTelemetryPackages').map((entry) => {
      const name = requireString(entry, 'name', 'transitiveTelemetryPackages entry')
      return {
        name,
        declaredBy: entry.declaredBy,
        evidence: entry.evidence,
        reason: requireString(entry, 'reason', `transitiveTelemetryPackages ${name}`),
      }
    }),
    strippedIdentifiers: requireArray(rules, 'strippedIdentifiers').map((entry) => {
      const token = requireString(entry, 'token', 'strippedIdentifiers entry')
      return {
        token,
        kind: entry.kind,
        derivedFrom: entry.derivedFrom,
        reason: requireString(entry, 'reason', `strippedIdentifiers ${token}`),
        evidence: entry.evidence,
        matcher: compilePattern(
          `(?<![\\w@/.-])${escapeLiteral(token)}(?![\\w.-])`,
          'g',
          `strippedIdentifiers ${token}`,
        ),
      }
    }),
    scopes: requireArray(rules, 'scopes').map((scope) => {
      const id = requireString(scope, 'id', 'scopes entry')
      return {
        id,
        matchers: requireArray(scope, 'globs').map(globToRegExp),
        globs: scope.globs,
        appliesTo: requireArray(scope, 'appliesTo'),
        // A scope may target a path class that some trees do not carry, such as
        // build output or the tooling directory when scanning a foreign root.
        required: scope.required !== false,
        reason: requireString(scope, 'reason', `scopes ${id}`),
      }
    }),
    justifiedResiduals: requireArray(rules, 'justifiedResiduals').map((entry) => {
      const id = requireString(entry, 'id', 'justifiedResiduals entry')
      const ruleId = requireString(entry, 'ruleId', `justifiedResiduals ${id}`)
      if (!suppressibleIds.has(ruleId)) {
        throw new Error(`rules-static.json: justifiedResiduals ${id} names rule ${ruleId}, which reports no suppressible finding`)
      }
      if (!Number.isSafeInteger(entry.count) || entry.count < 1) {
        throw new Error(`rules-static.json: justifiedResiduals ${id} requires a positive integer count`)
      }
      return {
        id,
        ruleId,
        path: requireString(entry, 'path', `justifiedResiduals ${id}`),
        matcher: compilePattern(requireString(entry, 'pattern', `justifiedResiduals ${id}`), 'g', `justifiedResiduals ${id}`),
        count: entry.count,
        reason: requireString(entry, 'reason', `justifiedResiduals ${id}`),
        evidence: entry.evidence,
      }
    }),
  }
  if (!loaded.contentRules.some(rule => rule.id === RULE_IDS.namedFile)) {
    throw new Error(`rules-static.json: contentRules must declare the ${RULE_IDS.namedFile} path rule`)
  }
  const knownRuleIds = new Set([
    ...SUPPRESSIBLE,
    ...loaded.contentRules.map(rule => rule.id),
    ...loaded.artifactMarkers.map(marker => marker.id),
  ])
  for (const scope of loaded.scopes) {
    for (const ruleId of scope.appliesTo) {
      if (!knownRuleIds.has(ruleId)) {
        throw new Error(`rules-static.json: scope ${scope.id} applies to unknown rule ${ruleId}`)
      }
    }
  }
  return loaded
}

/**
 * Escape a literal string for use inside a regular expression.
 * @param {string} literal Literal text.
 * @returns {string} Escaped text.
 */
function escapeLiteral(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

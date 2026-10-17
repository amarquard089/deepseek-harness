// Egress classification and allowlist matching for the runtime egress gate.
//
// The shim labels every interception record as it is written and the gate
// re-derives the same label before it trusts a record, so both sides share this
// module: a record can never look local to one side and external to the other.
//
// A target is `local` only when it cannot leave the machine: a Unix-domain
// socket, a file-descriptor/pipe path, a loopback address, or a wildcard bind
// address. Every other target is `egress`, including a DNS query for an
// external name — asking where a host is is itself an outbound attempt.

/** Names that always denote this machine rather than a network peer. */
const LOCAL_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'ip6-localnet',
  'broadcasthost',
])

/** IPv4 loopback range, including the IPv4-mapped IPv6 forms. */
const LOOPBACK_V4 = /^(::ffff:)?127\./

/** Records that describe a network attempt rather than a lifecycle marker. */
const NETWORK_KINDS = new Set(['connect', 'request', 'fetch', 'undici', 'http2', 'dns', 'udp'])

/**
 * Lower-case and unwrap a host value for comparison.
 * @param {unknown} host Host string from a connect/request target.
 * @returns {string} Comparison form; the empty string means "no host given".
 */
export function normalizeHost(host) {
  if (host === undefined || host === null) return ''
  return String(host).trim().toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '')
}

/**
 * Decide whether a host name can leave this machine.
 * @param {unknown} host Host from an interception record.
 * @returns {boolean} True for loopback, wildcard, and unspecified hosts.
 */
export function isLocalHost(host) {
  const value = normalizeHost(host)
  if (value === '') return true
  if (LOCAL_HOSTNAMES.has(value)) return true
  if (value === '::1' || value === '::' || value === '0.0.0.0' || value === '0:0:0:0:0:0:0:1') return true
  if (LOOPBACK_V4.test(value)) return true
  return false
}

/**
 * Classify one interception target.
 * `path` names an IPC endpoint (Unix-domain socket or named pipe) and is never a
 * network peer; an HTTP URL path is carried in `urlPath` and is irrelevant here.
 * @param {{host?: unknown, path?: unknown, kind?: string}} target Record fields naming the target.
 * @returns {'local'|'egress'} `local` only when the target cannot leave the machine.
 */
export function classifyTarget(target) {
  const kind = target.kind ?? 'connect'
  if (!NETWORK_KINDS.has(kind)) return 'local'
  if (typeof target.path === 'string' && target.path !== '') return 'local'
  return isLocalHost(target.host) ? 'local' : 'egress'
}

/**
 * Build a regular expression from an allowlist host pattern.
 * `*` matches any run of characters, so `*.deepseek.com` covers subdomains.
 * @param {string} pattern Host pattern from the policy.
 * @returns {RegExp} Anchored, case-insensitive matcher.
 */
export function hostPatternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*')
  return new RegExp(`^${escaped}$`, 'u')
}

/**
 * Decide whether one policy allow rule admits one record.
 * An omitted `port` or `protocol` matches anything; a DNS record is admitted by
 * a rule for the same host, because resolving an allowed host is part of
 * reaching it.
 * @param {{host?: string, port?: number, protocol?: string}} rule Allow rule from the probe.
 * @param {{host?: unknown, port?: unknown, protocol?: unknown, kind?: string}} record Interception record.
 * @returns {boolean} True when the rule admits the record.
 */
export function matchesAllowRule(rule, record) {
  if (typeof rule.host !== 'string' || !hostPatternToRegExp(rule.host).test(normalizeHost(record.host))) return false
  if (rule.port !== undefined && record.port !== undefined && record.port !== null && Number(record.port) !== Number(rule.port)) {
    return false
  }
  if (rule.protocol !== undefined && rule.protocol !== 'any') {
    const protocol = String(record.protocol ?? '')
    if (protocol !== rule.protocol && protocol !== 'dns') return false
  }
  return true
}

/**
 * Find the allow rule that admits one record.
 * @param {ReadonlyArray<object>} allowHosts Rules from the probe's policy entry.
 * @param {object} record Interception record.
 * @returns {object|null} The matching rule, or null when the record is not allowed.
 */
export function findAllowRule(allowHosts, record) {
  for (const rule of allowHosts ?? []) {
    if (matchesAllowRule(rule, record)) return rule
  }
  return null
}

/**
 * Count records by classification and by interception layer.
 * @param {ReadonlyArray<{classification?: string, layer?: string, kind?: string}>} records Records of one probe.
 * @returns {{total: number, local: number, egress: number, byKind: Record<string, number>, byLayer: Record<string, number>}} Counts.
 */
export function summarizeRecords(records) {
  const summary = { total: records.length, local: 0, egress: 0, byKind: {}, byLayer: {} }
  for (const record of records) {
    if (record.classification === 'egress') summary.egress += 1
    else summary.local += 1
    const kind = String(record.kind ?? 'unknown')
    const layer = String(record.layer ?? 'unknown')
    summary.byKind[kind] = (summary.byKind[kind] ?? 0) + 1
    summary.byLayer[layer] = (summary.byLayer[layer] ?? 0) + 1
  }
  return summary
}

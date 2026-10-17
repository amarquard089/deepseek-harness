#!/usr/bin/env node
// Runtime egress gate: the authoritative proof that a booted profile makes no
// outbound connection outside the fork's allowlist.
//
//   node fork/verify-egress.mjs [--root <path>] [--json <path>] [--quiet] [--probe <id>]
//
// Exit 0 = pass, 1 = non-allowlisted egress or a probe that failed its own
// expectations, 2 = the gate could not trust its own evidence (anti-vacuity
// failure) or hit an internal error.
//
// How it proves something instead of proving nothing:
//
//   1. `fork/egress-shim.mjs` is loaded into every probe process through
//      NODE_OPTIONS, and the shim re-propagates itself so children are covered.
//   2. The shim writes a heartbeat at load time carrying its absolute path, its
//      recorder state, and the per-layer installation map.
//   3. Control probes run before the profile probes: one proves the NODE_OPTIONS
//      injection path, one deliberately connects to a closed local port, to two
//      reserved external-looking addresses, and to a reserved DNS name from both
//      the probe process and a spawned child.
//   4. This gate then asserts the evidence exists, that every required
//      interception layer reported `installed`, that each deliberate attempt was
//      recorded and classified as `egress` (which proves the classifier can
//      detect egress at all), and that those same records flow through the
//      violation pipeline.
//
// A missing heartbeat, a missing deliberate record, a layer that failed to
// install, or a shim path that differs from the one this gate injected is
// reported as `status=error` (exit 2). It is never reported as a pass.
//
// The probes are keyless on purpose: there is no `DEEPSEEK_API_KEY` and no
// `.env` in this checkout, so a successful model call is impossible and the
// honest expected egress count during a boot is exactly zero.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  EXIT,
  FORK_ROOT,
  addViolation,
  exitCodeFor,
  finalizeReport,
  loadPolicy,
  newReport,
  parseArgv,
  printReport,
} from './lib/policy.mjs'
import { classifyTarget, findAllowRule, matchesAllowRule, summarizeRecords } from './lib/egress/classify.mjs'
import { runProbe } from './lib/egress/runner.mjs'

/** Gate id; matches the entry in fork/policy/core.json. */
const GATE_ID = 'egress'

/** Layers every probe run must report as installed for the evidence to count. */
const DEFAULT_REQUIRED_LAYERS = ['net', 'tls', 'dns', 'http', 'https', 'fetch']

/** Records embedded verbatim in the JSON report per probe. */
const DEFAULT_MAX_REPORTED_RECORDS = 500

/** Report filename date stamp. */
function dateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

/**
 * Decide whether one expectation entry describes one record.
 * Host patterns, ports, and protocols use the same matching as the allowlist;
 * `kind`, `layer`, and `childOf` add exact constraints.
 * @param {object} expectation Expectation from the probe policy.
 * @param {object} record Interception record.
 * @param {{pid: number|null}} result Probe outcome, for the root pid.
 * @returns {boolean} True when the expectation is satisfied by this record.
 */
export function matchesExpectation(expectation, record, result) {
  if (expectation.kind !== undefined && record.kind !== expectation.kind) return false
  if (expectation.layer !== undefined && record.layer !== expectation.layer) return false
  if (expectation.protocol !== undefined && record.protocol !== expectation.protocol) return false
  if (expectation.pid !== undefined && record.pid !== expectation.pid) return false
  if (expectation.childOf === 'root' && record.pid === result.pid) return false
  if (expectation.classification !== undefined && record.classification !== expectation.classification) return false
  if (expectation.host !== undefined) {
    return matchesAllowRule({ host: expectation.host, port: expectation.port, protocol: expectation.protocol }, record)
  }
  return expectation.port === undefined || Number(record.port) === Number(expectation.port)
}

/**
 * Hash a file so the report names the exact shim that produced the evidence.
 * @param {string} path Absolute file path.
 * @returns {string|null} `sha256:<hex>`, or null when the file cannot be read.
 */
function hashFile(path) {
  try {
    return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
  } catch {
    return null
  }
}

/**
 * Parse the owner's explicit allowlist.
 * The repository ships an empty allowlist; destinations enter it only through
 * this env var or a probe's own `allowHosts`. A bare `*` is refused: an
 * allow-everything entry would make the gate meaningless.
 * @param {unknown} raw Raw env var value.
 * @returns {{entries: object[], invalid: string[]}} Parsed rules and rejected entries.
 */
export function parseOwnerAllowlist(raw) {
  const entries = []
  const invalid = []
  for (const chunk of String(raw ?? '').split(',').map(value => value.trim()).filter(value => value !== '')) {
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/u.exec(chunk)
    if (match === null) {
      invalid.push(`${chunk} (expected host[:port])`)
      continue
    }
    const host = match[1].replace(/^\[/u, '').replace(/\]$/u, '')
    if (host === '*') {
      invalid.push(`${chunk} (a bare * admits every destination and is never accepted)`)
      continue
    }
    entries.push(match[2] === undefined ? { host } : { host, port: Number(match[2]) })
  }
  return { entries, invalid }
}

/**
 * Compare the shim URL a heartbeat reports with the shim this gate injected.
 * Both sides are canonicalized, because a checkout reached through a symlink
 * (macOS `/tmp` for `/private/tmp`) resolves to two spellings of one file.
 * @param {unknown} reported Shim URL from the heartbeat.
 * @param {string} expectedPath Absolute shim path this gate injected.
 * @returns {boolean} True when both name the same file.
 */
export function sameShim(reported, expectedPath) {
  if (typeof reported !== 'string') return false
  if (reported === pathToFileURL(expectedPath).href) return true
  try {
    return realpathSync(fileURLToPath(reported)) === realpathSync(expectedPath)
  } catch {
    return false
  }
}

/**
 * Run one control probe's summary line through the cross-checks that make the
 * anti-vacuity claims self-verifying.
 * @param {object} probe Probe policy entry.
 * @param {object} result Probe outcome.
 * @returns {string[]} Vacuity problems; empty when the control holds.
 */
function checkSelfCheckSummary(probe, result) {
  const problems = []
  const marker = probe.expect.selfCheckMarker
  const line = result.stdout.split('\n').find(candidate => candidate.startsWith(marker))
  if (line === undefined) {
    problems.push(`deliberate self-check printed no ${marker} summary line`)
    return problems
  }
  let summary
  try {
    summary = JSON.parse(line.slice(marker.length).trim())
  } catch (error) {
    problems.push(`deliberate self-check summary is not valid JSON: ${error.message}`)
    return problems
  }
  if (summary.rootPid !== result.pid) {
    problems.push(`self-check rootPid ${summary.rootPid} is not the probe pid ${result.pid}`)
  }
  // The script's declared attempts and the policy's expectations must agree:
  // drift between them would silently weaken the check. The policy omits the
  // port of the closed loopback port, which the script picks at run time.
  const declared = new Map((summary.attempts ?? []).map(attempt => [attempt.host, attempt.port ?? null]))
  for (const expected of probe.expect.records ?? []) {
    if (!declared.has(expected.host)) {
      problems.push(`the policy expects ${expected.host} but the self-check never attempts it`)
      continue
    }
    if (expected.port !== undefined && declared.get(expected.host) !== expected.port) {
      problems.push(`the policy expects ${expected.host}:${expected.port} but the self-check attempts port ${declared.get(expected.host)}`)
    }
  }
  if (summary.localConnect?.errorCode !== 'ECONNREFUSED') {
    problems.push(`the closed local port answered ${JSON.stringify(summary.localConnect)} instead of ECONNREFUSED, so the pass-through path was not exercised`)
  }
  if (summary.dnsError === null || summary.dnsError === undefined) {
    problems.push('the reserved DNS name resolved, so the lookup interceptor was never exercised')
  }
  if (summary.undici?.available !== true) {
    problems.push(`the undici dispatcher layer could not be proven against the repository's own undici dependency: ${summary.undici?.outcome ?? 'no summary'}`)
  }
  if (summary.worker?.code !== 0 || !(summary.worker?.threadId > 0)) {
    problems.push(`the worker-thread attempt did not run inside a worker: ${JSON.stringify(summary.worker)}`)
  } else {
    const workerRecord = result.records.find(record => record.host === probe.expect.workerHost
      && record.threadId === summary.worker.threadId)
    if (workerRecord === undefined) {
      problems.push(`no interception record came from worker thread ${summary.worker.threadId} for ${probe.expect.workerHost}`)
    }
  }
  if (summary.child?.code !== 0 || summary.child?.pid === null || summary.child?.pid === result.pid) {
    problems.push(`the spawned child did not run as a separate process: ${JSON.stringify(summary.child)}`)
  } else {
    const childRecord = result.records.find(record => record.pid === summary.child.pid && record.host === probe.expect.childHost)
    if (childRecord === undefined) {
      problems.push(`no interception record carries the child pid ${summary.child.pid} for ${probe.expect.childHost}`)
    }
  }
  return problems
}

/**
 * Evaluate one probe: vacuity problems (exit 2), expectation failures (exit 1),
 * and the violations from non-allowlisted egress records.
 * @param {object} probe Probe policy entry.
 * @param {object} result Probe outcome from runProbe.
 * @param {{shimPath: string, requiredLayers: string[], ownerAllow?: object[]}} context Gate facts.
 * @returns {{vacuity: string[], failures: string[], violations: object[], exempt: object[],
 *   effectiveAllowHosts: object[], summary: object}} Outcome.
 */
export function evaluateProbe(probe, result, context) {
  const vacuity = []
  const failures = []
  const expectations = probe.expect ?? {}
  const records = result.records

  if (result.spawnError !== null) vacuity.push(`probe could not start: ${result.spawnError}`)
  if (result.logErrors.length > 0) vacuity.push(`evidence file has malformed lines: ${result.logErrors.join('; ')}`)

  const heartbeats = records.filter(record => record.kind === 'heartbeat')
  if (heartbeats.length === 0) {
    vacuity.push('no shim heartbeat: the shim did not load into this probe, so the run proves nothing')
  }
  for (const heartbeat of heartbeats) {
    if (probe.injectShim === false && result.pid !== heartbeat.pid) continue
    if (!sameShim(heartbeat.shim, context.shimPath)) {
      vacuity.push(`heartbeat names shim ${heartbeat.shim} but this gate injected ${context.shimPath}`)
    }
    if (heartbeat.recorderEnabled !== true) {
      vacuity.push(`the recorder disabled itself in the probe: ${heartbeat.recorderProblem}`)
    }
    if (heartbeat.logPath !== result.logPath) {
      vacuity.push(`heartbeat wrote to ${heartbeat.logPath} instead of the gate's evidence file ${result.logPath}`)
    }
    for (const layer of context.requiredLayers) {
      const status = heartbeat.layers?.[layer]
      if (typeof status !== 'string' || !status.startsWith('installed')) {
        vacuity.push(`required interception layer ${layer} is ${JSON.stringify(status)}`)
      }
    }
  }

  // The shim and the gate must agree on every record's classification; a
  // disagreement means one of them is describing a different reality.
  for (const record of records) {
    const derived = classifyTarget(record)
    if (record.classification !== derived) {
      vacuity.push(`record ${record.kind}/${record.host}:${record.port} is classified ${record.classification} by the shim and ${derived} by the gate`)
    }
  }

  for (const expectation of expectations.records ?? []) {
    const matched = records.some(record => matchesExpectation(expectation, record, result))
    if (!matched) {
      vacuity.push(`deliberate attempt was never recorded: ${JSON.stringify(expectation)}`)
    }
  }

  if (expectations.selfCheckMarker !== undefined) vacuity.push(...checkSelfCheckSummary(probe, result))

  const exitCodes = probe.expectExitCodes ?? [0]
  const signalMatches = probe.expectSignal !== undefined && result.signal === probe.expectSignal
  const exitMatches = result.signal === null && exitCodes.includes(result.exitCode)
  if (!exitMatches && !signalMatches) {
    failures.push(`exit ${result.exitCode}${result.signal === null ? '' : ` (signal ${result.signal})`} is not in ${JSON.stringify(exitCodes)}`)
  }
  if (result.timedOut) failures.push(`probe exceeded its ${probe.timeoutMs} ms budget and had to be killed`)
  if (probe.expectAliveMs !== undefined && result.aliveMs === null) {
    failures.push(`probe exited before the ${probe.expectAliveMs} ms liveness window`)
  }
  for (const output of expectations.output ?? []) {
    const text = output.stream === 'stderr' ? result.stderr : result.stdout
    const candidates = output.anyOf ?? (output.contains === undefined ? [] : [output.contains])
    if (candidates.length === 0) continue
    if (!candidates.some(candidate => text.includes(candidate))) {
      failures.push(`${output.stream} contained none of ${JSON.stringify(candidates)} (${output.label ?? 'boot marker'})`)
    }
  }

  // Violations: every egress-classified record that the effective allowlist does
  // not admit. Control probes declare their deliberate attempts, and only those
  // exact records are exempt; anything else still fails the gate.
  const effectiveAllowHosts = [...(probe.allowHosts ?? []), ...(context.ownerAllow ?? [])]
  const violations = []
  const exempt = []
  for (const record of records) {
    if (record.kind === 'heartbeat' || record.kind === 'spawn') continue
    if (classifyTarget(record) !== 'egress') continue
    const declared = (expectations.records ?? []).some(entry => matchesExpectation(entry, record, result))
      || (probe.expectViolations ?? []).some(entry => matchesAllowRule(entry, record))
    if (probe.purpose === 'control' && declared) {
      exempt.push(record)
      continue
    }
    if (findAllowRule(effectiveAllowHosts, record) !== null) continue
    violations.push(record)
  }

  for (const declared of probe.expectViolations ?? []) {
    if (!exempt.some(record => matchesAllowRule(declared, record))) {
      vacuity.push(`the violation pipeline never flagged the deliberate egress ${JSON.stringify(declared)}`)
    }
  }

  // The default posture is zero permitted destinations. When the owner has
  // configured nothing, no deliberate egress record may be admitted: if one is,
  // the allowlist is not empty and the default posture is not being tested.
  if ((context.ownerAllow ?? []).length === 0) {
    for (const record of exempt) {
      if (findAllowRule(probe.allowHosts ?? [], record) !== null) {
        vacuity.push(`the unconfigured allowlist admitted ${record.host}:${record.port ?? '(no port)'}, so zero permitted destinations is not proven`)
      }
    }
    if ((probe.allowHosts ?? []).length > 0) {
      vacuity.push(`probe ${probe.id} declares allowHosts while the owner configured none, so the run is not testing the unconfigured posture`)
    }
  }

  return { vacuity, failures, violations, exempt, effectiveAllowHosts, summary: summarizeRecords(records) }
}

/**
 * Run the gate.
 * @returns {Promise<number>} Process exit code.
 */
async function main() {
  const { flags, values } = parseArgv(process.argv.slice(2))
  const root = resolve(values.get('root') ?? FORK_ROOT)
  const quiet = flags.has('quiet')
  const onlyProbe = values.get('probe')
  const policy = loadPolicy(root)
  const rules = policy.egressRules
  const probes = rules.probes ?? []
  if (probes.length === 0) throw new Error('fork/policy/rules-egress.json declares no probes')

  const reportsDir = join(root, policy.core.reports?.directory ?? 'fork/reports')
  const jsonPath = resolve(values.get('json') ?? join(reportsDir, `${dateStamp()}-egress.json`))
  const logDir = join(reportsDir, 'raw')
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-fork-egress-'))
  const defaults = rules.probeDefaults ?? {}
  const shimPath = join(root, 'fork/egress-shim.mjs')
  const shimUrl = pathToFileURL(shimPath).href
  const requiredLayers = rules.requiredLayers ?? DEFAULT_REQUIRED_LAYERS
  const undiciAnchors = (rules.undiciAnchors ?? []).map(anchor => resolve(root, anchor))

  const report = newReport({ gate: GATE_ID, root })
  report.policyRevision = policy.core.policyRevision
  report.evidence = {
    shim: { path: shimPath, url: shimUrl, sha256: hashFile(shimPath) },
    probes: [],
    environment: {
      keyless: true,
      strippedEnv: [...new Set((rules.probeDefaults?.envStrip ?? []).concat(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']))],
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      undiciAnchors,
    },
    limitations: [],
  }
  for (const limitation of rules.knownLimitations ?? []) report.evidence.limitations.push(limitation)
  for (const skipped of rules.skippedProbes ?? []) {
    report.notes.push(`not booted: ${skipped.id}: ${skipped.reason}`)
  }

  const vacuityProblems = []
  if (!existsSync(shimPath)) {
    throw new Error(`the shim the gate must inject does not exist: ${shimPath}`)
  }

  // The allowlist is empty in this repository. Destinations enter it only from
  // the owner's explicit configuration, never from a shipped default.
  const ownerAllowEnv = rules.allowPolicy?.ownerAllow?.env ?? 'DSH_FORK_EGRESS_ALLOW'
  const ownerAllowRaw = process.env[ownerAllowEnv]
  const ownerAllow = parseOwnerAllowlist(ownerAllowRaw)
  const probeAllowCount = probes.reduce((count, probe) => count + (probe.allowHosts ?? []).length, 0)
  report.evidence.allowlist = {
    ownerEnv: ownerAllowEnv,
    ownerEnvSet: ownerAllowRaw !== undefined && ownerAllowRaw.trim() !== '',
    ownerEntries: ownerAllow.entries,
    probeEntries: probeAllowCount,
    admittedHosts: ownerAllow.entries.length + probeAllowCount,
    admittedPurposes: rules.allowPolicy?.admittedPurposes ?? [],
  }
  if (ownerAllow.invalid.length > 0) {
    vacuityProblems.push(`owner allowlist entries were rejected: ${ownerAllow.invalid.join('; ')}`)
  }
  if (ownerAllow.entries.length === 0) {
    report.notes.push(`allowlist: ${ownerAllowEnv} is unset and every probe declares allowHosts: [], so zero destinations are permitted`)
  } else {
    addViolation(report, {
      ruleId: 'egress.owner-allowlist-active',
      severity: 'warning',
      path: `env:${ownerAllowEnv}`,
      detail: `the owner configured ${ownerAllow.entries.length} allowed destination(s): ${ownerAllow.entries.map(entry => `${entry.host}${entry.port === undefined ? '' : `:${entry.port}`}`).join(', ')}`,
      remedy: 'unset the variable for the unconfigured posture the daily sync requires; a configured run admits exactly these destinations and nothing else',
    })
  }

  mkdirSync(logDir, { recursive: true })
  const selected = probes.filter(probe => (probe.purpose === 'control' ? true : onlyProbe === undefined || probe.id === onlyProbe))
  if (onlyProbe !== undefined && !probes.some(probe => probe.id === onlyProbe)) {
    throw new Error(`--probe ${onlyProbe} does not name a probe in fork/policy/rules-egress.json`)
  }
  if (onlyProbe !== undefined && selected.length === 0) throw new Error('--probe selected no probes')

  for (const probe of selected) {
    const result = await runProbe(probe, { root, shimPath, defaults, undiciAnchors, logDir, homeDir: workDir })
    const outcome = evaluateProbe(probe, result, { shimPath, requiredLayers, ownerAllow: ownerAllow.entries })

    for (const problem of outcome.vacuity) {
      vacuityProblems.push(`${probe.id}: ${problem}`)
    }
    for (const failure of outcome.failures) {
      addViolation(report, {
        ruleId: 'egress.probe-failed',
        severity: 'error',
        path: `fork/policy/rules-egress.json#probes/${probe.id}`,
        detail: failure,
        remedy: `make the probe "${probe.id}" meet its expectations, or update the probe matrix if the boot path legitimately changed`,
      })
    }
    // One violation per distinct target and layer, not per record: a single
    // https.get produces an https, a tls, and possibly a dns record.
    const seen = new Set()
    for (const record of outcome.violations) {
      const key = `${record.layer}|${record.host}|${record.port ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      addViolation(report, {
        ruleId: 'egress.not-allowed',
        severity: 'error',
        path: `probe:${probe.id}`,
        detail: `probe made a non-allowlisted ${record.protocol} egress attempt to ${record.host}:${record.port ?? '(no port)'} (layer ${record.layer}, pid ${record.pid})`,
        remedy: `remove the connection, or add the host to this probe's allowHosts in fork/policy/rules-egress.json when it is model inference, web search/fetch, or an owner-configured MCP server`,
      })
    }

    report.checked += result.records.length
    const maxRecords = rules.reportMaxRecordsPerProbe ?? DEFAULT_MAX_REPORTED_RECORDS
    report.evidence.probes.push({
      id: probe.id,
      description: probe.description,
      purpose: result.purpose,
      command: [result.command, ...result.args].join(' '),
      cwd: result.cwd,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      aliveMs: result.aliveMs,
      durationMs: result.durationMs,
      logPath: (result.logPath.startsWith(root) ? result.logPath.slice(root.length + 1) : result.logPath),
      allowHosts: probe.allowHosts ?? [],
      effectiveAllowHosts: outcome.effectiveAllowHosts,
      counts: outcome.summary,
      expectations: (probe.expect?.records ?? []).map(expectation => ({
        expectation,
        matched: result.records.some(record => matchesExpectation(expectation, record, result)),
      })),
      vacuityProblems: outcome.vacuity,
      failures: outcome.failures,
      deliberateEgress: outcome.exempt.map(record => ({ layer: record.layer, host: record.host, port: record.port, pid: record.pid })),
      records: result.records.slice(0, maxRecords),
      recordsTruncated: result.records.length > maxRecords,
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
    })

    if (!quiet) {
      const status = outcome.vacuity.length > 0 ? 'ERROR' : outcome.failures.length > 0 || outcome.violations.length > 0 ? 'FAIL' : 'pass'
      console.log(
        `[egress] probe ${probe.id}: ${status} records=${outcome.summary.total} local=${outcome.summary.local}`
        + ` egress=${outcome.summary.egress} exit=${result.exitCode ?? result.signal} ${result.durationMs}ms`,
      )
    }
  }

  // A run that never executed the deliberate controls cannot claim anything.
  if (onlyProbe === undefined) {
    const controlIds = probes.filter(probe => probe.purpose === 'control').map(probe => probe.id)
    const ranIds = new Set(report.evidence.probes.map(probe => probe.id))
    for (const controlId of controlIds) {
      if (!ranIds.has(controlId)) vacuityProblems.push(`control probe ${controlId} did not run`)
    }
  } else {
    report.notes.push(`--probe ${onlyProbe}: control probes still ran; only non-control probes were filtered`)
  }

  for (const problem of vacuityProblems) {
    addViolation(report, {
      ruleId: 'egress.evidence-untrustworthy',
      severity: 'error',
      path: 'fork/verify-egress.mjs',
      detail: problem,
      remedy: 'fix the interception or the probe before trusting this gate: a missing heartbeat or a missing deliberate record means the run proves nothing',
    })
  }

  finalizeReport(report)
  if (vacuityProblems.length > 0) {
    report.status = 'error'
    report.notes.push('status=error: the gate could not trust its own evidence, which is never a pass')
  }
  report.notes.push(
    'probes run keylessly: DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL are removed from the probe environment and DSH_HOME points at a throwaway directory, so a model call fails before any request is made',
    `interception evidence came from ${report.evidence.shim.path} (${report.evidence.shim.sha256})`,
  )

  mkdirSync(dirname(jsonPath), { recursive: true })
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  printReport(report)
  const code = report.status === 'error' ? EXIT.error : exitCodeFor(report)
  if (!quiet) console.log(`[egress] report: ${jsonPath}`)
  rmSync(workDir, { recursive: true, force: true })
  return code
}

try {
  process.exitCode = await main()
} catch (error) {
  // An internal failure must never look like a pass: report it and exit 2.
  process.stderr.write(`[egress] internal error: ${error.stack ?? error.message}\n`)
  process.exitCode = EXIT.error
}

// Probe execution for the runtime egress gate.
//
// One probe is one process (or one short-lived process tree) started with the
// shim injected, plus the JSONL evidence it produced. The runner owns:
//
//   * environment construction — a throwaway `DSH_HOME`, no inherited model
//     credentials, the evidence path, and the shim itself;
//   * lifecycle — an optional "must still be alive" window for long-lived
//     servers, then SIGTERM, then SIGKILL;
//   * reading the evidence back, including malformed lines, which are reported
//     rather than skipped.
//
// The runner never decides what the evidence means: fork/verify-egress.mjs owns
// classification, expectations, and violations.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Environment variables that would let a probe reach a real model provider. */
export const ALWAYS_STRIPPED_ENV = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_ORG_ID',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
]

/** Longest captured output kept per stream. */
const OUTPUT_LIMIT_CHARS = 128 * 1024

/**
 * Replace `{shim}`, `{shimPath}`, `{root}`, and `{node}` tokens in one value.
 * @param {unknown} value Value from the policy.
 * @param {{shimUrl: string, shimPath: string, root: string}} context Substitution values.
 * @returns {unknown} The substituted value.
 */
export function substitute(value, context) {
  if (typeof value !== 'string') return value
  return value
    .replaceAll('{shim}', context.shimUrl)
    .replaceAll('{shimPath}', context.shimPath)
    .replaceAll('{root}', context.root)
    .replaceAll('{node}', process.execPath)
}

/**
 * Build the environment for one probe.
 * @param {object} probe Probe policy entry.
 * @param {object} defaults `probeDefaults` from the policy.
 * @param {{root: string, shimUrl: string, shimPath: string, home: string, logPath: string, undiciAnchors: string[]}} context Run context.
 * @returns {NodeJS.ProcessEnv} Environment for the probe process.
 */
export function buildProbeEnv(probe, defaults, context) {
  const env = { ...process.env }
  for (const name of [...ALWAYS_STRIPPED_ENV, ...(defaults.envStrip ?? []), 'NODE_OPTIONS', 'DSH_FORK_EGRESS_LOG', 'DSH_FORK_EGRESS_UNDICI_ANCHORS']) {
    delete env[name]
  }
  Object.assign(env, {
    DSH_HOME: context.home,
    DSH_FORK_EGRESS_LOG: context.logPath,
    DSH_FORK_EGRESS_UNDICI_ANCHORS: context.undiciAnchors.join(process.platform === 'win32' ? ';' : ':'),
    NO_COLOR: '1',
  })
  for (const [name, value] of Object.entries(defaults.env ?? {})) {
    const resolved = substitute(value, context)
    if (resolved === null) delete env[name]
    else env[name] = String(resolved)
  }
  for (const [name, value] of Object.entries(probe.env ?? {})) {
    const resolved = substitute(value, context)
    if (resolved === null) delete env[name]
    else env[name] = String(resolved)
  }
  if (probe.injectShim !== false) {
    // Injected for the probe process itself; the shim then re-propagates the
    // same token through NODE_OPTIONS so children stay covered.
    env.NODE_OPTIONS = `--import ${context.shimUrl}`
  }
  return env
}

/**
 * Read the intervention evidence of one probe.
 * @param {string} logPath JSONL path the shim wrote.
 * @returns {{records: object[], errors: string[]}} Parsed records and malformed-line reports.
 */
export function readEvidence(logPath) {
  if (!existsSync(logPath)) return { records: [], errors: [] }
  const records = []
  const errors = []
  const lines = readFileSync(logPath, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (line.trim() === '') return
    try {
      const record = JSON.parse(line)
      if (record === null || typeof record !== 'object') throw new Error('record is not an object')
      records.push(record)
    } catch (error) {
      errors.push(`${logPath}:${index + 1}: ${error.message}`)
    }
  })
  return { records, errors }
}

/**
 * Start one probe and return its outcome plus its evidence.
 * @param {object} probe Probe policy entry.
 * @param {object} options Run options.
 * @param {string} options.root Repository root the probes run against.
 * @param {string} options.shimPath Shim path inside that root.
 * @param {object} options.defaults `probeDefaults` from the policy.
 * @param {string[]} options.undiciAnchors Absolute undici resolution anchors.
 * @param {string} options.logDir Directory that receives one JSONL file per probe.
 * @param {string} options.homeDir Parent directory for throwaway harness homes.
 * @returns {Promise<object>} Probe outcome, evidence, and raw output.
 */
export async function runProbe(probe, options) {
  const context = {
    root: options.root,
    shimPath: options.shimPath,
    shimUrl: pathToFileURL(options.shimPath).href,
    undiciAnchors: options.undiciAnchors,
    home: mkdtempSync(join(options.homeDir, `${probe.id}-`)),
    logPath: join(options.logDir, `${probe.id}.jsonl`),
  }
  rmSync(context.logPath, { force: true })
  const command = String(substitute(probe.command, context))
  const args = (probe.args ?? []).map(argument => String(substitute(argument, context)))
  const env = buildProbeEnv(probe, options.defaults, context)
  const cwd = substitute(probe.cwd ?? '{root}', context)
  const timeoutMs = probe.timeoutMs ?? options.defaults.timeoutMs ?? 120_000
  const killGraceMs = probe.killGraceMs ?? options.defaults.killGraceMs ?? 5_000
  const expectAliveMs = probe.expectAliveMs ?? 0
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()

  const result = {
    id: probe.id,
    description: probe.description,
    purpose: probe.purpose ?? 'gate',
    command,
    args,
    cwd,
    logPath: context.logPath,
    home: context.home,
    startedAt,
    durationMs: 0,
    exitCode: null,
    signal: null,
    pid: null,
    timedOut: false,
    aliveMs: null,
    spawnError: null,
    stdout: '',
    stderr: '',
    records: [],
    logErrors: [],
  }

  let child
  try {
    child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    result.spawnError = error.message
    result.durationMs = Date.now() - startedMs
    rmSync(context.home, { recursive: true, force: true })
    return result
  }

  const collect = (stream, key) => {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      if (result[key].length < OUTPUT_LIMIT_CHARS) result[key] += chunk
    })
  }
  collect(child.stdout, 'stdout')
  collect(child.stderr, 'stderr')
  result.pid = child.pid ?? null

  let exited = false
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true
      result.exitCode = code
      result.signal = signal
      resolve()
    })
    child.once('error', (error) => {
      exited = true
      result.spawnError = error.message
      resolve()
    })
  })

  /** Wait for the process to leave, or for the given window to close. */
  const waitFor = (ms) => Promise.race([
    exitPromise.then(() => 'exited'),
    new Promise(resolve => { setTimeout(() => { resolve('waiting') }, ms).unref?.() }),
  ])

  const terminate = async () => {
    if (exited) return
    child.kill('SIGTERM')
    if (await waitFor(killGraceMs) === 'exited') return
    child.kill('SIGKILL')
    await waitFor(killGraceMs)
  }

  if (expectAliveMs > 0) {
    if (await waitFor(expectAliveMs) === 'waiting') {
      result.aliveMs = expectAliveMs
      await terminate()
    }
  } else if (await waitFor(timeoutMs) === 'waiting') {
    result.timedOut = true
    await terminate()
  }
  await exitPromise
  result.durationMs = Date.now() - startedMs

  const evidence = readEvidence(context.logPath)
  result.records = evidence.records
  result.logErrors = evidence.errors
  rmSync(context.home, { recursive: true, force: true })
  return result
}

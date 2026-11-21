// Read-only Cloudflare container residency probe for epic #3076 / issue #3085.
//
// Lists the account's container applications, reads each application's detail
// and reports the runtime-reported running instance count per application.
// Applications are classified against the zero-residency manifest
// (cloudflare/zero-residency/manifest.json): every container compute class is
// expected to report zero running instances while the account is idle except
// declarations recorded as always-on-tracked or explicitly allowed with
// --allow. The probe exits non-zero when a non-exempt application reports
// running>0 (or the running count cannot be verified), so a clean idle window
// produces a single command receipt.
//
// Credentials come from the environment or a JSON credentials file; values are
// never printed and application configuration (image, environment variables)
// is deliberately not retained — only the allowlisted fields in `summarize`.
//
//   node scripts/ops/cf-zero-instance-probe.mjs --manifest cloudflare/zero-residency/manifest.json
//   node scripts/ops/cf-zero-instance-probe.mjs --watch --interval 5 --duration 60 \
//     --out e2e/idle-window-<ts>.jsonl --manifest cloudflare/zero-residency/manifest.json
//
// Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (or --secrets-file
// with a JSON object holding the same keys). Exit codes: 0 clean, 1 residency
// violation or unverified count, 2 usage/API failure.

import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const API = 'https://api.cloudflare.com/client/v4'
const ACCOUNT_ID = /^[a-f0-9]{32}$/
const APP_ID = /^[a-zA-Z0-9-]{8,128}$/
const RUNNING_KEYS = ['active', 'assigned', 'starting']
const EXEMPT_MODES = new Set(['always-on-tracked'])
const REQUEST_TIMEOUT_MS = 20_000
const DETAIL_CONCURRENCY = 4

export function parseArgs(argv) {
  const args = { manifest: null, out: null, secretsFile: null, allow: [], watch: false, interval: 5, duration: 60 }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) throw new Error('Expected a value after ' + flag)
      return next
    }
    if (flag === '--manifest') args.manifest = value()
    else if (flag === '--out') args.out = value()
    else if (flag === '--secrets-file') args.secretsFile = value()
    else if (flag === '--allow') args.allow.push(...value().split(',').map(item => item.trim()).filter(Boolean))
    else if (flag === '--watch') args.watch = true
    else if (flag === '--interval') args.interval = Number(value())
    else if (flag === '--duration') args.duration = Number(value())
    else if (flag === '--help' || flag === '-h') args.help = true
    else throw new Error('Unknown argument ' + flag)
  }
  if (args.help) return args
  if (!Number.isFinite(args.interval) || args.interval <= 0) throw new Error('Expected --interval minutes > 0')
  if (!Number.isFinite(args.duration) || args.duration <= 0) throw new Error('Expected --duration minutes > 0')
  if (args.watch && !args.out) throw new Error('--watch evidence requires --out <file.jsonl>')
  return args
}

export function globToRegExp(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 128 || /[^a-zA-Z0-9_*-]/.test(pattern)) {
    throw new Error('Invalid application pattern ' + JSON.stringify(pattern))
  }
  return new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, ch => (ch === '*' ? '.*' : '\\' + ch)) + '$')
}

export function loadManifest(source) {
  const manifest = JSON.parse(source)
  const declarations = (manifest.declarations ?? []).map(entry => {
    if (typeof entry?.appPattern !== 'string' || typeof entry?.mode !== 'string') {
      throw new Error('Manifest declaration missing appPattern/mode')
    }
    return { pattern: entry.appPattern, test: globToRegExp(entry.appPattern), mode: entry.mode,
      ownerIssue: entry.ownerIssue ?? null }
  })
  return { schema: manifest.schema ?? null, declarations }
}

export function classifyApp(name, manifest, allow = []) {
  const declaration = manifest.declarations.find(entry => entry.test.test(name))
  const allowed = allow.some(pattern => globToRegExp(pattern).test(name))
  const mode = declaration?.mode ?? 'undeclared'
  return { declaration: declaration?.pattern ?? null, mode,
    exempt: EXEMPT_MODES.has(mode) || allowed, ownerIssue: declaration?.ownerIssue ?? null }
}

// The detail response carries two health shapes: scheduled applications report
// health.instances {active, assigned} (assigned = Durable-Object-bound, status
// catching up to running) and the other variant reports {active, starting}
// where active covers running-or-stopping. Sum whichever keys the API sent.
// The top-level `instances` field counts placements; a sleeping placement can
// outlive its container, so the runtime-reported health counts gate the result
// and `instances` is kept only as the placement record.
export function runningCount(detail) {
  const health = detail?.health?.instances
  if (health && typeof health === 'object') {
    const parts = RUNNING_KEYS.map(key => (Number.isSafeInteger(health[key]) && health[key] >= 0 ? health[key] : null))
    if (parts.some(value => value !== null)) {
      return { running: parts.reduce((sum, value) => sum + (value ?? 0), 0),
        breakdown: Object.fromEntries(RUNNING_KEYS.filter(key => Number.isSafeInteger(health[key])).map(key => [key, health[key]])) }
    }
  }
  if (Number.isSafeInteger(detail?.instances) && detail.instances >= 0) {
    return { running: detail.instances, breakdown: null }
  }
  return { running: null, breakdown: null }
}

export function summarize(app, detail) {
  const { running, breakdown } = runningCount(detail)
  return {
    name: app.name,
    id: app.id,
    schedulingPolicy: app.scheduling_policy ?? detail?.scheduling_policy ?? null,
    maxInstances: app.max_instances ?? detail?.max_instances ?? null,
    running,
    runningBreakdown: breakdown,
    placements: Number.isSafeInteger(detail?.instances) ? detail.instances : null,
    healthSummary: typeof detail?.health?.summary === 'string' ? detail.health.summary : null,
    updatedAt: app.updated_at ?? detail?.updated_at ?? null,
  }
}

async function credentials(secretsFile) {
  const file = secretsFile ? JSON.parse(await readFile(secretsFile, 'utf8')) : {}
  const token = process.env.CLOUDFLARE_API_TOKEN ?? file.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? file.CLOUDFLARE_ACCOUNT_ID
  if (typeof token !== 'string' || token.length < 10) throw new Error('Missing CLOUDFLARE_API_TOKEN')
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) throw new Error('Missing or invalid CLOUDFLARE_ACCOUNT_ID')
  return { token, accountId }
}

async function cfGet(path, { token, accountId }, fetchImpl, attempt = 0) {
  const response = await fetchImpl(`${API}/accounts/${accountId}${path}`, {
    headers: { authorization: 'Bearer ' + token }, redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if ((response.status === 429 || response.status >= 500) && attempt < 2) {
    await new Promise(resolve => setTimeout(resolve, 1_000 * (attempt + 1)))
    return cfGet(path, { token, accountId }, fetchImpl, attempt + 1)
  }
  const body = await response.json().catch(() => null)
  if (!response.ok || !body || body.success !== true) {
    const codes = Array.isArray(body?.errors) ? body.errors.map(e => e && e.code).filter(c => Number.isSafeInteger(c)) : []
    throw new Error(`Cloudflare API ${path} HTTP ${response.status}${codes.length ? ' errors=' + codes.join(',') : ''}`)
  }
  return body
}

async function listApplications({ token, accountId }, fetchImpl) {
  const apps = []
  let pageToken = null, pages = 0
  do {
    const suffix = pageToken ? `?per_page=500&page_token=${encodeURIComponent(pageToken)}` : '?per_page=500'
    const body = await cfGet(`/containers/applications${suffix}`, { token, accountId }, fetchImpl)
    if (!Array.isArray(body.result)) throw new Error('Cloudflare applications list malformed')
    for (const app of body.result) {
      if (typeof app?.id !== 'string' || !APP_ID.test(app.id) || typeof app?.name !== 'string') {
        throw new Error('Cloudflare application entry malformed')
      }
      apps.push({ id: app.id, name: app.name, scheduling_policy: app.scheduling_policy ?? null,
        max_instances: app.max_instances ?? null, updated_at: app.updated_at ?? null })
    }
    const next = body.result_info?.next_page_token
    pageToken = typeof next === 'string' && next ? next : null
  } while (pageToken && ++pages < 10)
  if (pageToken) throw new Error('Cloudflare applications pagination exceeded')
  return apps
}

async function applicationDetail(id, auth, fetchImpl) {
  const body = await cfGet(`/containers/applications/${encodeURIComponent(id)}`, auth, fetchImpl)
  return body.result && typeof body.result === 'object' ? body.result : {}
}

export async function probe({ token, accountId, manifest, allow = [], fetchImpl = fetch, now = () => new Date() }) {
  const auth = { token, accountId }
  const apps = await listApplications(auth, fetchImpl)
  const applications = []
  for (let i = 0; i < apps.length; i += DETAIL_CONCURRENCY) {
    const batch = apps.slice(i, i + DETAIL_CONCURRENCY)
    const details = await Promise.all(batch.map(app => applicationDetail(app.id, auth, fetchImpl)))
    for (let j = 0; j < batch.length; j++) {
      const record = summarize(batch[j], details[j])
      applications.push({ ...record, ...classifyApp(record.name, manifest, allow) })
    }
  }
  applications.sort((a, b) => a.name.localeCompare(b.name))
  const violations = applications
    .filter(app => !app.exempt && (app.running === null || app.running > 0))
    .map(app => ({ name: app.name, mode: app.mode, running: app.running,
      reason: app.running === null ? 'unverified' : 'running' }))
  const exemptRunning = applications.filter(app => app.exempt && (app.running ?? 0) > 0)
    .map(app => ({ name: app.name, mode: app.mode, running: app.running }))
  return {
    type: 'sample',
    capturedAt: now().toISOString(),
    applications,
    totals: {
      applications: applications.length,
      running: applications.reduce((sum, app) => sum + (app.running ?? 0), 0),
      undeclared: applications.filter(app => app.mode === 'undeclared').length,
      exemptRunning: exemptRunning.length,
    },
    violations, exemptRunning,
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function watch(options) {
  const { intervalMs, durationMs, out, now = () => Date.now() } = options
  const deadline = now() + durationMs
  let samples = 0, flagged = 0
  const startedAt = new Date(now()).toISOString()
  do {
    const began = now()
    const report = await probe(options)
    samples++
    if (report.violations.length > 0) flagged++
    const line = JSON.stringify(report) + '\n'
    if (out) await appendFile(out, line)
    else process.stdout.write(line)
    const remaining = deadline - now()
    if (remaining > 0) await sleep(Math.min(intervalMs - (now() - began), remaining))
  } while (now() < deadline)
  const window = { type: 'window', startedAt, endedAt: new Date(now()).toISOString(),
    samples, flaggedSamples: flagged, clean: flagged === 0 }
  const line = JSON.stringify(window) + '\n'
  if (out) await appendFile(out, line)
  else process.stdout.write(line)
  return window
}

const usage = `Usage:
  cf-zero-instance-probe.mjs [--manifest PATH] [--out FILE] [--secrets-file FILE] [--allow GLOB,...]
  cf-zero-instance-probe.mjs --watch --out FILE.jsonl [--interval MIN] [--duration MIN] [same options]

Credentials: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment,
or a JSON file via --secrets-file. Exit 0 clean, 1 violation/unverified, 2 error.`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(usage); return }
  if (!args.manifest) throw new Error('Expected --manifest <cloudflare/zero-residency/manifest.json>')
  const manifest = loadManifest(await readFile(args.manifest, 'utf8'))
  const auth = await credentials(args.secretsFile)
  if (args.watch) {
    const window = await watch({ ...auth, manifest, allow: args.allow, out: args.out,
      intervalMs: args.interval * 60_000, durationMs: args.duration * 60_000 })
    console.log(JSON.stringify({ ...window, out: args.out }))
    if (!window.clean) process.exitCode = 1
    return
  }
  const report = await probe({ ...auth, manifest, allow: args.allow })
  const output = JSON.stringify(report, null, 2) + '\n'
  if (args.out) await writeFile(args.out, output, { mode: 0o600 })
  else process.stdout.write(output)
  if (report.violations.length > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'cf-zero-instance-probe failed')
    process.exitCode = 2
  })
}

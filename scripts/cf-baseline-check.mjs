#!/usr/bin/env node
// Replayable CF0 guard (issue #3077): fail if a container application or queue
// exists that the zero-compute baseline manifest does not own, so future
// releases cannot introduce an unattributed always-on instance.
//
// Usage: CF_API_TOKEN=... CF_ACCOUNT_ID=... node scripts/cf-baseline-check.mjs
// Offline check (manifest integrity only): node scripts/cf-baseline-check.mjs --offline

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'cloudflare/zero-compute/baseline.json'), 'utf8'))
const offline = process.argv.includes('--offline')
const appPatterns = (manifest.observed?.container_applications?.ownership_patterns ?? []).map(p => new RegExp(p))
const queuePatterns = (manifest.observed?.queues?.ownership_patterns ?? []).map(p => new RegExp(p))

const problems = []
if (manifest.kind !== 'mikka-cf0-baseline') problems.push('manifest kind mismatch')
if (!manifest.evidence_at) problems.push('manifest missing evidence_at')
if (!appPatterns.length) problems.push('manifest has no container ownership patterns')
if (!queuePatterns.length) problems.push('manifest has no queue ownership patterns')
const warm = manifest.observed?.container_applications?.warm_instances_at_snapshot
if (warm) {
  const parts = Object.entries(warm).filter(([k]) => k !== 'total').reduce((n, [, v]) => n + v, 0)
  if (parts !== warm.total) problems.push(`warm instance breakdown ${parts} != declared total ${warm.total}`)
}

const api = async path => {
  const out = []
  let cursor, url = path
  do {
    const r = await fetch(`https://api.cloudflare.com/client/v4${url}`, {
      headers: { authorization: `Bearer ${process.env.CF_API_TOKEN}` },
    })
    const body = await r.json()
    if (!body.success) throw new Error(`CF ${url}: ${JSON.stringify(body.errors)}`)
    out.push(...body.result)
    cursor = body.result_info?.next_page_id ?? null
    url = cursor ? `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : null
  } while (url)
  return out
}

if (!offline) {
  const account = process.env.CF_ACCOUNT_ID ?? manifest.account_id
  if (!process.env.CF_API_TOKEN) { console.error('CF_API_TOKEN required for live check (or use --offline)'); process.exit(2) }
  const apps = await api(`/accounts/${account}/containers/applications`)
  for (const app of apps) {
    if (!appPatterns.some(p => p.test(app.name))) problems.push(`unowned container application: ${app.name}`)
  }
  const queues = await api(`/accounts/${account}/queues`)
  for (const q of queues) {
    if (!queuePatterns.some(p => p.test(q.queue_name))) problems.push(`unowned queue: ${q.queue_name}`)
    if ((q.consumers?.length ?? 0) === 0 && !/(dead|dlq)$/.test(q.queue_name)) problems.push(`live queue with no consumer: ${q.queue_name}`)
  }
  if (problems.length) { console.error(`CF0 baseline check FAILED (account ${account})`); for (const p of problems) console.error(` - ${p}`); process.exit(1) }
  console.log(`CF0 baseline check passed (live, account ${account})`)
  process.exit(0)
}

if (problems.length) { console.error('CF0 baseline check FAILED'); for (const p of problems) console.error(` - ${p}`); process.exit(1) }
console.log('CF0 baseline check passed (offline manifest integrity)')

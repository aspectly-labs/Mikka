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
const knownApps = new Set(manifest.observed.container_applications_with_running_instances.map(a => a.app))
const knownQueues = new Set(manifest.observed.queues)
const offline = process.argv.includes('--offline')

const problems = []
if (manifest.kind !== 'mikka-cf0-baseline' || manifest.version !== 1) problems.push('manifest kind/version mismatch')
if (!manifest.evidence_at) problems.push('manifest missing evidence_at')
if (!manifest.observed?.container_applications_with_running_instances?.length) problems.push('manifest has no container application inventory')

const api = async path => {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { authorization: `Bearer ${process.env.CF_API_TOKEN}` },
  })
  const body = await r.json()
  if (!body.success) throw new Error(`CF ${path}: ${JSON.stringify(body.errors)}`)
  return body.result
}

if (!offline) {
  const account = process.env.CF_ACCOUNT_ID ?? manifest.account_id
  if (!process.env.CF_API_TOKEN) { console.error('CF_API_TOKEN required for live check (or use --offline)'); process.exit(2) }
  const apps = await api(`/accounts/${account}/containers/applications`)
  for (const app of apps) {
    if (!knownApps.has(app.name)) problems.push(`unowned container application: ${app.name}`)
  }
  const queues = await api(`/accounts/${account}/queues`)
  for (const q of queues) {
    if (!knownQueues.has(q.queue_name)) problems.push(`unowned queue: ${q.queue_name}`)
    if ((q.consumers?.length ?? 0) === 0 && !/(dead|dlq)$/.test(q.queue_name)) problems.push(`live queue with no consumer: ${q.queue_name}`)
  }
}

if (problems.length) { console.error('CF0 baseline check FAILED'); for (const p of problems) console.error(` - ${p}`); process.exit(1) }
console.log(`CF0 baseline check passed (${offline ? 'offline manifest integrity' : `live, account ${manifest.account_id}`})`)

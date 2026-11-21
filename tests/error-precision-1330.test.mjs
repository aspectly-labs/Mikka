import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

// #1330: one failure cause, one error (code + detail), one piece of copy.
// Static-source assertions keep this runnable without Postgres; the refusal
// paths themselves are covered by the DB suites.

const source = file => readFileSync(file, 'utf8')
const en = JSON.parse(source('messages/en.json'))
const zh = JSON.parse(source('messages/zh-CN.json'))

test('billing-scope refusals are their own hosted states, not verification_required', () => {
  const hosted = source('lib/billing/hosted-usage.ts')
  for (const code of ['billing_scope_missing', 'billing_owner_missing']) {
    assert.ok(hosted.includes(`'${code}'`), `HOSTED_STATES missing ${code}`)
    assert.ok(new RegExp(`\\b${code}\\b`).test(hosted.match(/hostedRefusal[^{]*\{[\s\S]*?\}/)[0]), `hostedRefusal regex missing ${code}`)
  }
  const runtime = source('lib/coordinator/group-runtime.ts')
  assert.match(runtime, /CodedError\('billing_scope_missing'\)/)
  assert.match(runtime, /CodedError\('billing_owner_missing'\)/)
  assert.ok(!runtime.includes("'verification_required'"), 'group-runtime must not reuse verification_required for a missing scope')
})

test('each new refusal code has flat Billing.refusal copy in both locales', () => {
  for (const code of ['billing_scope_missing', 'billing_owner_missing']) {
    for (const copy of [en.Billing.refusal[code], zh.Billing.refusal[code]]) {
      assert.equal(typeof copy, 'string', `${code}`)
      assert.ok(!/[.。][^.。]+[.。]/.test(copy), `${code}: a status line names the state only, no next-step sentence (R-40)`)
    }
    assert.notEqual(en.Billing.refusal[code], zh.Billing.refusal[code], code)
    assert.ok(!/credit|card|积分|信用/i.test(en.Billing.refusal[code] + zh.Billing.refusal[code]), `${code} copy must not blame credits or cards`)
  }
  const funding = source('lib/cloud-computer/machine-billing.ts')
  for (const code of ['billing_scope_missing', 'billing_owner_missing']) assert.ok(funding.includes(`'${code}'`), `FUNDING_REFUSALS missing ${code}`)
  const failure = source('lib/chat-failure.ts')
  for (const code of ['billing_scope_missing', 'billing_owner_missing']) assert.ok(failure.includes(`'${code}'`), `chat-failure copy mapping missing ${code}`)
})

test('every SubscriptionRefusal in subscription-service names a distinct detail', () => {
  const service = source('lib/subscription-service.ts')
  const bare = [...service.matchAll(/new SubscriptionRefusal\('([a-z_]+)'\s*\)/g)].map(m => m[1])
  assert.deepEqual(bare, [], `bare refusal throws: ${bare}`)
  const details = [...service.matchAll(/SubscriptionRefusal\('([a-z_]+)',\s*\{\s*detail:\s*'([a-z_]+)'/g)].map(m => `${m[1]} (${m[2]})`)
  // account_paused appears twice by design: the same cause at the pre/post-probe reads.
  const counts = details.reduce((map, d) => map.set(d, (map.get(d) ?? 0) + 1), new Map())
  const duplicated = [...counts].filter(([, n]) => n > 1).map(([d]) => d)
  assert.deepEqual(duplicated, ['account_unavailable (account_paused)'])
  assert.ok(details.length >= 15, `expected the split sites, got ${details.length}`)
})

test('every Go Repo.Fail call carries a cause detail for byos_connections.lastErrorCode', () => {
  let calls = 0
  for (const file of readdirSync('packages/subscription-worker').filter(f => f.endsWith('.go') && !f.endsWith('_test.go'))) {
    for (const match of source(`packages/subscription-worker/${file}`).matchAll(/\.Fail\([\s\S]*?"(publication_failed|refresh_failed|projection_failed)"\s*(?:,\s*"([a-z_]+)")?\s*\)/g)) {
      calls++
      assert.ok(match[2] !== undefined || match[1] === 'refresh_failed', `${file}: ${match[1]} without a detail`)
    }
  }
  assert.ok(calls >= 10, `expected the Fail sites, got ${calls}`)
  const repo = source('packages/subscription-worker/repository.go')
  assert.match(repo, /codedText\(code, detail\)/, 'Fail must persist code (detail)')
  // The column's CHECK accepts the serialized shape; a rejected write is
  // silently dropped by the worker's callers and loses the failure reason.
  const check = source('drizzle/20261121120000_byos_last_error_detail.sql')
  for (const code of ['publication_failed', 'refresh_failed', 'projection_failed', 'acquire_expired']) assert.ok(check.includes(code), `constraint missing ${code}`)
  assert.ok(check.includes(' \\('), 'constraint must permit the " (detail)" suffix')
  assert.ok(check.includes('\\))?$'), 'constraint must close the detail suffix')
  assert.match(check, /~ '\^\(/, 'constraint must keep the bounded code prefix')
})

test('group turns keep a coded refusal code instead of generation_failed_not_replayed', () => {
  const turns = source('lib/coordinator/group-turns.ts')
  assert.match(turns, /if \(value instanceof CodedError\) return value\.code/, 'groupGenerationFailure must pass CodedError codes through')
})

test('mailbox commit failures keep the caught error as cause, not the cleanup outcome', () => {
  const mailbox = source('lib/session-mailbox.ts')
  assert.ok(!mailbox.includes('cause: discard'), 'committed/unconfirmed throws must carry the caught error')
})

test('dropped-cause allowlist stays empty after the burn-down', async () => {
  const { droppedCauseAllowlist, staleAllowlistEntries } = await import('../scripts/error-cause-policy.mjs')
  assert.deepEqual(Object.keys(droppedCauseAllowlist), [])
  assert.deepEqual(staleAllowlistEntries(), [])
})

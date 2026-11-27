import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopTelemetry, type TelemetryConfig } from './telemetry'
import { bundledProtocol } from './bundled-protocol'
import { RENDERER_URL } from './bundled-policy'

// A local capture stub stands in for PostHog: nothing here reaches the network.
const KEY = 'phc_testProjectKeyForTheCaptureStub0000'
const config: TelemetryConfig = { key: KEY, host: 'https://capture.test', version: '2026.10000.1940', flavor: 'prod', publicSha: 'a'.repeat(40), overlaySha: 'b'.repeat(40) }

async function harness(t: { after(fn: () => unknown): void }, overrides: { config?: Partial<TelemetryConfig>; cloud?: boolean; userId?: string | null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-telemetry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sent: { url: string; body: { api_key: string; batch: { event: string; properties: Record<string, unknown> }[] } }[] = []
  let now = 1_000_000
  const make = () => new DesktopTelemetry({ ...config, ...overrides.config }, {
    userId: () => (overrides.userId === undefined ? 'user-1' : overrides.userId),
    cloud: () => overrides.cloud ?? true,
  }, {
    file: join(directory, 'telemetry.json'),
    now: () => now,
    send: async (url, init) => { sent.push({ url, body: JSON.parse(String(init.body)) }); return new Response(null, { status: 200 }) },
  })
  return { make, sent, directory, advance: (ms: number) => { now += ms }, events: () => sent.flatMap(request => request.body.batch) }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

test('events pass the web allowlist and carry the platform, version and both source revisions', async t => {
  const { make, sent, events } = await harness(t)
  const telemetry = make()
  telemetry.capture('$pageview', { $current_url: 'mikka://app/mikka/issue/84c182d1-661c-461b-bca2-10410cb646d4?q=private', email: 'private@example.com', distinct_id: 'forged' })
  telemetry.capture('frontend_render_error', { error_name: 'TypeError', boundary: 'right-column', route: '/mikka/issue/84c182d1-661c-461b-bca2-10410cb646d4', message: 'token=secret' })
  telemetry.capture('mikka_message_text', { text: 'never sent' })
  await settle()
  await telemetry.flush()
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.url, 'https://capture.test/batch/')
  assert.equal(sent[0]!.body.api_key, KEY)
  const [pageview, render, ...rest] = events()
  assert.equal(rest.length, 0, 'an event outside the allowlist is dropped')
  const tags = { platform: 'desktop', app_version: '2026.10000.1940', public_sha: 'a'.repeat(40), overlay_sha: 'b'.repeat(40), runtime: 'electron', app: 'mikka', environment: 'production' }
  assert.deepEqual({ ...pageview!.properties }, {
    token: KEY, distinct_id: 'user-1', $process_person_profile: true, $lib: 'mikka-desktop', $lib_version: '2026.10000.1940', ...tags,
    $current_url: 'mikka://app/mikka/issue/:id', $pathname: '/mikka/issue/:id',
  })
  assert.equal(render!.properties.error_name, 'TypeError')
  assert.equal(render!.properties.route, '/mikka/issue/:id')
  assert.equal(JSON.stringify(events()).includes('secret'), false)
  assert.equal(JSON.stringify(events()).includes('private'), false)
})

test('a refused or failed renderer request is reported by its route template, once per window', async t => {
  const { make, events, advance } = await harness(t)
  const telemetry = make()
  const serve = bundledProtocol('/nonexistent', { request: async () => new Response('{}', { status: 500 }) }, failure => telemetry.apiFailure(failure))
  const workspace = '84c182d1-661c-461b-bca2-10410cb646d4'
  // A frame from another origin borrowing main's session, twice: one report.
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await serve(Object.assign(new Request(`${RENDERER_URL}/api/workspaces/${workspace}/ops-metrics`), { initiatorOrigin: 'https://evil.test' }))).status, 403)
  assert.equal((await serve(new Request(`${RENDERER_URL}/api/settings/issue-states`))).status, 500)
  await settle()
  await telemetry.flush()
  assert.deepEqual(events().map(event => [event.event, event.properties.route, event.properties.method, event.properties.status, event.properties.error_code]), [
    ['desktop_api_error', '/api/workspaces/[workspaceId]/ops-metrics', 'GET', 403, 'untrusted_origin'],
    ['desktop_api_error', '/api/settings/[read]', 'GET', 500, undefined],
  ])
  assert.equal(JSON.stringify(events()).includes(workspace), false, 'no id from the path')
  advance(11 * 60_000)
  telemetry.apiFailure({ route: '/api/settings/[read]', method: 'GET', status: 500 })
  await settle()
  await telemetry.flush()
  assert.equal(events().length, 3, 'reported again after the window')
})

test('main-process errors report their class only', async t => {
  const { make, events } = await harness(t)
  const telemetry = make()
  telemetry.mainError(new RangeError('/Users/someone/private.txt'), 'uncaught_exception')
  telemetry.mainError('plain string rejection', 'unhandled_rejection')
  telemetry.processGone('renderer', 'crashed')
  telemetry.processGone('renderer', 'clean-exit')
  await settle()
  await telemetry.flush()
  assert.deepEqual(events().map(event => [event.event, event.properties.error_name ?? event.properties.reason, event.properties.error_source ?? event.properties.process_type]), [
    ['desktop_main_error', 'RangeError', 'uncaught_exception'],
    ['desktop_main_error', 'Error', 'unhandled_rejection'],
    ['desktop_process_gone', 'crashed', 'renderer'],
  ])
  assert.equal(JSON.stringify(events()).includes('someone'), false)
})

test('the Settings choice is remembered, and turning it off sends nothing more', async t => {
  const { make, sent, directory } = await harness(t)
  const first = make()
  assert.deepEqual(await first.state(), { available: true, enabled: true }, 'on by default')
  first.capture('$pageview', {})
  await settle()
  assert.deepEqual(await first.setEnabled(false), { available: true, enabled: false })
  await first.flush()
  assert.equal(sent.length, 0, 'what was queued is dropped')
  const stored = JSON.parse(await readFile(join(directory, 'telemetry.json'), 'utf8'))
  assert.equal(stored.enabled, false)
  assert.equal(Object.keys(stored).sort().join(), 'anonymousId,enabled')
  const restarted = make()
  assert.deepEqual(await restarted.state(), { available: true, enabled: false })
  restarted.capture('$pageview', {})
  restarted.apiFailure({ route: '/api/inbox', method: 'GET', status: 503, code: 'desktop_backend_unavailable' })
  await settle()
  await restarted.flush()
  assert.equal(sent.length, 0)
  await assert.rejects(restarted.setEnabled('yes' as never))
})

test('a build without a PostHog key, or an account on a self-hosted server, sends nothing', async t => {
  for (const overrides of [{ config: { key: '' } }, { cloud: false }]) {
    const { make, sent } = await harness(t, overrides)
    const telemetry = make()
    telemetry.capture('$pageview', {})
    telemetry.apiFailure({ route: '/api/inbox', method: 'GET', status: 503 })
    await settle()
    await telemetry.flush()
    assert.equal(sent.length, 0)
    assert.equal((await telemetry.state()).available, false)
  }
})

test('signed out, events use the anonymous id and create no person profile', async t => {
  const { make, events } = await harness(t, { userId: null })
  const telemetry = make()
  telemetry.capture('$pageview', {})
  await settle()
  await telemetry.flush()
  const [event] = events()
  assert.match(String(event!.properties.distinct_id), /^[0-9a-f-]{36}$/)
  assert.equal(event!.properties.$process_person_profile, false)
})

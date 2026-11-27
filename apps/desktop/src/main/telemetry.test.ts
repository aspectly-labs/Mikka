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
  const make = () => latest = new DesktopTelemetry({ ...config, ...overrides.config }, {
    userId: () => (overrides.userId === undefined ? 'user-1' : overrides.userId),
    cloud: () => overrides.cloud ?? true,
  }, {
    file: join(directory, 'telemetry.json'),
    now: () => now,
    send: async (url, init) => { sent.push({ url, body: JSON.parse(String(init.body)) }); return new Response(null, { status: 200 }) },
  })
  return { make, sent, directory, advance: (ms: number) => { now += ms }, events: () => sent.flatMap(request => request.body.batch) }
}

let latest: DesktopTelemetry | undefined
/** Waits out the first read of telemetry.json and main's report → capture hop, not a fixed time alone. */
const settle = async () => {
  for (let hop = 0; hop < 3; hop++) await latest?.state()
  await new Promise(resolve => setTimeout(resolve, 20))
}

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

test('reports are limited per hour, and nothing is counted while sharing is off', async t => {
  const { make, events, advance } = await harness(t)
  const telemetry = make()
  await telemetry.setEnabled(false)
  telemetry.apiFailure({ route: '/api/inbox', method: 'GET', status: 503 })
  for (let index = 0; index < 250; index++) telemetry.mainError(Object.assign(new Error('x'), { name: `Off${index}` }), 'uncaught_exception')
  await settle()
  await telemetry.setEnabled(true)
  // The failure seen while off was neither sent nor recorded, so it is reported now.
  telemetry.apiFailure({ route: '/api/inbox', method: 'GET', status: 503 })
  for (let index = 0; index < 250; index++) telemetry.mainError(Object.assign(new Error('x'), { name: `On${index}` }), 'uncaught_exception')
  await settle()
  await telemetry.flush()
  assert.equal(events().length, 200, 'the hour allows 200 reports')
  assert.equal(events()[0]!.properties.route, '/api/inbox')
  advance(30 * 60_000)
  telemetry.mainError(Object.assign(new Error('x'), { name: 'Later' }), 'uncaught_exception')
  await settle()
  await telemetry.flush()
  assert.equal(events().length, 200, 'still within the same hour')
  advance(31 * 60_000)
  telemetry.mainError(Object.assign(new Error('x'), { name: 'NextHour' }), 'uncaught_exception')
  await settle()
  await telemetry.flush()
  assert.equal(events().length, 201, 'a new hour, not a new process')
})

test('renderer events have their own hourly limit, apart from main\'s reports', async t => {
  const { make, events, advance } = await harness(t)
  const telemetry = make()
  for (let index = 0; index < 600; index++) telemetry.capture('frontend_runtime_error', { error_name: 'TypeError', error_source: 'window_error', route: '/mikka' })
  telemetry.mainError(Object.assign(new Error('x'), { name: 'MainStillReports' }), 'uncaught_exception')
  await settle()
  await telemetry.flush()
  assert.equal(events().filter(event => event.event === 'frontend_runtime_error').length, 500, 'the hour allows 500 renderer events')
  assert.equal(events().filter(event => event.event === 'desktop_main_error').length, 1, 'a flooding page does not crowd out main')
  advance(61 * 60_000)
  telemetry.capture('frontend_runtime_error', { error_name: 'TypeError', error_source: 'window_error', route: '/mikka' })
  await settle()
  await telemetry.flush()
  assert.equal(events().filter(event => event.event === 'frontend_runtime_error').length, 501, 'a new hour')
})

test('a shared artifact, shared thread or invitation page never sends its token', async t => {
  const { make, events } = await harness(t)
  const telemetry = make()
  const tokens = ['mks_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf', 'mkt_QwErTyUiOpAsDfGhJkLzXcVbNmQwEr', 'ab'.repeat(32)]
  for (const path of [`/mikka/a/${tokens[0]}`, `/mikka/en/threads/shared/${tokens[1]}`, `/mikka/organization-invite/${tokens[2]}`, `/mikka/en/invite/${tokens[2]}`]) {
    telemetry.capture('$pageview', { $current_url: `mikka://app${path}` })
    telemetry.capture('frontend_web_vitals', { route: path, lcp_ms: 1200, flush_reason: 'pagehide' })
  }
  await settle()
  await telemetry.flush()
  assert.deepEqual(events().filter(event => event.event === '$pageview').map(event => event.properties.$pathname), ['/mikka/a/:token', '/mikka/en/threads/shared/:token', '/mikka/organization-invite/:token', '/mikka/en/invite/:token'])
  assert.deepEqual(events().filter(event => event.event === 'frontend_web_vitals').map(event => event.properties.route), ['/mikka/a/:token', '/mikka/en/threads/shared/:token', '/mikka/organization-invite/:token', '/mikka/en/invite/:token'])
  for (const token of tokens) assert.equal(JSON.stringify(events()).includes(token), false)
})

test('a path the renderer already sanitized comes out of main unchanged', async t => {
  const { make, events } = await harness(t)
  const telemetry = make()
  // apps/desktop/src/renderer/analytics.ts sends analyticsPath's result; main sanitizes it again.
  for (const path of ['/mikka/issue/:id', '/mikka/en/invite/:token/users/:redacted/:id', '/mikka/w/:slug']) telemetry.capture('$pageview', { $current_url: `mikka://app${path}` })
  await settle()
  await telemetry.flush()
  assert.deepEqual(events().map(event => event.properties.$pathname), ['/mikka/issue/:id', '/mikka/en/invite/:token/users/:redacted/:id', '/mikka/w/:slug'])
})

test('a renderer exception keeps its class and in-app frames, never its message', async t => {
  const { make, events } = await harness(t)
  const telemetry = make()
  telemetry.capture('$exception', { $exception_level: 'error', $exception_list: [{
    type: 'TypeError', value: 'Cannot read secret-note of a@b.example at /Users/someone/x',
    mechanism: { type: 'onerror', handled: false },
    stacktrace: { frames: [{ in_app: true, filename: 'mikka://app/mikka/assets/index-abc.js', function: 'render', lineno: 3, colno: 9 }] },
  }] })
  await settle()
  await telemetry.flush()
  const [exception] = events()
  const [entry] = exception!.properties.$exception_list as { type: string; value: string; stacktrace?: { frames: { function: string }[] } }[]
  assert.equal(entry!.type, 'TypeError')
  assert.equal(entry!.value, 'TypeError')
  assert.equal(entry!.stacktrace?.frames[0]?.function, 'render')
  for (const word of ['secret-note', 'a@b.example', 'someone', 'Cannot read']) assert.equal(JSON.stringify(events()).includes(word), false, word)
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

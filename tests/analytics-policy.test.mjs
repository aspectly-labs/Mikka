import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { applicationPlugin } from '../apps/frontend/scripts/application-plugin.mjs'
import { uiFixture } from '../apps/frontend/scripts/application-test-build.mjs'
import { needsOfficialUi, readUi, uiExists } from '../scripts/official-ui-tree.mjs'
import { analyticsPath, redactReplayRequest, sanitizeAnalyticsEvent } from '../lib/analytics-policy.ts'
import { safeLanding } from '../lib/first-touch.ts'
import { computerAcceptancePreview, computerProductionEnabled, featureAvailability, gatedFeatureEnabled, gatedFeatures, killSwitches, proactiveFeatures, upcomingFeatures } from '../lib/feature-flags.ts'
import { analyticsEnvironment, analyticsKey, analyticsPaths, inspectAnalyticsBuild, localAnalyticsRequest, requiredRuntimeResources, syntheticPostHogRequest, verifyRuntimeResources } from '../scripts/check-analytics-ssr.mjs'
import { analyticsBrowserProfile } from '../scripts/analytics-browser-sandbox.mjs'
import { POSTER_BINARY_ARCHIVE, POSTER_BINARY_MANIFEST, POSTER_LICENSE_FILES, POSTER_RUNTIME_DIRECTORY } from '../lib/captures/poster-binary.mjs'

test('pageviews strip query strings, hashes, document identifiers and unapproved properties', () => {
  const event = sanitizeAnalyticsEvent({ event: '$pageview', properties: {
    $current_url: 'https://example.com/documents/01234567-89ab-cdef-0123-456789abcdef?email=private@example.com#secret',
    token: 'public-project-token', distinct_id: 'opaque-user-id', section: 'general',
    email: 'private@example.com', name: 'Private Name', $referrer: 'https://example.com/?token=secret',
    $set: { email: 'private@example.com' }, $initial_current_url: 'https://example.com/?token=secret',
    $exception_list: ['private'], description: 'private document content',
  } })
  assert.deepEqual(event.properties, {
    token: 'public-project-token', distinct_id: 'opaque-user-id', section: 'general',
    $current_url: 'https://example.com/documents/:id', $pathname: '/documents/:id',
  })
  assert.equal(analyticsPath('/settings/teams'), '/settings/teams')
  assert.equal(analyticsPath('/invite/private-invitation-token'), '/invite/:token')
})

test('a share link or invitation never leaves in a route: pageviews, errors, RUM, replay and landing pages', () => {
  // The tokens these pages carry open what they name (lib/artifacts/store.ts mks_,
  // lib/thread-lifecycle.ts mkt_, lib/captures/store.ts mkc_, 64-hex invitations).
  const artifact = 'mks_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf' // no digit: the old opaque-id rule let it through
  const thread = 'mkt_Q1wErTyUiOpAsDfGhJkLzXcVbNmQwEr'
  const invitation = 'ab'.repeat(32)
  const pages = [
    [`/a/${artifact}`, '/a/:token'],
    [`/en/a/${artifact}`, '/en/a/:token'],
    [`/mikka/zh-CN/a/${artifact}/frame`, '/mikka/zh-CN/a/:token/frame'],
    [`/threads/shared/${thread}`, '/threads/shared/:token'],
    [`/mikka/en/threads/shared/${thread}`, '/mikka/en/threads/shared/:token'],
    [`/organization-invite/${invitation}`, '/organization-invite/:token'],
    [`/en/invite/${invitation}`, '/en/invite/:token'],
    [`/mikka/invite/${invitation}`, '/mikka/invite/:token'],
    [`/share/${thread}`, '/share/:token'],
    ['/w/acme-corp', '/w/:slug'],
    ['/en/tasks/SPOT-4', '/en/tasks/:token'],
    ['/en/oauth/tok_abc1234567890xyz', '/en/oauth/:token'],
    ['/en/issue/84c182d1-661c-461b-bca2-10410cb646d4/987654', '/en/issue/:id/:id'],
    ['/settings/members', '/settings/members'],
    [`/captures/${'0f'.repeat(16)}`, '/captures/:token'],
    ['/en/reset-password', '/en/reset-password'],
    ['/mikka', '/mikka'],
    ['/', '/'],
  ]
  for (const [path, expected] of pages) {
    assert.equal(analyticsPath(path), expected, path)
    for (const origin of ['https://app.aspectlylabs.com', 'mikka://app']) {
      const pageview = sanitizeAnalyticsEvent({ event: '$pageview', properties: { $current_url: `${origin}${path}?token=${artifact}#${thread}` } })
      assert.equal(pageview.properties.$pathname, expected)
      assert.equal(pageview.properties.$current_url, `${origin}${expected}`)
      const exception = sanitizeAnalyticsEvent({ event: '$exception', properties: { $current_url: `${origin}${path}`, $exception_list: [{ type: 'TypeError', value: 'x' }] } })
      assert.equal(exception.properties.$pathname, expected)
    }
    const rum = sanitizeAnalyticsEvent({ event: 'frontend_web_vitals', properties: { route: path, lcp_ms: 900, flush_reason: 'pagehide' } })
    assert.equal(rum.properties.route, expected)
    // Replay's navigation metadata (rrweb's page href) and request names use the same route.
    assert.equal(redactReplayRequest({ name: `https://app.aspectlylabs.com${path}?code=private` }).name, `https://app.aspectlylabs.com${expected}`)
    assert.ok(![artifact, thread, invitation].some(token => safeLanding(path).includes(token)), path)
  }
})

test('sanitizing twice is sanitizing once: the desktop renderer\'s path, sanitized again by main, keeps its placeholders', () => {
  const uuid = '84c182d1-661c-461b-bca2-10410cb646d4'
  const paths = [
    `/mikka/issue/${uuid}`, '/en/invite/PRIVATE_INVITE_CODE/users/alice@example.com/987654', '/a/mks_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf/frame',
    `/mikka/en/threads/shared/mkt_${'Q1'.repeat(16)}`, '/w/acme-corp/settings', '/en/tasks/SPOT-4', '/settings/members', '/', '/mikka',
    `/en/${Array.from({ length: 40 }, (_, index) => `section-${'x'.repeat(index % 7)}/${uuid}`).join('/')}`,
  ]
  for (const path of paths) {
    const once = analyticsPath(path)
    assert.equal(analyticsPath(once), once, path)
    // What apps/desktop/src/renderer/analytics.ts sends, then main's own pass (apps/desktop/src/main/telemetry.ts).
    for (const origin of ['mikka://app', 'https://app.aspectlylabs.com']) {
      const direct = sanitizeAnalyticsEvent({ event: '$pageview', properties: { $current_url: `${origin}${path}?q=private` } })
      const renderer = sanitizeAnalyticsEvent({ event: '$pageview', properties: { $current_url: `${origin}${analyticsPath(path)}` } })
      assert.deepEqual(renderer.properties, direct.properties, path)
      assert.deepEqual(sanitizeAnalyticsEvent(direct).properties, direct.properties, path)
    }
    const rum = sanitizeAnalyticsEvent({ event: 'frontend_web_vitals', properties: { route: path, lcp_ms: 900, flush_reason: 'pagehide' } })
    assert.equal(sanitizeAnalyticsEvent(rum).properties.route, rum.properties.route, path)
    assert.ok(rum.properties.route.length <= 160)
  }
  assert.equal(analyticsPath('/mikka/issue/:id'), '/mikka/issue/:id')
  assert.equal(analyticsPath('/en/invite/:token/users/:redacted/:id'), '/en/invite/:token/users/:redacted/:id')
  assert.equal(analyticsPath('/w/:slug'), '/w/:slug')
})

test('automatic top-level person mutations are stripped without losing ingestion metadata', () => {
  const event = sanitizeAnalyticsEvent({
    event: '$identify', uuid: 'event-id', timestamp: '2026-10-21T00:00:00Z',
    properties: { distinct_id: 'opaque-user-id' },
    $set: { email: 'private@example.com' },
    $set_once: { $initial_current_url: 'https://example.com/?token=private' },
    $unset: ['private-property'],
  })
  assert.deepEqual(event, {
    event: '$identify', uuid: 'event-id', timestamp: '2026-10-21T00:00:00Z',
    properties: { distinct_id: 'opaque-user-id' },
  })
})

test('unknown events never pass the allowlist, and an exception without a usable entry is dropped', () => {
  for (const event of ['$autocapture', '$exception_steps', 'unknown']) {
    assert.equal(sanitizeAnalyticsEvent({ event, properties: {} }), null)
  }
  for (const properties of [{}, { $exception_list: 'private' }, { $exception_list: ['private'] }, { $exception_list: [null] }]) {
    assert.equal(sanitizeAnalyticsEvent({ event: '$exception', properties }), null)
  }
  assert.equal(sanitizeAnalyticsEvent(null), null)
  assert.deepEqual(sanitizeAnalyticsEvent({ event: '$pageview', properties: { $current_url: 'not a url' } }).properties, {})
  assert.deepEqual(sanitizeAnalyticsEvent({ event: 'mikka_team_created', properties: { name: 'private' } }).properties, {})
})

test('an exception keeps its type, a scrubbed message and only the in-app stack', () => {
  const event = sanitizeAnalyticsEvent({
    event: '$exception', uuid: 'event-id',
    properties: {
      token: 'public-project-token', distinct_id: 'opaque-user-id', $session_id: 'session', $browser_type: 'browser',
      $current_url: 'https://example.com/documents/01234567-89ab-cdef-0123-456789abcdef?email=private@example.com#secret',
      $exception_level: 'error',
      $exception_list: [{
        type: 'TypeError',
        value: "Cannot read 'segment' of undefined for bob@example.com from 10.1.2.3 at /Users/alex/Desktop/vibe/Mikka — token=PRIVATE_MESSAGE_CANARY",
        mechanism: { type: 'onunhandledrejection', handled: false, synthetic: false, syntheticException: new Error('PRIVATE_MECHANISM_CANARY') },
        stacktrace: { type: 'raw', frames: [
          { platform: 'web:javascript', filename: 'https://app.aspectlylabs.com/mikka/assets/index-abc.js?token=private#frag', function: 'renderReader', in_app: true, lineno: 12, colno: 340, chunk_id: 'private', module: 'private' },
          { platform: 'web:javascript', filename: 'file:///Users/alex/Desktop/vibe/Mikka/apps/frontend/src/index.tsx', function: 'boot', in_app: true, lineno: 3, colno: 4, private: 'PRIVATE_FRAME_CANARY' },
          { platform: 'web:javascript', filename: 'chrome-extension://abcdef/private.js', function: 'injected', in_app: false, lineno: 1, colno: 2 },
          { platform: 'web:javascript', filename: 'https://cdn.example.com/vendor.js', function: 'vendor', in_app: false, lineno: 9, colno: 9 },
        ] },
      }],
      $exception_steps: [{ message: 'PRIVATE_BREADCRUMB_CANARY' }],
      $sentry_event_id: 'PRIVATE_SENTRY_CANARY',
      $set: { email: 'private@example.com' },
    },
    $set_once: { $initial_current_url: 'https://example.com/?token=private' },
  })
  assert.equal(JSON.stringify(event).includes('PRIVATE_'), false)
  assert.equal(JSON.stringify(event).includes('private@example.com'), false)
  assert.deepEqual(event, {
    event: '$exception', uuid: 'event-id',
    properties: {
      token: 'public-project-token', distinct_id: 'opaque-user-id', $session_id: 'session', $browser_type: 'browser',
      $current_url: 'https://example.com/documents/:id', $pathname: '/documents/:id',
      $exception_level: 'error',
      $exception_list: [{
        type: 'TypeError',
        value: "Cannot read 'segment' of undefined for [email] from [ip] at [home] — token=[redacted]",
        mechanism: { type: 'onunhandledrejection', handled: false, synthetic: false },
        stacktrace: { type: 'raw', frames: [
          { platform: 'web:javascript', in_app: true, filename: 'https://app.aspectlylabs.com/mikka/assets/index-abc.js', function: 'renderReader', lineno: 12, colno: 340 },
          { platform: 'web:javascript', in_app: true, filename: 'file://[home]', function: 'boot', lineno: 3, colno: 4 },
        ] },
      }],
    },
  })
  const unnamed = sanitizeAnalyticsEvent({ event: '$exception', properties: { $exception_list: [{ type: 42, value: 'boom' }], $browser_type: 'private' } })
  assert.deepEqual(unnamed.properties, { $exception_list: [{ type: 'Error', value: 'boom', mechanism: { type: 'generic', handled: true, synthetic: false } }] })
})

test('an exception message never carries a token or a path back to the user', () => {
  const message = value => sanitizeAnalyticsEvent({ event: '$exception', properties: { $exception_list: [{ type: 'Error', value }] } }).properties.$exception_list[0].value
  assert.equal(message('Authorization: Bearer PRIVATE_CANARY_TOKEN'), 'Authorization: Bearer [redacted]')
  assert.equal(message('POST /api/x failed: token=PRIVATE_CANARY_TOKEN'), 'POST /api/x failed: token=[redacted]')
  assert.equal(message('api_key: PRIVATE_CANARY_TOKEN'), 'api_key: [redacted]')
  assert.equal(message('upload of sk-PRIVATE-CANARY-TOKEN failed'), 'upload of [redacted] failed')
  assert.equal(message(`invalid ${['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'PRIVATE_CANARY_TOKEN'].join('.')}`), 'invalid [redacted]')
  assert.equal(message('fetch https://api.example.com/v1/x?token=private#frag failed'), 'fetch https://api.example.com/v1/x failed')
  assert.equal(message('cannot read /Users/alex/Desktop/vibe/Mikka/private.txt'), 'cannot read [home]')
  assert.equal(message('from bob@example.com at 10.1.2.3'), 'from [email] at [ip]')
  assert.equal(message(undefined), 'Error')
})

test('an exception\'s message, frame file and function name carry a share or invitation path only as placeholders', () => {
  const artifact = 'mks_Ab3dEf9hIjKlMnOpQrStUvWxYz012345'
  const event = sanitizeAnalyticsEvent({ event: '$exception', properties: { $exception_list: [{
    type: 'Error', value: `failed /a/${artifact} and https://app.aspectlylabs.com/mikka/en/threads/shared/mkt_${'Q1'.repeat(16)}?x=1 then GET /api/workspaces/84c182d1-661c-461b-bca2-10410cb646d4/ops`,
    stacktrace: { frames: [
      { in_app: true, filename: `https://app.aspectlylabs.com/mikka/a/${artifact}`, function: `load(/invite/${'ab'.repeat(32)})`, lineno: 1, colno: 2 },
      { in_app: true, filename: 'https://app.aspectlylabs.com/mikka/assets/index-B3x9qZ1a.js', function: 'render', lineno: 10, colno: 20 },
      { in_app: true, filename: `mikka://app/mikka/A/${artifact}`, function: 'f', lineno: 3, colno: 4 },
    ] },
  }] } })
  const [entry] = event.properties.$exception_list
  assert.equal(entry.value, 'failed /a/:token and https://app.aspectlylabs.com/mikka/en/threads/shared/:token then GET /api/workspaces/:id/ops')
  assert.deepEqual(entry.stacktrace.frames.map(frame => [frame.filename, frame.function]), [
    ['https://app.aspectlylabs.com/mikka/a/:token', 'load(/invite/:token)'],
    ['https://app.aspectlylabs.com/mikka/assets/index-B3x9qZ1a.js', 'render'],
    ['mikka://app/mikka/:token/:token', 'f'],
  ])
  assert.equal(JSON.stringify(event).includes(artifact), false)
})

test('a share page\'s word matches in any case, replay keeps the desktop origin, and a landing page is never a dynamic path', () => {
  assert.equal(analyticsPath('/A/abcdefghij'), '/:token/:token')
  assert.equal(analyticsPath('/Threads/Shared/abcdefghij'), '/:token/:token/:token')
  assert.equal(analyticsPath('/en/INVITE/abcdefghij'), '/en/:token/:token')
  assert.equal(redactReplayRequest({ name: 'mikka://app/mikka/a/mks_x?q=1' }).name, 'mikka://app/mikka/a/:token')
  for (const path of ['/pricing', '/docs/getting-started']) assert.equal(safeLanding(path), path)
  for (const path of ['/blog/post-2026', '/tasks/abc123', '/users/alice@example.com']) assert.equal(safeLanding(path), '/', path)
})

test('a megabyte route, URL or message is sanitized in bounded time', () => {
  const huge = `/a/${'x'.repeat(1 << 20)}`
  const deep = '/s'.repeat(1 << 19)
  const started = performance.now()
  for (const route of [huge, deep, `${'/settings'.repeat(100_000)}`]) {
    const rum = sanitizeAnalyticsEvent({ event: 'frontend_web_vitals', properties: { route, lcp_ms: 1, flush_reason: 'pagehide' } })
    assert.ok(rum.properties.route.length <= 160)
    sanitizeAnalyticsEvent({ event: '$pageview', properties: { $current_url: `https://app.aspectlylabs.com${route}` } })
    sanitizeAnalyticsEvent({ event: '$exception', properties: { $exception_list: [{ type: 'Error', value: route, stacktrace: { frames: [{ in_app: true, filename: `https://x.test${route}`, function: route }] } }] } })
    redactReplayRequest({ name: `https://app.aspectlylabs.com${route}` })
  }
  const elapsed = performance.now() - started
  assert.ok(elapsed < 1000, `took ${Math.round(elapsed)} ms`)
})

test('masked replay keeps only its transport payload and cannot mutate a person', () => {
  const payload = [{ type: 2, data: { node: { textContent: '***' } } }]
  const event = sanitizeAnalyticsEvent({ event: '$snapshot', properties: { $snapshot_data: payload, $snapshot_bytes: 10, $session_id: 'session', distinct_id: 'person', prompt: 'private', $current_url: 'https://example.com/?token=private' } })
  assert.deepEqual(event.properties, { $snapshot_data: payload, $snapshot_bytes: 10, $session_id: 'session', distinct_id: 'person' })
  const source = readFileSync(new URL('../lib/analytics/posthog-init.ts', import.meta.url), 'utf8')
  assert.match(source, /maskAllInputs: true/)
  assert.match(source, /maskTextSelector: '\*'/)
  assert.match(source, /maskAllElementAttributes: true/)
  assert.match(source, /recordHeaders: false/)
  assert.match(source, /recordBody: false/)
})

test('SDK browser classification keeps only bot or browser on normal events and masked Replay', () => {
  const payload = [{ type: 2, data: { node: { textContent: '***' } } }]
  for (const event of ['$pageview', '$snapshot']) {
    for (const browserType of ['bot', 'browser']) {
      const properties = { $browser_type: browserType, $session_id: 'session', $raw_user_agent: 'PRIVATE_UA_CANARY',
        userAgent: 'PRIVATE_UA_CANARY', private: 'PRIVATE_CLASSIFICATION_CANARY',
        ...(event === '$snapshot' ? { $snapshot_data: payload, $snapshot_bytes: 10 } : {}) }
      const sanitized = sanitizeAnalyticsEvent({ event, properties })
      assert.deepEqual(sanitized.properties, { $browser_type: browserType, $session_id: 'session',
        ...(event === '$snapshot' ? { $snapshot_data: payload, $snapshot_bytes: 10 } : {}) })
      if (event === '$snapshot') assert.equal(sanitized.properties.$snapshot_data, payload)
      assert.equal(JSON.stringify(sanitized).includes('PRIVATE_'), false)
    }
    for (const value of [undefined, null, true, 1, 'BOT', 'human', 'bot ', 'private@example.invalid', 'x'.repeat(4096), { type: 'bot' }]) {
      const sanitized = sanitizeAnalyticsEvent({ event, properties: { $browser_type: value } })
      assert.equal(Object.hasOwn(sanitized.properties, '$browser_type'), false)
      assert.deepEqual(sanitized.properties, {})
    }
  }
  assert.equal(sanitizeAnalyticsEvent({ event: 'unknown', properties: { $browser_type: 'bot' } }), null)
  assert.equal(sanitizeAnalyticsEvent({ event: 'unknown', get properties() { throw new Error('PRIVATE_CLASSIFICATION_CANARY') } }), null)
})

test('all upcoming features fail closed, even if the remote switch is accidentally enabled', () => {
  for (const [feature, definition] of Object.entries(upcomingFeatures)) {
    assert.equal(definition.implemented, false)
    for (const remote of [undefined, false, true, 'control', 'true']) {
      assert.equal(featureAvailability(feature, remote).enabled, false)
      assert.equal(featureAvailability(feature, remote).key, definition.key)
    }
    assert.equal(featureAvailability(feature, true).reason, 'FeatureCopy.c_7a3f5896')
  }
})

test('gated features are on only when the remote flag is exactly true', () => {
  assert.equal(gatedFeatures.cloudComputer.key, 'mikka-cloud-computer')
  assert.equal(gatedFeatures.computerBilling.key, 'mikka-computer-billing')
  assert.equal(gatedFeatures.memory.key, 'mikka-memory')
  assert.deepEqual(proactiveFeatures, { profile: 'mikka-proactive-profile', research: 'mikka-proactive-research' })
  for (const remote of [undefined, false, 'control', 'true']) assert.equal(gatedFeatureEnabled(remote), false)
  assert.equal(gatedFeatureEnabled(true), true)
  assert.equal(computerAcceptancePreview('preview', '1'), true)
  for (const environment of [undefined, 'development', 'production']) assert.equal(computerAcceptancePreview(environment, '1'), false)
  for (const flag of [undefined, '0', 'true']) assert.equal(computerAcceptancePreview('preview', flag), false)
  assert.equal(computerProductionEnabled('production', '1'), true)
  for (const environment of [undefined, 'development', 'preview']) assert.equal(computerProductionEnabled(environment, '1'), false)
  for (const flag of [undefined, '0', 'true']) assert.equal(computerProductionEnabled('production', flag), false)
})

test('the 电脑 tab has its own kill switch, apart from the cloud computer rollout flag', () => {
  assert.equal(killSwitches.computerTab, 'mikka-computer-tab-off')
  assert.notEqual(killSwitches.computerTab, gatedFeatures.cloudComputer.key)
  const desktopHook = readFileSync(new URL('../apps/desktop/src/renderer/feature-availability.ts', import.meta.url), 'utf8')
  assert.match(desktopHook, /export function useComputerTab\(\)[\s\S]*?killSwitches\.computerTab[\s\S]*?!== true/)
  const webHookPath = new URL('../.hosted-ui/web/hooks/use-feature-availability.ts', import.meta.url)
  if (existsSync(webHookPath)) {
    const webHook = readFileSync(webHookPath, 'utf8')
    assert.match(webHook, /export function useComputerTab\(\)[\s\S]*?killSwitches\.computerTab[\s\S]*?!== true/)
  }
})

test('the active Vite web entry initializes PostHog and the shared application mounts its pageview tracker', async () => {
  const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  assert.match(source('apps/frontend/src/index.ts'), /import 'mikka:frontend-runtime'[\s\S]*await import\('mikka:application'\)/)
  // The runtime module is the same for any checkout; a stand-in one is enough to load it.
  const fixture = await uiFixture()
  try {
    const plugin = await applicationPlugin('web', { overlay: fixture.overlay() })
    const runtimeId = await plugin.resolveId('mikka:frontend-runtime')
    const entry = fileURLToPath(new URL('../apps/frontend/src/web/runtime.ts', import.meta.url))
    for (const development of [false, true]) {
      plugin.configResolved({ command: development ? 'serve' : 'build' })
      const code = await plugin.load(runtimeId)
      assert.ok(code.split('\n').includes(`import ${JSON.stringify(entry)};`))
      assert.equal(code.includes('openui.devtools'), false)
    }
  } finally {
    await fixture.cleanup()
  }
  assert.match(source('apps/frontend/src/web/runtime.ts'), /import '@\/instrumentation-client'/)
  // PostHog starts after first paint: the runtime only schedules it, and posthog-js is never a static client import.
  assert.match(source('instrumentation-client.ts'), /if \(posthogConfig\.token\) loadPostHogAfterIdle\(window\)/)
  assert.match(source('lib/analytics/posthog.ts'), /import\('posthog-js'\), import\('\.\/posthog-init'\)/)
  assert.match(source('lib/analytics/posthog-init.ts'), /posthog\.init\(posthogConfig\.token/)
  assert.match(source('lib/analytics/posthog-init.ts'), /capture_pageview: false/)
  assert.match(source('lib/analytics/posthog-init.ts'), /capture_unhandled_errors: true/)
  assert.match(source('lib/analytics/posthog-init.ts'), /capture_unhandled_rejections: true/)
  assert.match(source('lib/analytics/posthog-init.ts'), /capture_console_errors: false/)
})

test('the official interface never imports posthog-js statically and mounts the pageview tracker', { skip: needsOfficialUi }, () => {
  // The interface lives in the official UI checkout (core/ and web/, decision 2026-11-24-1000-all-ui-in-hosted).
  for (const file of ['components/posthog-analytics.tsx', 'hooks/use-feature-availability.ts', 'components/teams/team-form.tsx', 'hooks/settings/use-team-directory.ts']) {
    const path = [file, `.hosted-ui/web/${file}`].find(uiExists)
    if (path) assert.doesNotMatch(readUi(path), /from 'posthog-js'/, file)
  }
  assert.match(readUi('renderer/app.tsx'), /<PlatformExtras \/>/)
  assert.match(readUi('renderer/web/platform.tsx'), /posthogConfig\.token && <PostHogAnalytics \/>/)
})

test('analytics acceptance preserves the three real anonymous routes and isolated database restriction', () => {
  assert.deepEqual(analyticsPaths, ['/mikka', '/mikka/sign-in', '/mikka/en/sign-in'])
  const database = 'postgresql://e2e:disposable@127.0.0.1:5432/mikka_e2e'
  const env = { CI: 'true', MIKKA_PUBLIC_POSTHOG_KEY: analyticsKey, E2E_DATABASE_URL: database, DATABASE_URL: database, MIKKA_DATABASE_URL: database }
  assert.equal(analyticsEnvironment(env), database)
  for (const change of [{ CI: 'false' }, { MIKKA_PUBLIC_POSTHOG_KEY: 'another-project' }, { DATABASE_URL: database + '?options=other' },
    { E2E_DATABASE_URL: database.replace('127.0.0.1', 'remote.example') }, { E2E_DATABASE_URL: database.replace('/mikka_e2e', '/mikka') }]) {
    assert.throws(() => analyticsEnvironment({ ...env, ...change }))
  }
})

test('all non-local browser HTTP and WebSocket requests are blocked before sending analytics', () => {
  const origin = 'http://localhost:3186'
  for (const value of ['/mikka', 'http://localhost:3186/mikka', 'ws://localhost:3186/live']) {
    assert.equal(localAnalyticsRequest(value.startsWith('/') ? origin + value : value, origin), true)
  }
  for (const value of ['http://localhost:3187/mikka', 'http://127.0.0.1:3186/mikka', 'https://localhost:3186/mikka',
    'wss://localhost:3186/live', 'https://us.i.posthog.com/e/', 'https://other.example', 'file:///tmp/page', 'http://private@localhost:3186/mikka']) {
    assert.equal(localAnalyticsRequest(value, origin), false)
  }
  const request = (url, body = null) => ({ url: () => url, postData: () => body })
  assert.equal(syntheticPostHogRequest(request(`https://us-assets.i.posthog.com/array/${analyticsKey}/config.js`)), true)
  assert.equal(syntheticPostHogRequest(request('https://us.i.posthog.com/e/', JSON.stringify({ token: analyticsKey }))), true)
  assert.equal(syntheticPostHogRequest(request(`https://foreign.example/${analyticsKey}`)), false)
  assert.equal(syntheticPostHogRequest(request('https://us.i.posthog.com/e/', 'another-token')), false)
})

async function analyticsBuildFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mikka-analytics-artifacts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const write = async (path, value) => { const filename = join(root, path); await mkdir(dirname(filename), { recursive: true }); await writeFile(filename, value) }
  const resources = []
  for (const [index, path] of requiredRuntimeResources.entries()) {
    const source = `actual source ${index}\n`
    await write(path, source); await write(`.output/${path}`, source)
    resources.push({ path, bytes: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex') })
  }
  const built = { version: 1, preset: 'node-server', basePath: '/mikka', revision: 'a'.repeat(40), node: process.version,
    appBuild: 'synthetic-build', testDeploymentSha: '', lockSha256: 'b'.repeat(64), routesSha256: 'c'.repeat(64), tracingSha256: 'd'.repeat(64), resources }
  await write('.output/mikka-build.json', JSON.stringify(built))
  await write('.output/server/mikka-entry.mjs', 'export {}\n')
  const script = `export const project = '${analyticsKey}';\n`
  await write('apps/frontend/dist/web/.vite/manifest.json', JSON.stringify({ 'index.html': { isEntry: true, file: 'assets/index-real.js' } }))
  await write('apps/frontend/dist/web/assets/index-real.js', script)
  await write('.output/public/mikka/assets/index-real.js', script)
  return { root, built, write }
}

test('analytics build proof checks actual packaged bytes, public Vite entry and the synthetic key', async t => {
  const { root, built, write } = await analyticsBuildFixture(t)
  const result = await inspectAnalyticsBuild(root)
  assert.equal(result.assets.size, 1)
  assert.deepEqual([...result.configuredAssets], ['/mikka/assets/index-real.js'])
  assert.equal(result.resources.count, 3)
  await write('.output/public/mikka/assets/index-real.js', 'wrong asset')
  await assert.rejects(inspectAnalyticsBuild(root), /served asset/)
  await assert.rejects(verifyRuntimeResources(root, { ...built, resources: built.resources.slice(1) }), /Required runtime/)
  await assert.rejects(verifyRuntimeResources(root, { ...built, resources: [...built.resources, built.resources[0]] }))
  await write(`.output/${requiredRuntimeResources[0]}`, 'changed packaged resource')
  await assert.rejects(verifyRuntimeResources(root, built))
})

test('headless public builds still prove runtime resources and asset byte identity without private UI analytics', async t => {
  const { root, write } = await analyticsBuildFixture(t)
  const headlessScript = 'document.documentElement.dataset.mikkaHeadless = "true";\n'
  await write('apps/frontend/dist/web/assets/index-real.js', headlessScript)
  await write('.output/public/mikka/assets/index-real.js', headlessScript)
  // Without an explicit matching headless manifest, missing analytics config must still fail.
  await assert.rejects(inspectAnalyticsBuild(root), /Synthetic analytics configuration/)
  const manifest = JSON.stringify({ version: 1, target: 'web', headless: true, usedActions: [] })
  await write('apps/frontend/dist/web/renderer-manifest.json', manifest)
  await write('.output/public/mikka/renderer-manifest.json', manifest)
  const result = await inspectAnalyticsBuild(root)
  assert.equal(result.headless, true)
  assert.equal(result.assets.size, 1)
  assert.equal(result.configuredAssets.size, 0)
  await write('.output/public/mikka/renderer-manifest.json', '{"headless":false}')
  await assert.rejects(inspectAnalyticsBuild(root), /served renderer manifest/)
})

test('artifact verification rejects escaping and symlinked files instead of accepting their filenames', async t => {
  const { root, built } = await analyticsBuildFixture(t)
  for (const path of ['../private', '/private', 'packages//private', 'packages/./private', 'packages\\private']) {
    await assert.rejects(verifyRuntimeResources(root, { resources: [{ ...built.resources[0], path }] }))
  }
  const source = requiredRuntimeResources[0]
  await rm(join(root, '.output', source))
  await symlink(join(root, source), join(root, '.output', source))
  await assert.rejects(verifyRuntimeResources(root, built), /symlinks/)
})

test('generated FFmpeg evidence verifies the pinned pnpm source, real decompression and unchanged symlink boundaries', async t => {
  const { root, built, write } = await analyticsBuildFixture(t)
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const packageDirectory = 'node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static'
  await write('package.json', JSON.stringify({ dependencies: { 'ffmpeg-static': '5.3.0' } }))
  await write('pnpm-lock.yaml', JSON.stringify({ importers: { '.': { dependencies: { 'ffmpeg-static': { specifier: '5.3.0', version: '5.3.0' } } } }, snapshots: { 'ffmpeg-static@5.3.0': {} } }))
  await write(`${packageDirectory}/package.json`, JSON.stringify({ name: 'ffmpeg-static', version: '5.3.0' }))
  const original = Buffer.from('locked executable fixture\n'), archive = gzipSync(original)
  await write(`${packageDirectory}/ffmpeg`, original)
  await symlink(join(root, packageDirectory), join(root, 'node_modules/ffmpeg-static'), 'dir')
  const manifest = { version: 1, bytes: original.length, sha256: digest(original), gzipBytes: archive.length, gzipSha256: digest(archive) }
  const packed = async (path, bytes) => {
    await write(`.output/${path}`, bytes)
    const resource = { path, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) }
    const previous = built.resources.findIndex(value => value.path === path)
    if (previous === -1) built.resources.push(resource)
    else built.resources[previous] = resource
  }
  for (const name of POSTER_LICENSE_FILES) {
    const bytes = `pinned upstream ${name}\n`
    await write(`${packageDirectory}/${name}`, bytes)
    await packed(`${POSTER_RUNTIME_DIRECTORY}/${name}`, bytes)
  }
  await packed(POSTER_BINARY_ARCHIVE, archive)
  await packed(POSTER_BINARY_MANIFEST, JSON.stringify(manifest))
  built.posterBinary = manifest
  assert.equal((await verifyRuntimeResources(root, built)).count, requiredRuntimeResources.length + 6)
  await assert.rejects(verifyRuntimeResources(root, { ...built,
    resources: built.resources.filter(resource => resource.path !== POSTER_BINARY_ARCHIVE) }), /Required FFmpeg runtime/)

  // Only the one public pnpm link is allowed. Packaged files and files inside
  // the resolved pinned package retain the original no-symlink invariant.
  await write('archive-source.gz', archive)
  await rm(join(root, '.output', POSTER_BINARY_ARCHIVE))
  await symlink(join(root, 'archive-source.gz'), join(root, '.output', POSTER_BINARY_ARCHIVE))
  await assert.rejects(verifyRuntimeResources(root, built), /symlinks/)
  await rm(join(root, '.output', POSTER_BINARY_ARCHIVE)); await packed(POSTER_BINARY_ARCHIVE, archive)
  await write(`${packageDirectory}/alternate`, original)
  await rm(join(root, packageDirectory, 'ffmpeg'))
  await symlink(join(root, packageDirectory, 'alternate'), join(root, packageDirectory, 'ffmpeg'))
  await assert.rejects(verifyRuntimeResources(root, built), /symlinks/)
  await rm(join(root, packageDirectory, 'ffmpeg')); await write(`${packageDirectory}/ffmpeg`, original)
  await rm(join(root, 'node_modules/ffmpeg-static'))
  await symlink(join(root, packageDirectory, '..'), join(root, 'node_modules/ffmpeg-static'), 'dir')
  await assert.rejects(verifyRuntimeResources(root, built), /exact pinned pnpm package/)
  await rm(join(root, 'node_modules/ffmpeg-static'))
  await symlink(join(root, packageDirectory), join(root, 'node_modules/ffmpeg-static'), 'dir')

  // Updating both compressed-file hashes cannot disguise different expanded
  // bytes: the checker independently compares the installed pinned executable.
  const changed = gzipSync(Buffer.alloc(original.length, 65))
  const forged = { ...manifest, gzipBytes: changed.length, gzipSha256: digest(changed) }
  await packed(POSTER_BINARY_ARCHIVE, changed)
  await packed(POSTER_BINARY_MANIFEST, JSON.stringify(forged))
  built.posterBinary = forged
  await assert.rejects(verifyRuntimeResources(root, built), /exact pinned executable/)
})

test('runtime separates the desktop shell and still drops other client details', () => {
  const event = sanitizeAnalyticsEvent({ event: '$pageview', properties: { runtime: 'electron', isDesktop: true, userAgent: 'private', platform: 'Mozilla/5.0' } })
  assert.deepEqual(event.properties, { runtime: 'electron' })
})

test('smoke accounts are recognised only by their +mikka-smoke tag, and the tag survives sanitizing', async () => {
  const { isSmokeAccountEmail } = await import('../lib/smoke-account.ts')
  for (const email of ['alex+mikka-smoke@gmail.com', 'alex+mikka-smoke-owner@gmail.com', 'ALEX+MIKKA-SMOKE-PEER@example.com']) assert.equal(isSmokeAccountEmail(email), true, email)
  for (const email of ['alex@gmail.com', 'alex+mikka-smoker@gmail.com', 'mikka-smoke@gmail.com', 'alex+other+mikka-smoke@@gmail.com', '', null, undefined]) assert.equal(isSmokeAccountEmail(email), false, String(email))
  const event = sanitizeAnalyticsEvent({ event: '$pageview', properties: { distinct_id: 'opaque-user-id', test_account: true } })
  assert.deepEqual(event.properties, { distinct_id: 'opaque-user-id', test_account: true })
})

async function analyticsBrowserFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mikka-analytics-browser-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const executable = join(root, 'chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]), { mode: 0o755 })
  return { root, executable }
}

test('the CI AppArmor attachment authorizes only the actual installed headless Chromium path', async t => {
  const { root, executable } = await analyticsBrowserFixture(t)
  const profile = await analyticsBrowserProfile(root)
  assert.equal(profile, `abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile mikka-analytics-chromium "${executable}" flags=(unconfined) {\n  userns,\n}\n`)
  assert.equal(profile.includes('*'), false)
  assert.equal(profile.includes('sysctl'), false)
})

test('the CI AppArmor helper rejects missing and ambiguous installed browser revisions', async t => {
  const { root } = await analyticsBrowserFixture(t)
  await mkdir(join(root, 'chromium_headless_shell-1249'))
  await assert.rejects(analyticsBrowserProfile(root), /ANALYTICS_BROWSER_REVISION_AMBIGUOUS/)
  await rm(join(root, 'chromium_headless_shell-1248'), { recursive: true })
  await rm(join(root, 'chromium_headless_shell-1249'), { recursive: true })
  await assert.rejects(analyticsBrowserProfile(root), /ANALYTICS_BROWSER_REVISION_AMBIGUOUS/)
})

test('the CI AppArmor helper rejects glob syntax, path aliases, and executable symlinks', async t => {
  const { root, executable } = await analyticsBrowserFixture(t)
  for (const directory of [root + '*', root + '\n', root + '/..', root + '/./', 'relative/browser']) {
    await assert.rejects(analyticsBrowserProfile(directory), /ANALYTICS_BROWSER_DIRECTORY_/)
  }
  const linked = join(root, 'linked')
  await symlink(root, linked)
  await assert.rejects(analyticsBrowserProfile(linked), /ANALYTICS_BROWSER_DIRECTORY_SYMLINK/)
  await rm(executable)
  const outside = join(root, 'unapproved-binary')
  await writeFile(outside, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 })
  await symlink(outside, executable)
  await assert.rejects(analyticsBrowserProfile(root), /ANALYTICS_BROWSER_EXECUTABLE_SYMLINK/)
})

test('the CI AppArmor helper refuses non-executable or non-ELF files', async t => {
  const { root, executable } = await analyticsBrowserFixture(t)
  await chmod(executable, 0o644)
  await assert.rejects(analyticsBrowserProfile(root), /ANALYTICS_BROWSER_EXECUTABLE_INVALID/)
  await chmod(executable, 0o755)
  await writeFile(executable, '#!/bin/sh\nexit 0\n')
  await assert.rejects(analyticsBrowserProfile(root), /ANALYTICS_BROWSER_EXECUTABLE_NOT_ELF/)
})

test('patched FFmpeg provenance accepts only the exact frozen patch hash and original source boundaries', async t => {
  const { root, built, write } = await analyticsBuildFixture(t)
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const patch = '--- a/install.js\n+++ b/install.js\n@@ -1 +1 @@\n-old\n+bounded\n'
  const patchPath = 'patches/ffmpeg-static@5.3.0.patch', patchHash = digest(patch)
  const lockedVersion = `5.3.0(patch_hash=${patchHash})`
  const packageDirectory = `node_modules/.pnpm/ffmpeg-static@5.3.0_patch_hash=${patchHash}/node_modules/ffmpeg-static`
  const lock = {
    patchedDependencies: { 'ffmpeg-static@5.3.0': { hash: patchHash, path: patchPath } },
    importers: { '.': { dependencies: { 'ffmpeg-static': { specifier: '5.3.0', version: lockedVersion } } } },
    snapshots: { [`ffmpeg-static@${lockedVersion}`]: {} },
  }
  const writeLock = () => write('pnpm-lock.yaml', JSON.stringify(lock))
  await write('package.json', JSON.stringify({ dependencies: { 'ffmpeg-static': '5.3.0' } }))
  await writeLock(); await write(patchPath, patch)
  await write(`${packageDirectory}/package.json`, JSON.stringify({ name: 'ffmpeg-static', version: '5.3.0' }))
  const original = Buffer.from('locked executable fixture\n'), archive = gzipSync(original)
  await write(`${packageDirectory}/ffmpeg`, original)
  const publicLink = join(root, 'node_modules/ffmpeg-static')
  await symlink(join(root, packageDirectory), publicLink, 'dir')
  const manifest = { version: 1, bytes: original.length, sha256: digest(original), gzipBytes: archive.length, gzipSha256: digest(archive) }
  const packed = async (path, bytes) => {
    await write(`.output/${path}`, bytes)
    built.resources.push({ path, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) })
  }
  for (const name of POSTER_LICENSE_FILES) {
    const bytes = `pinned upstream ${name}\n`
    await write(`${packageDirectory}/${name}`, bytes)
    await packed(`${POSTER_RUNTIME_DIRECTORY}/${name}`, bytes)
  }
  await packed(POSTER_BINARY_ARCHIVE, archive)
  await packed(POSTER_BINARY_MANIFEST, JSON.stringify(manifest))
  built.posterBinary = manifest
  assert.equal((await verifyRuntimeResources(root, built)).count, requiredRuntimeResources.length + 6)

  // pnpm hashes patch text after CRLF normalization, not arbitrary store suffixes.
  await write(patchPath, patch.replaceAll('\n', '\r\n'))
  assert.equal((await verifyRuntimeResources(root, built)).count, requiredRuntimeResources.length + 6)
  await write(patchPath, patch + 'changed\n')
  await assert.rejects(verifyRuntimeResources(root, built), /FFmpeg patch must match its frozen lock hash/)
  await write(patchPath, patch)

  lock.importers['.'].dependencies['ffmpeg-static'].version = '5.3.0'
  await writeLock()
  await assert.rejects(verifyRuntimeResources(root, built), /FFmpeg resolution must match the frozen lock/)
  lock.importers['.'].dependencies['ffmpeg-static'].version = lockedVersion
  await writeLock()

  lock.patchedDependencies['ffmpeg-static@5.3.0'].path = 'patches/unrelated.patch'
  await writeLock()
  await assert.rejects(verifyRuntimeResources(root, built), /FFmpeg patch path must be exact/)
  lock.patchedDependencies['ffmpeg-static@5.3.0'].path = patchPath
  await writeLock()

  const wrongDirectory = `node_modules/.pnpm/ffmpeg-static@5.3.0_patch_hash=${'0'.repeat(64)}/node_modules/ffmpeg-static`
  await mkdir(join(root, wrongDirectory), { recursive: true })
  await rm(publicLink); await symlink(join(root, wrongDirectory), publicLink, 'dir')
  await assert.rejects(verifyRuntimeResources(root, built), /exact pinned pnpm package/)
  await rm(publicLink); await symlink(join(root, packageDirectory), publicLink, 'dir')

  await write('saved.patch', patch)
  await rm(join(root, patchPath)); await symlink(join(root, 'saved.patch'), join(root, patchPath))
  await assert.rejects(verifyRuntimeResources(root, built), /symlinks/)
  await rm(join(root, patchPath)); await write(patchPath, patch)
  await write(`${packageDirectory}/alternate`, original)
  await rm(join(root, packageDirectory, 'ffmpeg'))
  await symlink(join(root, packageDirectory, 'alternate'), join(root, packageDirectory, 'ffmpeg'))
  await assert.rejects(verifyRuntimeResources(root, built), /symlinks/)
})

test('acquisition fields keep bounded UTM labels and referring domains, never raw URLs', () => {
  const event = sanitizeAnalyticsEvent({ event: '$pageview', properties: {
    $current_url: 'https://app.aspectlylabs.com/mikka/tasks', distinct_id: 'u1',
    utm_source: 'HackerNews', utm_medium: 'social', utm_campaign: 'launch',
    $referring_domain: 'news.ycombinator.com',
    $session_entry_utm_source: 'Substack', $session_entry_referring_domain: 'sub.example.co.uk',
    utm_content: 'https://evil.example/payload?token=1', $referrer: 'https://x.test/?secret=1',
    first_touch_source: 'newsletter', first_touch_utm_source: 'hn', first_touch_landing: '/mikka',
  } })
  const p = event.properties
  assert.equal(p.utm_source, 'hackernews')
  assert.equal(p.utm_medium, 'social')
  assert.equal(p.utm_campaign, 'launch')
  assert.equal(p.$referring_domain, 'news.ycombinator.com')
  assert.equal(p.$session_entry_utm_source, 'substack')
  assert.equal(p.$session_entry_referring_domain, 'sub.example.co.uk')
  assert.equal(p.first_touch_source, 'newsletter')
  assert.equal(p.first_touch_utm_source, 'hn')
  assert.equal(p.first_touch_landing, '/mikka')
  assert.equal(p.utm_content, undefined)
  assert.equal(p.$referrer, undefined)
})

test('frontend ErrorBoundary and runtime error RUM events keep only sanitized bounded fields and strip PII', () => {
  const renderEvent = sanitizeAnalyticsEvent({
    event: 'frontend_render_error',
    properties: {
      token: 'public-project-token',
      distinct_id: 'opaque-user-id',
      $session_id: 'session-1',
      error_name: 'TypeError',
      boundary: 'app-frame-page',
      route: 'https://app.aspectlylabs.com/en/tasks/550e8400-e29b-41d4-a716-446655440000?token=PRIVATE_QUERY_CANARY&email=alice@example.com#PRIVATE_HASH',
      build_sha: '5be23b0',
      viewport_bucket: 'desktop',
      recoverable: true,
      message: 'PRIVATE_ERROR_MESSAGE_CANARY',
      stack: 'Error at /Users/alex/private.ts:12',
      email: 'alice@example.com',
      lcp_ms: 1200,
    },
    $set: { email: 'alice@example.com' },
  })
  assert.equal(JSON.stringify(renderEvent).includes('PRIVATE_'), false)
  assert.equal(JSON.stringify(renderEvent).includes('alice@example.com'), false)
  assert.deepEqual(renderEvent, {
    event: 'frontend_render_error',
    properties: {
      token: 'public-project-token',
      distinct_id: 'opaque-user-id',
      $session_id: 'session-1',
      route: '/en/tasks/:id',
      build_sha: '5be23b0',
      viewport_bucket: 'desktop',
      error_name: 'TypeError',
      boundary: 'app-frame-page',
      recoverable: true,
    },
  })

  const hostileRuntime = sanitizeAnalyticsEvent({
    event: 'frontend_runtime_error',
    properties: {
      error_name: 'Bearer sk_live_PRIVATE_CANARY failed for alice@example.com',
      error_source: 'unhandled_rejection',
      route: '/en/invite/PRIVATE_INVITE_CODE/users/alice@example.com/987654?secret=PRIVATE_QUERY',
      build_sha: 'invalid sha with spaces',
      viewport_bucket: 'invalid_bucket',
      reason: 'PRIVATE_REASON_CANARY',
    },
  })
  assert.equal(JSON.stringify(hostileRuntime).includes('PRIVATE_'), false)
  assert.equal(JSON.stringify(hostileRuntime).includes('alice@example.com'), false)
  assert.deepEqual(hostileRuntime, {
    event: 'frontend_runtime_error',
    properties: {
      route: '/en/invite/:token/users/:redacted/:id',
      error_name: 'Error',
      error_source: 'unhandled_rejection',
    },
  })
})

test('frontend_web_vitals keeps bounded CWV timings, drops empty/invalid payloads, and keeps RUM fields off $pageview', () => {
  const vitals = sanitizeAnalyticsEvent({
    event: 'frontend_web_vitals',
    properties: {
      token: 'public-project-token',
      distinct_id: 'opaque-user-id',
      route: '/en/pulls/123456?code=PRIVATE_OAUTH_CODE#frag',
      build_sha: '5be23b0',
      viewport_bucket: 'mobile',
      flush_reason: 'visibility_hidden',
      lcp_ms: 1245.7,
      cls: 0.12345,
      inp_ms: 88.2,
      fcp_ms: 410.4,
      ttfb_ms: 180.6,
      userAgent: 'PRIVATE_UA_CANARY',
      query: 'PRIVATE_QUERY_CANARY',
    },
    $set_once: { email: 'alice@example.com' },
  })
  assert.equal(JSON.stringify(vitals).includes('PRIVATE_'), false)
  assert.deepEqual(vitals, {
    event: 'frontend_web_vitals',
    properties: {
      token: 'public-project-token',
      distinct_id: 'opaque-user-id',
      route: '/en/pulls/:id',
      build_sha: '5be23b0',
      viewport_bucket: 'mobile',
      flush_reason: 'visibility_hidden',
      lcp_ms: 1246,
      cls: 0.1235,
      inp_ms: 88,
      fcp_ms: 410,
      ttfb_ms: 181,
    },
  })

  // Empty or out-of-range vitals payloads are dropped cleanly.
  assert.equal(sanitizeAnalyticsEvent({ event: 'frontend_web_vitals', properties: { route: '/en/tasks', flush_reason: 'pagehide' } }), null)
  assert.equal(
    sanitizeAnalyticsEvent({
      event: 'frontend_web_vitals',
      properties: { lcp_ms: -5, cls: 999, inp_ms: Number.POSITIVE_INFINITY, fcp_ms: '123', ttfb_ms: 9_999_999 },
    }),
    null,
  )

  // RUM-specific fields never leak onto unrelated events like $pageview.
  const pageview = sanitizeAnalyticsEvent({
    event: '$pageview',
    properties: {
      distinct_id: 'opaque-user-id',
      error_name: 'TypeError',
      boundary: 'app-frame-page',
      route: '/en/tasks',
      lcp_ms: 1000,
    },
  })
  assert.deepEqual(pageview.properties, { distinct_id: 'opaque-user-id' })
})

test('a control click keeps only its build-time owner; anything else in it, or a malformed owner, is dropped', () => {
  const owner = 'web/components/settings/members.tsx#MembersPage:Button[Invite]'
  const event = sanitizeAnalyticsEvent({ event: 'ui_control_click', properties: {
    owner, token: 'public-project-token', distinct_id: 'opaque-user-id', $el_text: 'private@example.com',
    $elements: [{ text: 'private' }], email: 'private@example.com', $current_url: 'https://example.com/settings?email=x',
  } })
  assert.deepEqual(event.properties, {
    token: 'public-project-token', distinct_id: 'opaque-user-id', owner,
    $current_url: 'https://example.com/settings', $pathname: '/settings',
  })
  for (const bad of [undefined, 42, 'private@example.com', 'not-a-file#X:button', `web/a.tsx#A:button[${'x'.repeat(200)}]`]) {
    assert.equal(sanitizeAnalyticsEvent({ event: 'ui_control_click', properties: { owner: bad } }), null, String(bad))
  }
})

test('a control owner names a file under a UI source root and a plugin-written label, never data', () => {
  const kept = owner => sanitizeAnalyticsEvent({ event: 'ui_control_click', properties: { owner } })?.properties.owner
  // Owners the UI checkout's plugin writes (scripts/track-owner/vite-plugin.mjs).
  for (const owner of [
    'web/components/settings/members.tsx#MembersPage:Button[Invite]',
    'web/components/demo/panel.tsx#Fancy:button[Save draft]',
    'slots/a.tsx#A:button.1',
    'slots/thread.tsx#ThreadSlot:Tabs.Trigger[Changes].2',
    'core/components/sidebar.tsx#Sidebar:a[Open sidebar]',
    'components/mikka/create-window.tsx#CreateWindow:button[新建任务]',
    'components/mikka/right-column-strip/strip.tsx#Strip:button[onClick=props.onCloseRightColumnTabAndFocus]',
    'lib/settings-frame.tsx#SettingsFrame:Link[settings.nav.general]',
    'shared/x.jsx#module:input.3',
    'preview/templates.tsx#Templates:summary[Version 2026]',
    `web/a.tsx#A:button[${'x'.repeat(48)}]`,
    `web/a.tsx#A:button[onClick=${'h'.repeat(64)}]`,
    'web/a.tsx#A:button.999',
    // Hashed message keys are names (the UI checkout's FeatureCopy.c_<8 hex>).
    'slots/settings-members.tsx#TeamsTab:Button[FeatureCopy.c_30108106]',
    'slots/settings-members.tsx#TeamMembersPage:Button[FeatureCopy.c_352987c4]',
    'web/components/slots/settings-sidebar.tsx#SettingsSidebar:SidebarMenuButton[FeatureCopy.c_cb11190c]',
    'web/components/x.tsx#X:button[Settings.nav.createTeam]',
    'web/components/x.tsx#X:a[versionPullRequest].2',
    // Brackets, `#` and `:` of the owner itself are not data, nor are a mention's `@` or a component named Data.
    'web/a.tsx#A:button[@].1',
    'web/a.tsx#A:button[@here]',
    'web/a.tsx#Data:button',
    'web/a.tsx#Tel:a[Run]',
  ]) assert.equal(kept(owner), owner, owner)
  for (const owner of [
    'web/a.tsx#A:button[x@y.com]',
    'web/a.tsx#A:button[Mail alex@example.com]',
    '../../etc/passwd.tsx#A:b',
    'web/../../etc/passwd.tsx#A:b',
    'web/./a.tsx#A:b',
    'etc/passwd.tsx#A:b',
    'node_modules/pkg/a.tsx#A:button',
    '/web/a.tsx#A:button',
    'web.tsx#A:button',
    `web/a.tsx#A:button[${'x'.repeat(49)}]`,
    'web/a.tsx#A:button[https://example.com]',
    'web/a.tsx#A:button[www.example.com]',
    'web/a.tsx#A:button[example.com/reset?token=abc]',
    'web/a.tsx#A:button[mailto:alex]',
    'web/a.tsx#A:button[Order 123456]',
    'web/a.tsx#A:button[Call +1 (555) 123-4567]',
    'web/a.tsx#A:button[onClick=x@y.com]',
    // Data anywhere in the owner, not only in its label.
    'web/alex@example.com/a.tsx#A:button',
    'web/www.example.com/a.tsx#A:button',
    'web/4111111111111111.tsx#A:button',
    'web/evil.example.com/a.tsx#A:button',
    'web/a.tsx#A:button[onClick=www.example.com]',
    'web/a.tsx#A:button[onClick=x4111111111111111]',
    `web/a.tsx#A:button[onClick=${'h'.repeat(65)}]`,
    'web/a.tsx#A:button.4111111111111111',
    'web/a.tsx#A:button.1234',
    'web/a.tsx#A4111111111111111:button',
    'web/a.tsx#A:Menu.x4111111111111111',
    // Control and invisible characters, other scripts' forms of data.
    'web/a.tsx#A:button[Save\rDraft]',
    'web/a.tsx#A:button[Save\u0000]',
    'web/a.tsx#A:button[Save\u202eDraft]',
    'web/a.tsx#A:button[alex＠example.com]',
    'web/a.tsx#A:button[４１１１ ４１１１ ４１１１ ４１１１]',
    'web/a.tsx#A:button[٤١١١٤١١١٤١١١٤١١١]',
    'web/a.tsx#A:button[4111/1111/1111/1111]',
    'web/a.tsx#A:button[evil.example.com]',
    'web/a.tsx#A:button[10.0.0.1]',
    'web/a.tsx#A:button[data:text/html,x]',
    'web/a.tsx#A:button[FeatureCopy.c_30108106 4111111]',
    'web/a.tsx#A:button[FeatureCopy.c_301081061]',
    // Only FeatureCopy's hashed keys are names.
    'web/a.tsx#A:button[x4111111111111111.c_00000000]',
    'web/a.tsx#A:button[x10.0.0.1.c_00000000]',
    'web/a.tsx#A:button[evil.example.com.c_deadbeef]',
    // URLs, domains, hosts, ids and tokens.
    'web/a.tsx#A:button[bit.ly/abc123]',
    'web/a.tsx#A:button[get.sh/install]',
    'web/a.tsx#A:button[MAILTO:alex]',
    'web/a.tsx#A:button[Tel:+1 555]',
    'web/a.tsx#A:button[JavaScript:void]',
    ...['acme.ly', 'notion.so', 'alex.me', 'site.fr', 'foo.info', 'discord.gg', 'alex%40acme.ly'].map(label => `web/a.tsx#A:button[${label}]`),
    'web/a.tsx#A:button[api.acme:8080]',
    'web/a.tsx#A:button[Open 123e4567-e89b-12d3-a456-426614174000]',
    'web/a.tsx#A:button[sk_live_51Habcdefghijklmnop]',
    'web/a.tsx#A:button[deadbeefdeadbeefdeadbeef1]',
    'web/a.tsx#A:button[Call 1 2 3 4 5 6 7]',
    'web/a.tsx#A:button[Pay 1$2$3$4$5$6$7]',
    'web/a.tsx#A:button[onClick=sk_live_51Habcdefghijklmnop]',
  ]) assert.equal(kept(owner), undefined, owner)
})

test('desktop reports keep only a route template, method, status and code, with the build tags', () => {
  const base = { token: 'public-project-token', distinct_id: 'user-id', platform: 'desktop', app_version: '2026.10000.1940', public_sha: 'a'.repeat(40), overlay_sha: 'b'.repeat(40) }
  const denied = sanitizeAnalyticsEvent({ event: 'desktop_api_error', properties: {
    ...base, route: '/api/workspaces/[workspaceId]/task-labels/[labelId]', method: 'PATCH', status: 403, error_code: 'untrusted_origin',
    path: '/api/workspaces/84c182d1-661c-461b-bca2-10410cb646d4/task-labels/label_1', body: '{"name":"private"}', message: 'private',
  } })
  assert.deepEqual(denied.properties, { ...base, route: '/api/workspaces/[workspaceId]/task-labels/[labelId]', method: 'PATCH', status: 403, error_code: 'untrusted_origin' })
  // A concrete path, an unknown method or a missing status is not a report.
  for (const properties of [
    { route: '/api/workspaces/84c182d1-661c-461b-bca2-10410cb646d4/task-labels', method: 'GET', status: 403 },
    { route: '/api/inbox?email=private@example.com', method: 'GET', status: 500 },
    { route: '/api/inbox', method: 'BREW', status: 500 },
    { route: '/api/inbox', method: 'GET' },
  ]) assert.equal(sanitizeAnalyticsEvent({ event: 'desktop_api_error', properties: { ...base, ...properties } }), null)
  const odd = sanitizeAnalyticsEvent({ event: 'desktop_api_error', properties: { ...base, route: 'unmatched', method: 'GET', status: 502, error_code: 'Upstream said: secret' } })
  assert.equal(odd.properties.error_code, undefined)
  const main = sanitizeAnalyticsEvent({ event: 'desktop_main_error', properties: { ...base, error_name: 'TypeError', error_source: 'uncaught_exception', message: 'token=private', stack: '/Users/private/app.js' } })
  assert.deepEqual(main.properties, { ...base, error_name: 'TypeError', error_source: 'uncaught_exception' })
  assert.equal(sanitizeAnalyticsEvent({ event: 'desktop_main_error', properties: { ...base, error_name: 'TypeError' } }), null)
  const gone = sanitizeAnalyticsEvent({ event: 'desktop_process_gone', properties: { ...base, reason: 'crashed', process_type: 'renderer', exitCode: 11 } })
  assert.deepEqual(gone.properties, { ...base, reason: 'crashed', process_type: 'renderer' })
  // Tags that are not a closed word, a version or a SHA never ride along.
  const tagged = sanitizeAnalyticsEvent({ event: '$pageview', properties: { token: 't', distinct_id: 'd', platform: 'linux user@host', app_version: 'v1 private', public_sha: 'not-a-sha' } })
  assert.deepEqual(tagged.properties, { token: 't', distinct_id: 'd' })
})

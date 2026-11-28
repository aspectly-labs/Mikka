// The real posthog-js, configured as the web configures it
// (lib/analytics/posthog-init.ts), on a page opened from a share link: nothing
// it sends, the /flags request above all, may carry the link's token, its query
// or the raw referrer. /flags has no before_send, so the SDK must never store
// the raw first URL for it ($initial_person_info), whatever the SDK version.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Window } from 'happy-dom'
import { acceptanceReplayOptIn, installReplayReadiness } from '../lib/replay-readiness.ts'
import { redactReplayRequest, sanitizeAnalyticsEvent } from '../lib/analytics-policy.ts'

const TOKEN = 'SECRETshareTOKEN123'
const QUERY = 'QUERYSECRET'
const REFERRER = 'REFERRERSECRET'
const USER = '84c182d1-661c-461b-bca2-10410cb646d4'

/** The options lib/analytics/posthog-init.ts passes to posthog.init, read from the module as it ships. */
function shippedOptions(window) {
  const source = readFileSync(new URL('../lib/analytics/posthog-init.ts', import.meta.url), 'utf8').replace(/^import .*\n/gm, '')
  let options
  runInNewContext(source, {
    window, process: { env: { NODE_ENV: 'test' } }, getNodeEnv: () => 'test',
    posthogConfig: { token: 'phc_testProjectKeyForTheFlagsPrivacy000', apiHost: 'https://capture.test', uiHost: 'https://capture.test' },
    posthog: { init(_token, value) { options = value } },
    setLiveTelemetrySink() {}, acceptanceReplayOptIn, installReplayReadiness, sanitizeAnalyticsEvent, redactReplayRequest,
  })
  assert.ok(options, 'posthog-init.ts called posthog.init')
  return options
}

async function page(callback) {
  const window = new Window({
    url: `https://app.aspectlylabs.com/mikka/a/${TOKEN}?reset=${QUERY}#frag`,
    // Nothing leaves the process: the SDK's lazy scripts are not fetched, and its requests reach the stub below.
    settings: { navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true },
  })
  // A person's browser, not a bot or a driven one: the SDK captures nothing for those.
  Object.defineProperty(window.navigator, 'webdriver', { value: false, configurable: true })
  Object.defineProperty(window.document, 'referrer', { value: `https://app.aspectlylabs.com/mikka/invite/${REFERRER}?utm_source=x`, configurable: true })
  const saved = new Map()
  const requests = []
  const record = async (input, init = {}) => {
    const body = init.body instanceof Blob ? await init.body.text() : typeof init.body === 'string' ? init.body : init.body ? String(init.body) : ''
    requests.push({ url: String(input), body })
    return new Response(JSON.stringify({ flags: {}, featureFlags: {}, featureFlagPayloads: {}, errorsWhileComputingFlags: false }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  window.fetch = record
  window.navigator.sendBeacon = (url, body) => { void record(url, { body }); return true }
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, location: window.location, localStorage: window.localStorage, sessionStorage: window.sessionStorage, fetch: record, XMLHttpRequest: undefined })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  try { return await callback(window, requests) }
  finally {
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]
    await window.happyDOM.close()
  }
}

test('a page opened from a share link sends no token, query or raw referrer in /flags or anywhere else', () => page(async (window, requests) => {
  // Imported once the page exists: the SDK reads window when it loads.
  const { PostHog } = await import('posthog-js')
  const options = shippedOptions(window)
  const posthog = new PostHog().init('phc_testProjectKeyForTheFlagsPrivacy000', {
    ...options,
    // Only what the test harness needs: a local capture stub, readable bodies, no replay recorder script.
    api_host: 'https://capture.test', disable_compression: true, disable_session_recording: true, request_batching: false, disable_external_dependency_loading: true,
  }, 'flags-privacy')
  assert.ok(posthog, 'the SDK started')
  // What the official UI's PostHogAnalytics does on a page (core/components/posthog-analytics.tsx).
  posthog.identify(USER)
  posthog.capture('$pageview', { $current_url: 'https://app.aspectlylabs.com/mikka/a/:token' })
  posthog.reloadFeatureFlags()
  // The reload after the pageview is the request that would carry what capture() stored.
  const reloaded = () => requests.some(request => request.url.includes('/flags') && request.body.includes(USER))
  for (let wait = 0; wait < 150 && !reloaded(); wait++) await new Promise(resolve => setTimeout(resolve, 20))
  const flags = requests.filter(request => request.url.includes('/flags'))
  assert.ok(reloaded(), `the SDK asked for the signed-in person's flags after the pageview (${requests.map(request => new URL(request.url).pathname).join(', ')})`)
  for (const request of requests) {
    for (const secret of [TOKEN, QUERY, REFERRER, 'utm_source=x', 'reset=']) assert.equal(request.body.includes(secret), false, `${new URL(request.url).pathname} carries ${secret}`)
  }
  for (const request of flags) {
    const body = JSON.parse(request.body)
    const initial = Object.keys(body.person_properties ?? {}).filter(key => key.startsWith('$initial_'))
    assert.deepEqual(initial, [], 'no $initial_* person property rides on /flags')
  }
}))

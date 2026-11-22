import test from 'node:test'
import assert from 'node:assert/strict'
import { FIRST_TOUCH_COOKIE, firstTouchProperties, parseFirstTouch } from './first-touch'

const header = (value: unknown) => `other=1; ${FIRST_TOUCH_COOKIE}=${encodeURIComponent(JSON.stringify(value))}; theme=dark`
const fresh = (over: Record<string, unknown> = {}) => ({ v: 1, source: 'newsletter', acquired_at: 1_000, landing_path: '/mikka', ...over })

test('a valid first-touch cookie parses its bounded fields', () => {
  const touch = parseFirstTouch(header(fresh({ utm_source: 'HackerNews', utm_medium: 'social', referrer_domain: 'news.ycombinator.com' })), 10_000)
  assert.equal(touch?.source, 'newsletter')
  assert.equal(touch?.utm_source, 'hackernews')
  assert.equal(touch?.referrer_domain, 'news.ycombinator.com')
  assert.equal(touch?.landing_path, '/mikka')
})

test('missing, malformed, future and expired cookies all refuse', () => {
  assert.equal(parseFirstTouch(null), null)
  assert.equal(parseFirstTouch('session=abc'), null)
  assert.equal(parseFirstTouch(header('not-json')), null)
  assert.equal(parseFirstTouch(header(fresh({ acquired_at: 99_999_999 })), 10_000), null)
  assert.equal(parseFirstTouch(header(fresh({ acquired_at: 1 })), 31 * 24 * 60 * 60 * 1000 + 2), null)
  assert.equal(parseFirstTouch(header(fresh({ v: 2 }))), null)
  assert.equal(parseFirstTouch(header(fresh({ source: 'not a label!!' }))), null)
})

test('unsafe values are dropped field by field', () => {
  const touch = parseFirstTouch(header(fresh({
    referrer_domain: 'not a domain',
    utm_source: 'https://evil.example/path?q=1',
    utm_campaign: 'launch-2026',
    landing_path: '/invite/secret-token',
  })), 10_000)
  assert.equal(touch?.referrer_domain, undefined)
  assert.equal(touch?.utm_source, undefined)
  assert.equal(touch?.utm_campaign, 'launch-2026')
  assert.equal(touch?.landing_path, '/')
})

test('firstTouchProperties names fields for PostHog and covers the missing case', () => {
  assert.deepEqual(firstTouchProperties(null), { first_touch_source: 'direct_or_unknown' })
  const props = firstTouchProperties(parseFirstTouch(header(fresh({ utm_source: 'hn' })), 10_000))
  assert.equal(props.first_touch_source, 'newsletter')
  assert.equal(props.first_touch_utm_source, 'hn')
  assert.equal(props.first_touch_landing, '/mikka')
})

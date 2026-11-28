import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchPublicPage } from './eve-fetch'

const url = 'https://example.com/source'

test('Eve fetch uses public DNS dispatch, bounded Markdown, and no caller credentials', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (target: URL, options: RequestInit & { dispatcher?: unknown }) => {
    assert.equal(target.href, url)
    assert.equal(options.redirect, 'manual')
    assert.ok(options.dispatcher)
    assert.equal(new Headers(options.headers).get('authorization'), null)
    assert.equal(new Headers(options.headers).get('cookie'), null)
    return new Response('<h1>Public source</h1><p>Fixture text.</p>', { headers: { 'content-type': 'text/html' } })
  })
  const page = await fetchPublicPage(url)
  assert.equal(page.url, url)
  assert.match(page.markdown, /# Public source/)
  assert.match(page.markdown, /Fixture text/)
  assert.equal(fetch.mock.callCount(), 1)
})

test('Eve fetch refuses redirects, non-public inputs, and provider throttling', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 302, headers: { location: 'https://other.example.com' } }))
  await assert.rejects(fetchPublicPage('https://127.0.0.1/'))
  assert.equal(fetch.mock.callCount(), 0)
  await assert.rejects(fetchPublicPage(url), /redirect refused/)
  assert.equal(fetch.mock.callCount(), 1)
  fetch.mock.mockImplementation(async () => new Response(null, { status: 429 }))
  await assert.rejects(fetchPublicPage(url), { outcome: 'rate_limited' })
  assert.equal(fetch.mock.callCount(), 2)
})

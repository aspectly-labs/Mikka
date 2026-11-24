import assert from 'node:assert/strict'
import test from 'node:test'
import { applySecurityHeaders, isMachinePath, localizePage, pageRedirect, pageResponse } from './http-policy.mjs'

const request = (path, init) => new Request(`https://example.test${path}`, init)
const render = () => '<html lang="zh-CN"><body>shared app</body></html>'

/** The locale the SDK's cookie parser resolved for each cookie header, recorded
 * before the migration. The last well-formed value of the locale cookie wins.
 * The cookie was then named `NEXT_LOCALE`; it is `mikka-locale` now, and the
 * legacy name is still read the same way (i18n/locale-cookie.mjs). */
const FROZEN_LOCALES = new Map([
  ['C=en; C=zh-CN', 'zh-CN'],
  ['C=zh-CN; C=en', 'en'],
  ['C=en; C=%E0%A4%A', 'en'],
  ['C=%; C=%65n', 'en'],
  ['C=%FF', 'zh-CN'],
  ['C="en"; C=en+', 'zh-CN'],
])

test('a literal trailing slash redirects before machine dispatch for GET and POST', async () => {
  // Frozen from the redirects this application served before the migration:
  // strip the trailing slash, keep the query string, answer 308.
  const cases = [
    ['/mikka/api/version/', '/mikka/api/version'],
    ['/mikka/w/a%20b/', '/mikka/w/a%20b'],
    ['/mikka/.well-known/oauth-authorization-server/', '/mikka/.well-known/oauth-authorization-server'],
    ['/.well-known/workflow/v1/flow/', '/.well-known/workflow/v1/flow'],
    ['/mikka/%61pi/missing/', '/mikka/%61pi/missing'],
    ['/mikka/api%2Fmissing/', '/mikka/api%2Fmissing'],
    ['/mikka/api/%E0%A4%A/', '/mikka/api/%E0%A4%A'],
  ]
  for (const method of ['GET', 'POST']) for (const [path, expected] of cases) {
    const input = request(`${path}?x=a%2Fb&x=c+d`, { method, ...(method === 'POST' ? { body: 'unchanged payload' } : {}) })
    const migrated = await pageResponse(input, () => { throw new Error('REDIRECT_MUST_PRECEDE_SPA') })
    assert.equal(migrated.status, 308, path)
    assert.equal(migrated.headers.get('location'), `https://example.test${expected}?x=a%2Fb&x=c+d`, path)
    assert.equal(input.bodyUsed, false)
  }
  const encodedFinal = await pageResponse(request('/mikka/api/version%2F?x=1'), render)
  assert.equal(encodedFinal.status, 404)
  assert.equal(encodedFinal.headers.has('location'), false)
})

test('page locale uses the same last valid cookie as the installed SDK', async () => {
  for (const name of ['mikka-locale', 'NEXT_LOCALE']) for (const [template, expected] of FROZEN_LOCALES) {
    const cookie = template.replaceAll('C=', `${name}=`)
    const input = request('/mikka/settings', { headers: { cookie, 'accept-language': 'zh-CN', 'sec-fetch-dest': 'document' } })
    // Frozen from the SDK's cookie parser: the last valid value wins, and any
    // undecodable or unknown value falls back to the default locale.
    assert.equal(localizePage(input).locale, expected, cookie)
    const response = await pageResponse(input, render)
    if (expected === 'en') assert.equal(response.headers.get('location'), 'https://example.test/mikka/en/settings')
    else assert.match(await response.text(), /lang="zh-CN"/)
    assert.equal(input.headers.get('cookie'), cookie)
  }
})

const NEW_EN = 'mikka-locale=en; Max-Age=31536000; Path=/mikka; SameSite=Lax'
const NEW_ZH = 'mikka-locale=zh-CN; Max-Age=31536000; Path=/mikka; SameSite=Lax'
const EXPIRE_LEGACY = 'NEXT_LOCALE=; Max-Age=0; Path=/mikka; SameSite=Lax'
const page = (path, cookie, dest = 'document') => pageResponse(request(path, { headers: { cookie, 'accept-language': 'zh-CN', ...(dest ? { 'sec-fetch-dest': dest } : {}) } }), render)

test('a document with only the legacy cookie keeps the choice, sets the new cookie and expires the old one', async () => {
  const english = await page('/mikka/settings?section=general', 'NEXT_LOCALE=en; other=kept')
  assert.equal(english.status, 307)
  assert.equal(english.headers.get('location'), 'https://example.test/mikka/en/settings?section=general')
  assert.deepEqual(english.headers.getSetCookie(), [NEW_EN, EXPIRE_LEGACY])
  const chinese = await page('/mikka/settings', 'NEXT_LOCALE=zh-CN')
  assert.equal(chinese.status, 200)
  assert.match(await chinese.text(), /lang="zh-CN"/)
  assert.deepEqual(chinese.headers.getSetCookie(), [NEW_ZH, EXPIRE_LEGACY])
  // The browser stores both before following the redirect, so the next document is quiet.
  assert.deepEqual((await page('/mikka/en/settings?section=general', 'other=kept; mikka-locale=en')).headers.getSetCookie(), [])
  // A legacy value that names no locale is ignored, as before, and still expired.
  assert.deepEqual((await page('/mikka/settings', 'NEXT_LOCALE=fr')).headers.getSetCookie(), [NEW_ZH, EXPIRE_LEGACY])
})

test('the new cookie wins over the legacy one, and a migrated browser gets no Set-Cookie', async () => {
  for (const cookie of ['mikka-locale=en; NEXT_LOCALE=zh-CN', 'NEXT_LOCALE=zh-CN; mikka-locale=en']) {
    const input = request('/mikka/settings', { headers: { cookie, 'accept-language': 'zh-CN', 'sec-fetch-dest': 'document' } })
    assert.equal(localizePage(input).locale, 'en', cookie)
    const response = await pageResponse(input, render)
    assert.equal(response.headers.get('location'), 'https://example.test/mikka/en/settings')
    assert.deepEqual(response.headers.getSetCookie(), [EXPIRE_LEGACY], cookie)
  }
  // A new cookie that names no locale falls back to the legacy choice and is rewritten.
  assert.deepEqual((await page('/mikka/en', 'mikka-locale=fr; NEXT_LOCALE=en')).headers.getSetCookie(), [NEW_EN, EXPIRE_LEGACY])
  for (const [path, cookie] of [['/mikka/en/settings', 'mikka-locale=en'], ['/mikka/settings', 'mikka-locale=zh-CN']]) {
    const response = await page(path, cookie)
    assert.equal(response.status, 200)
    assert.deepEqual(response.headers.getSetCookie(), [], cookie)
  }
  // An explicit language in the path replaces the stored one, once.
  assert.deepEqual((await page('/mikka/en', 'mikka-locale=zh-CN')).headers.getSetCookie(), [NEW_EN])
})

test('only document requests migrate; other requests still read the legacy choice', async () => {
  for (const dest of ['empty', null]) {
    const response = await page('/mikka/settings', 'NEXT_LOCALE=en', dest)
    assert.equal(response.headers.get('location'), 'https://example.test/mikka/en/settings')
    assert.deepEqual(response.headers.getSetCookie(), [])
  }
})

test('page-only locale and legacy redirects retain query while machine paths never get SPA HTML', async () => {
  assert.equal((await pageResponse(request('/'), render)).headers.get('location'), 'https://example.test/mikka')
  for (const path of ['/mikka/api/missing', '/mikka/%61pi/missing', '/mikka/api%2Fmissing', '/mikka/v1/missing', '/mikka/w/slug', '/.well-known/workflow/v1/flow', '/mikka/%E0%A4%A']) {
    assert.equal(isMachinePath(path), true, path)
    assert.equal((await pageResponse(request(path), render)).status, 404, path)
  }
  const translated = await pageResponse(request('/mikka/en/settings?workspace=1'), render)
  assert.match(await translated.text(), /lang="en"/)
  assert.equal(translated.headers.get('vary'), 'Accept-Language, Cookie')
  assert.equal((await pageResponse(request('/mikka/zh-CN/settings?workspace=1'), render)).headers.get('location'), 'https://example.test/mikka/settings?workspace=1')
  const preview = await pageResponse(request('/mikka/en/preview/settings?workspace=1&invite=1&secret=drop'), render, { production: true })
  assert.equal(preview.headers.get('location'), 'https://example.test/mikka/en/settings/members?workspace=1&invite=1')
})

test('security projection preserves body stream, raw cookies, status and route-specific headers', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 206, headers: { 'content-range': 'bytes 0-9/50', 'referrer-policy': 'no-referrer' } })
  response.crossws = { upgrade() { throw new Response(null, { status: 400 }) } }
  response.headers.append('set-cookie', 'a=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT')
  response.headers.append('set-cookie', 'b=; Max-Age=0; Path=/mikka')
  const secured = applySecurityHeaders(request('/mikka/api/stream'), response)
  assert.equal(secured.crossws, response.crossws)
  assert.equal(secured.body, response.body); assert.equal(secured.status, 206)
  assert.equal(secured.headers.get('content-range'), 'bytes 0-9/50')
  assert.equal(secured.headers.get('referrer-policy'), 'no-referrer')
  assert.deepEqual(secured.headers.getSetCookie(), response.headers.getSetCookie())
  await secured.body.cancel(); assert.equal(cancelled, true)
})

test('token pages keep private headers in both locales; document requests alone update locale cookie', async () => {
  for (const path of ['/mikka/reset-password?token=x', '/mikka/en/verify-email?token=x', '/mikka/device?code=x', '/mikka/a/public']) {
    const response = await pageResponse(request(path), render)
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  const document = await pageResponse(request('/mikka/en', { headers: { 'sec-fetch-dest': 'document' } }), render)
  assert.equal(document.headers.get('set-cookie'), 'mikka-locale=en; Max-Age=31536000; Path=/mikka; SameSite=Lax')
  assert.equal((await pageResponse(request('/mikka/en'), render)).headers.get('set-cookie'), null)
})

test('only official GitHub cloud installation state continues from the unchanged homepage Setup URL', () => {
  const state = `mikka-gh.00000000-0000-4000-8000-000000000001.${'x'.repeat(43)}`
  const path = `/mikka?installation_id=99&state=${state}&return_to=https://untrusted.example`
  const response = pageRedirect(request(path), { edition: 'cloud' })
  assert.equal(response.status, 302)
  const target = new URL(response.headers.get('location'))
  assert.equal(target.origin, 'https://example.test'); assert.equal(target.pathname, '/mikka/cloud/v1/github/setup')
  assert.deepEqual([...target.searchParams.entries()].sort(), [['installation_id', '99'], ['state', state]])
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer'); assert.equal(response.headers.get('cache-control'), 'no-store')
  for (const candidate of ['/mikka', '/mikka?installation_id=99', '/mikka?installation_id=99&state=ordinary-install', `${path}&state=duplicate`, path.replace('installation_id=99', 'installation_id=invalid'), path.replace('/mikka?', '/mikka/settings?')]) {
    assert.equal(pageRedirect(request(candidate), { edition: 'cloud' }), undefined)
  }
  assert.equal(pageRedirect(request(path), { edition: 'community' }), undefined)
  assert.equal(pageRedirect(request(path, { method: 'POST' }), { edition: 'cloud' }), undefined)
})

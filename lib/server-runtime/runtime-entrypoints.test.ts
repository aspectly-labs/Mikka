import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * The server runtime this repository owns after retiring Next.js, checked at
 * runtime rather than at the type level: the request-scoped cache, read-only
 * request headers, handler redirects, the deployment base path and the locale
 * rules that server routes and redirects share with the browser helper.
 * A regression here is silent: nothing throws, the wrong URL or the wrong cache
 * simply ships. The interface's client entry points (links, lazy components,
 * the client router) are checked with the interface, in the private UI checkout
 * (core/lib/client-runtime/runtime-entrypoints.test.tsx).
 *
 * `MIKKA_BASE_PATH` is read once when the module graph is first evaluated, so it
 * has to be set before the imports below. Serving under `/mikka` is the real
 * hosted shape, and it is also the case the default empty prefix cannot cover.
 */
process.env.MIKKA_BASE_PATH = '/mikka'

const { createRequestScope, runRequestScope } = await import('../../apps/api/src/context')
const serverOnly = await import('../server-only')
const navigation = await import('./navigation')
const serverReact = await import('./react')
const serverRuntime = await import('./server')
const requestHeaders = await import('./headers')
const serverLocalized = await import('./localized-navigation')
const location = await import('../client-runtime/location')
const i18nServer = await import('../intl/i18n-server')

const scopeFor = (url: string, cookie?: string) =>
  createRequestScope(new Request(url, cookie ? { headers: { cookie } } : undefined))

test('the server boundary marker contributes no runtime exports', () => {
  // Its guarantee is enforced at build time: `apps/frontend` rejects any module
  // that resolves here. What matters at runtime is that importing it is inert,
  // so the marker can sit inside a server module without pulling anything in.
  assert.deepEqual(Object.keys(serverOnly), [])
})

test('a nested handler answer throws a marker the dispatcher turns into HTTP', () => {
  // Route handlers cannot return a location from nested code, so these throw
  // and `apps/api/src/application.ts` maps the marker onto a response. A wrong
  // status here becomes a wrong redirect for every caller at once.
  assert.throws(
    () => navigation.redirect('/sign-in'),
    (error: unknown) => error instanceof navigation.NavigationResponse
      && error.status === 307 && error.location === '/sign-in',
    'redirect is a 307 with its location',
  )
  assert.throws(
    () => navigation.permanentRedirect('/moved'),
    (error: unknown) => error instanceof navigation.NavigationResponse
      && error.status === 308 && error.location === '/moved',
    'permanentRedirect is a 308 with its location',
  )
  assert.throws(
    () => navigation.notFound(),
    (error: unknown) => error instanceof navigation.NavigationResponse
      && error.status === 404 && error.location === undefined,
    'notFound carries no location',
  )
})

test('the server graph memoises cache calls per request, never across requests', () => {
  // The API build aliases bare `react` to this module, so every `cache()` call
  // in the server graph lands here. Sharing one memo across requests would leak
  // one user's authorised read into another's page.
  let calls = 0
  const counted = serverReact.cache((key: string) => {
    calls++
    return `${key}:${calls}`
  })

  const first = scopeFor('http://localhost/mikka/api/a')
  const answered = runRequestScope(first, () => [counted('k'), counted('k')])
  assert.deepEqual(answered, ['k:1', 'k:1'], 'the same argument within a request answers once')
  assert.equal(calls, 1)

  runRequestScope(first, () => counted('k'))
  assert.equal(calls, 1, 'a later call in the same request reuses the memo')

  const second = scopeFor('http://localhost/mikka/api/b')
  runRequestScope(second, () => counted('k'))
  assert.equal(calls, 2, 'a new request starts from an empty memo')

  assert.equal(counted('k'), 'k:3', 'outside a request the call passes straight through')
})

test('the server graph cache keeps a failed call failed instead of replaying it', () => {
  // A rejected read that silently retried would double a write or hide the
  // original error, so the memo stores the throw as well.
  let calls = 0
  const failing = serverReact.cache(() => {
    calls++
    throw new Error('nope')
  })
  const scope = scopeFor('http://localhost/mikka/api/c')
  runRequestScope(scope, () => assert.throws(() => failing(), /nope/))
  runRequestScope(scope, () => assert.throws(() => failing(), /nope/))
  assert.equal(calls, 1, 'the failure is remembered, not re-executed')
})

test('a request reads its own headers and cannot rewrite them', async () => {
  // `headers()` replaces the framework's read-only view. A handler that could
  // rewrite the request would change what the rest of its own request observes.
  await assert.rejects(
    () => requestHeaders.headers(),
    /outside a request scope/,
    'reading headers with no request in scope is an error, not an empty bag',
  )
  const scope = scopeFor('http://localhost/mikka/api/x', 'mikka-locale=en')
  await runRequestScope(scope, async () => {
    const seen = await requestHeaders.headers()
    assert.equal(seen.get('cookie'), 'mikka-locale=en', 'the scope carries the real request headers')
    assert.throws(() => seen.set('x', 'y'), /API_REQUEST_HEADERS_READONLY/)
    assert.throws(() => seen.append('x', 'y'), /API_REQUEST_HEADERS_READONLY/)
    assert.throws(() => seen.delete('cookie'), /API_REQUEST_HEADERS_READONLY/)
  })
})

test('server translations read the locale of the request in scope', async () => {
  const english = scopeFor('http://localhost/mikka/api/x', 'mikka-locale=en')
  assert.equal(await runRequestScope(english, () => i18nServer.getLocale()), 'en')
  const chinese = scopeFor('http://localhost/mikka/api/x')
  assert.equal(await runRequestScope(chinese, () => i18nServer.getLocale()), 'zh-CN')
})

test('the server request URL drops the deployment prefix exactly once', () => {
  // Handlers read `url.pathname` as the application path; the prefix belongs to
  // the browser bar, not to routing.
  const prefixed = new serverRuntime.RouteURL('http://localhost/mikka/dashboard')
  assert.equal(prefixed.pathname, '/dashboard')
  assert.equal(prefixed.basePath, '/mikka', 'the prefix is remembered so a redirect can put it back')
  const bare = new serverRuntime.RouteURL('http://localhost/dashboard')
  assert.equal(bare.pathname, '/dashboard')
  assert.equal(bare.basePath, '', 'an unprefixed deployment is left alone')
  assert.equal(new serverRuntime.RouteURL('http://localhost/mikka').pathname, '/', 'the bare prefix is the root')
})

test('server redirects prefix the locale and keep the query', () => {
  assert.equal(serverLocalized.getPathname({ href: '/dashboard', locale: 'en' }), '/en/dashboard')
  assert.equal(serverLocalized.getPathname({ href: '/dashboard', locale: 'zh-CN' }), '/dashboard')
  assert.equal(
    serverLocalized.getPathname({ href: { pathname: '/search', query: { q: 'needle', tag: ['a', 'b'] }, hash: 'h' }, locale: 'en' }),
    '/en/search?q=needle&tag=a&tag=b#h',
  )
  assert.equal(serverLocalized.getPathname({ href: 'https://example.com/x', locale: 'en' }), 'https://example.com/x', 'an absolute URL is left alone')
  assert.throws(
    () => serverLocalized.redirect({ href: '/sign-in', locale: 'en' }),
    (error: unknown) => error instanceof navigation.NavigationResponse && error.status === 307 && error.location === '/en/sign-in',
  )
})

test('the locale root differs between the server and the browser helper', () => {
  // Both modules document themselves as matching the other, and they agree on
  // every real page path — they diverge only on the locale root, where the
  // server yields `/en` and the browser yields `/en/`. Pinning both here keeps
  // the difference visible instead of letting one side drift unnoticed; making
  // them agree changes a redirect target and is tracked separately.
  assert.equal(serverLocalized.getPathname({ href: '/', locale: 'en' }), '/en')
  assert.equal(location.localeHref('/', 'en'), '/en/')
  assert.equal(serverLocalized.getPathname({ href: '/dashboard', locale: 'en' }), location.localeHref('/dashboard', 'en'),
    'every other path agrees')
})

test('a self-hosted base path is stripped once and never leaks into routes', () => {
  // The router stores the prefixed pathname the browser shows. Everything that
  // compares or renders a route has to peel the prefix back off first.
  assert.equal(location.withoutBase('/mikka/dashboard'), '/dashboard')
  assert.equal(location.withoutBase('/mikka'), '/', 'the bare prefix is the root, not an empty path')
  assert.equal(location.withoutBase('/mikka/'), '/', 'the trailing-slash form is the root too')
  assert.equal(location.withoutBase('/elsewhere/dashboard'), '/elsewhere/dashboard')
  assert.equal(location.withoutBase('/mikkabox'), '/mikkabox', 'a longer name sharing the prefix is not stripped')
})

test('a locale segment is recognised only at the front of the route', () => {
  assert.equal(location.localeOf('/mikka/en/dashboard'), 'en')
  assert.equal(location.localeOf('/mikka/zh-CN/dashboard'), 'zh-CN')
  assert.equal(location.localeOf('/mikka/dashboard'), 'zh-CN', 'the unprefixed default locale is Chinese')

  assert.equal(location.withoutLocale('/mikka/en/dashboard'), '/dashboard')
  assert.equal(location.withoutLocale('/mikka/en'), '/', 'the locale root collapses to the route root')
  assert.equal(location.withoutLocale('/mikka/dashboard/en'), '/dashboard/en', 'an inner segment is not a locale')
})

test('an href is serialised the way links and redirects expect', () => {
  assert.equal(location.hrefString('/dashboard'), '/dashboard')
  assert.equal(
    location.hrefString({ pathname: '/search', query: { q: 'needle', tag: ['a', 'b'], skip: undefined, n: 2 } }),
    '/search?q=needle&tag=a&tag=b&n=2',
  )
  assert.equal(location.hrefString({ pathname: '/x', hash: '#section' }), '/x#section')
  assert.equal(location.hrefString({ query: { q: 'only-query' } }), '/?q=only-query', 'a missing pathname is the root')
})

test('a localized href carries the locale prefix without doubling the base path', () => {
  // i18n returns a locale path and leaves the base path to the caller, so the
  // two must not both be applied here. A doubled prefix is a 404 in production.
  assert.equal(location.localeHref('/dashboard', 'en'), '/en/dashboard')
  assert.equal(location.localeHref('/dashboard', 'zh-CN'), '/dashboard')
  assert.equal(location.localeHref('/dashboard?a=1#h', 'en'), '/en/dashboard?a=1#h')
  assert.equal(location.localeHref('https://example.com/x', 'en'), 'https://example.com/x', 'an absolute URL is left alone')
})

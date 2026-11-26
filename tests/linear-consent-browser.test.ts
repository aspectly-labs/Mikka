import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mock, test } from 'node:test'
import { chromium } from '@playwright/test'

test('Chromium follows desktop account confirmation to a separate Linear consent origin', async t => {
  const session = { user: { id: 'alice', email: 'alice@example.test' }, session: { id: 'native-session' } }
  mock.module('@/lib/auth', { namedExports: { auth: {
    $context: Promise.resolve({ secret: 'isolated-browser-test-secret-1234567890' }),
    handler: async () => Response.json(session, { headers: { 'set-cookie': 'better-auth.session_token=native-session; Path=/; HttpOnly' } }),
  } } })
  mock.module('@/lib/mobile-web-scope', { namedExports: { mobileWebWorkspace: async () => null, MobileWebScopeError: Error } })
  const { GET, POST } = await import('../app/api/mobile/open/route')
  const provider = createServer((_request, res) => res.end('Synthetic consent'))
  const site = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin(site))
      if (url.pathname === '/api/integrations/linear/connect') {
        assert.equal(url.searchParams.get('account'), 'alice')
        assert.match(req.headers.cookie ?? '', /better-auth.session_token=native-session/)
        res.writeHead(307, { location: origin(provider) + '/oauth/authorize' }).end()
        return
      }
      if (url.pathname !== '/api/mobile/open') { res.writeHead(404).end(); return }
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value)
      let body = ''
      for await (const chunk of req) body += chunk
      const request = new Request(url, { headers, method: req.method, ...(req.method === 'POST' ? { body } : {}) })
      const result = req.method === 'POST' ? await POST(request) : await GET(request)
      res.writeHead(result.status, { ...Object.fromEntries(result.headers), 'set-cookie': result.headers.getSetCookie() })
      res.end(await result.text())
    } catch { res.writeHead(500).end() }
  })
  function origin(server: typeof site) { return 'http://127.0.0.1:' + (server.address() as AddressInfo).port }
  for (const server of [provider, site]) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => { server.closeAllConnections(); server.close() })
  }
  const browser = await chromium.launch({ executablePath: process.env.MIKKA_CHROMIUM_EXECUTABLE_PATH })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const target = '/api/integrations/linear/connect?account=alice'
  await page.goto(origin(site) + '/api/mobile/open?' + new URLSearchParams({ token: 'synthetic', to: target }))
  await page.getByRole('button').click()
  await page.waitForURL(origin(provider) + '/oauth/authorize', { timeout: 5_000 })
  assert.equal(await page.locator('body').innerText(), 'Synthetic consent')
})

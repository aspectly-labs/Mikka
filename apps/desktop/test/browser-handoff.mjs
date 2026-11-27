import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

/**
 * The system browser of a desktop sign-in. The leased account's browser
 * already holds a web session, so the sign-in page shows that account and the
 * app gets it only after 「Continue as」. Returns the app link the loopback
 * callback page opens (src/main/app-link.ts), read from its response.
 */
export async function continueInSystemBrowser(page, external) {
  const callback = page.waitForResponse(response => {
    try {
      const url = new URL(response.url())
      return url.hostname === '127.0.0.1' && url.pathname === '/auth/callback' && response.status() === 200
    } catch { return false }
  }, { timeout: 60_000 })
  callback.catch(() => {})
  await page.goto(external, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  // A server built without the official UI serves apps/frontend/src/headless.ts in place of the sign-in page.
  // Follow the link its 「Continue as」 button holds instead; the server-side handoff is the same request.
  const headless = await page.waitForFunction(() => document.documentElement.dataset.mikkaHeadless === 'true'
    || (document.querySelector('[data-testid="desktop-continue"]') ? 'official' : false), null, { timeout: 60_000 })
    .catch(async error => {
      // The page's path and title only: never its content, which can carry the account.
      const where = await page.evaluate(() => ({ path: location.pathname, title: document.title })).catch(() => null)
      throw new Error(`DESKTOP_HANDOFF_PAGE_UNKNOWN ${JSON.stringify(where)}`, { cause: error })
    })
  if (await headless.jsonValue() === true) {
    // Navigate as the link does: the return redirects to the loopback callback, whose page then opens the app
    // link, so there is no document to wait for here; the callback response above is the evidence.
    await page.evaluate(href => { location.assign(href) }, continueHref(external))
  } else {
    await page.getByTestId('desktop-continue').click({ timeout: 60_000 })
  }
  const html = await (await callback).text().catch(() => '')
  return /<a id="open" href="([^"]+)"/.exec(html)?.[1] ?? null
}

/**
 * The official sign-in page's 「Continue as」 link for this handoff (lib/desktop-auth.ts desktopAuthReturnPath):
 * `<base>/api/desktop/return?state&next&callback`, read from the sign-in URL main opened
 * (`<base>/<locale>/sign-in?desktop=1&desktop_state&desktop_callback&desktop_next`).
 */
export function continueHref(external) {
  const url = new URL(external)
  const signIn = url.pathname.search(/(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/sign-in$/)
  const state = url.searchParams.get('desktop_state'), callback = url.searchParams.get('desktop_callback')
  if (url.searchParams.get('desktop') !== '1' || signIn < 0 || !state || !callback) throw new Error('DESKTOP_HANDOFF_URL_INVALID')
  const query = new URLSearchParams({ state, next: url.searchParams.get('desktop_next') ?? '/' })
  query.set('callback', callback)
  return `${url.origin}${url.pathname.slice(0, signIn)}/api/desktop/return?${query}`
}

/**
 * macOS only, packaged app only: hide the app, open the link the way a browser
 * does (LaunchServices), and report whether a window came to the front.
 */
export async function openAppLink(application, link, executable) {
  execFileSync(LSREGISTER, ['-f', resolve(executable, '../../..')])
  await application.evaluate(({ app }) => app.hide())
  execFileSync('/usr/bin/open', [link])
  for (let attempt = 0; attempt < 100; attempt++) {
    const front = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible() && window.isFocused()))
    if (front) return true
    await new Promise(done => setTimeout(done, 150))
  }
  return false
}

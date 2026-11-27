import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { allowedApiPath } from './bundled-policy'
// @ts-expect-error -- untyped build scripts
import { desktopAliases, desktopOverlayAliases } from '../../../frontend/scripts/application-plugin.mjs'
// @ts-expect-error -- untyped build scripts
import { HOLE, rendererModules, rendererRequests } from '../../scripts/renderer-requests.mjs'
// @ts-expect-error -- untyped build scripts
import { generateRoutes } from '../../../api/scripts/generate-routes.mjs'

// Main forwards only the routes whose `defineRoute` spec declares `desktop`
// (apps/api/generated/desktop-routes.json), so a route the shared UI calls without
// that declaration answers desktop_route_denied in the desktop build. Mikka Desktop
// 2026.10000.1939 shipped fourteen of them because this check skipped whenever the
// official UI checkout was absent. It now walks the renderer's real module graph
// (apps/desktop/scripts/renderer-requests.mjs), follows request helpers across
// modules, and fails instead of skipping wherever CI says a checkout is expected.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const overlay = join(repository, '.hosted-ui')

/**
 * Routes the renderer names but the desktop build does not serve, each with the
 * reason, so the boundary is written down instead of assumed. Everything else
 * the renderer asks for must be declared `desktop` on its route.
 */
const NOT_SERVED: Record<string, string> = {
  '/api/auth/sign-in/sso': 'company sign-in hands off to the system browser',
  '/api/auth/sso/oidc/logout/*': 'SSO sign-out is a browser redirect',
  '/api/auth/sso/saml2/logout/*': 'SSO sign-out is a browser redirect',
  '/api/auth/oauth2/authorize': 'an OAuth return target the browser follows (lib/auth-return.ts), never a request',
  '/api/enterprise/link': 'the enterprise sign-in link is opened in the system browser',
  '/api/github/manifest': 'GitHub App manifests need a public callback URL, so the flow stays on the web',
  '/api/cloud/*': 'managed-cloud connect and disconnect belong to the hosted product',
  '/api/cloud/connect': 'managed-cloud connect and disconnect belong to the hosted product',
  '/api/cloud/disconnect': 'managed-cloud connect and disconnect belong to the hosted product',
  '/api/cloud/status': 'managed-cloud connect and disconnect belong to the hosted product',
  '/api/integrations/google/callback': 'provider callback URL for the Google link, completed by the browser',
  '/api/integrations/github/install': 'the install page link is opened at github.com',
  '/api/integrations/composio/callback': 'an OAuth return target the browser follows (lib/auth-return.ts), never a request',
  '/api/integrations/composio/connect': 'an OAuth return target the browser follows (lib/auth-return.ts), never a request',
  '/api/integrations/slack/connect': 'an OAuth return target the browser follows (lib/auth-return.ts), never a request',
  '/api/mobile/open': 'the web\'s multi-server directory (lib/web-connection) posts it to an explicit server; the desktop has no such directory',
  '/api/rpc': 'the web transport; the desktop renderer calls /api/desktop/rpc (apps/desktop/src/renderer/rpc.ts)',
  '/api/webhooks/automations/*': 'the webhook URL an automation shows for other services to call, never requested by the renderer',
}

const UUID = '84c182d1-661c-461b-bca2-10410cb646d4'
const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
type Route = { template: string; methods: string[] }
type Site = { path: string; methods: Set<string>; files: Set<string>; bare: boolean }

const routes: Route[] = (JSON.parse(readFileSync(join(repository, 'apps/api/generated/routes.json'), 'utf8')) as { routes: Route[] }).routes
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The server's own matching order and patterns (apps/api/src/routes.ts). */
const matchers = routes.map(route => ({
  route,
  pattern: new RegExp(`^${route.template.split('/').map(segment => (segment.startsWith('[[...') ? '(.*)' : segment.startsWith('[...') ? '(.+)' : segment.startsWith('[') ? '([^/]+)' : escape(segment))).join('/').replace('/(.*)', '(?:/(.*))?')}$`),
}))
const serving = (path: string) => matchers.find(matcher => matcher.pattern.test(path))?.route

/** A value for each hole that the routes it could name would accept. */
function samples(path: string): string[] {
  const parts = path.split('/')
  const candidates = [UUID, ULID, `vol_${ULID}`, `vver_${ULID}`, 'a'.repeat(64), '1', 'abc123']
  let paths = [parts]
  for (const [index, part] of parts.entries()) {
    if (part !== HOLE) continue
    paths = paths.flatMap(current => candidates.map(value => current.map((segment, at) => (at === index ? value : segment))))
    if (paths.length > 400) paths = paths.slice(0, 400)
  }
  return paths.map(segments => segments.join('/'))
}

/** Only a hole that fills a whole segment says which route the path becomes; a bare prefix names none. */
const checkable = (path: string) => !path.endsWith('/') && path.split('/').every((part, index) => !part.includes(HOLE) || (part === HOLE && index > 0))
const key = (path: string) => path.replaceAll(HOLE, '*')
const described = (path: string) => path.replaceAll(HOLE, '${…}')

const required = process.env.MIKKA_REQUIRE_OFFICIAL_UI === '1'
const present = existsSync(join(overlay, 'core/renderer/index.tsx'))
// The renderer's screens are the official UI's. Without its checkout there is nothing to scan, which is fine in a
// public-only checkout and fatal wherever CI pairs the two: the desktop release and mikka-hosted-ui's CI set
// MIKKA_REQUIRE_OFFICIAL_UI=1, so the guard can no longer pass by skipping.
const skip = !present && !required && 'needs the official UI checkout at .hosted-ui (set MIKKA_REQUIRE_OFFICIAL_UI=1 to require it)'

let scanned: Map<string, Site> | undefined
function sites(): Map<string, Site> {
  assert.ok(present, 'MIKKA_REQUIRE_OFFICIAL_UI=1 but .hosted-ui/core/renderer/index.tsx is missing: check out mikka-hosted-ui at .hosted-ui')
  const overlayAliases = new Map([...(desktopOverlayAliases as Map<string, string>)].map(([specifier, name]) => [specifier, ({ desktopAuthForm: 'core/renderer/auth-form.tsx' } as Record<string, string>)[name]!]))
  scanned ??= rendererRequests(rendererModules(repository, { overlay, aliases: desktopAliases, overlayAliases })) as Map<string, Site>
  return scanned
}

test('every API route the renderer requests is declared for the desktop', { skip }, () => {
  const denied: string[] = []
  for (const site of sites().values()) {
    if (!checkable(site.path) || NOT_SERVED[key(site.path)] !== undefined) continue
    const candidates = samples(site.path).map(path => ({ path, route: serving(path) })).filter(candidate => candidate.route)
    // A path no server route serves is a prefix or a link target, not a request the main process could forward.
    if (!candidates.length) continue
    const served = new Set(candidates.flatMap(candidate => candidate.route!.methods))
    // A literal seen outside a request (a SWR key, a `…Path()` result) carries no method: any declared one will do.
    const methods = site.bare ? [] : [...site.methods].filter(method => served.has(method))
    const allowed = (method: string) => candidates.some(candidate => allowedApiPath(candidate.path, method))
    if (site.bare) {
      if (![...served].some(method => method !== 'OPTIONS' && allowed(method))) denied.push(`${[...served].filter(method => method !== 'OPTIONS').join('|')} ${described(site.path)} (${[...site.files].join(', ')})`)
      continue
    }
    for (const method of methods) if (!allowed(method)) denied.push(`${method} ${described(site.path)} (${[...site.files].join(', ')})`)
  }
  assert.deepEqual(denied, [], 'declare `desktop: true` on these routes\' defineRoute specs and run `node apps/api/scripts/generate-routes.mjs`, or record in NOT_SERVED why the desktop build does not serve them')
})

test('the recorded exceptions still describe a route the renderer asks for', { skip }, () => {
  const asked = new Set([...sites().keys()].map(key))
  assert.deepEqual(Object.keys(NOT_SERVED).filter(path => !asked.has(path)), [], 'stale NOT_SERVED entries: the renderer no longer asks for these')
})

test('the scan sees the panels whose routes drifted before, including calls through shared helpers', { skip }, () => {
  // Guards the scan itself: a broken walk would make the rule above pass for the wrong reason.
  const asked = new Set([...sites().keys()].map(key))
  const expected = [
    '/api/integrations/github/tools', '/api/organizations', '/api/artifacts/shared/*', '/api/devices', '/api/integrations/github/repositories/pulls',
    // 2026.10000.1939: read through settingsRead(), crew-rail's readJson(), fetchBillingCatalog() and fetchSettingsData().
    '/api/settings/issue-states', '/api/settings/activity', '/api/coordinator/overview', '/api/billing/catalog',
    '/api/workspaces/*/task-labels', '/api/workspaces/*/ops-metrics', '/api/threads/*/children', '/api/integrations/mcp/*/check',
  ]
  assert.deepEqual(expected.filter(path => !asked.has(path)), [], 'missing from the scan')
})

test('the generated desktop route list matches the route declarations', async () => {
  const { files } = await generateRoutes(repository) as { files: [string, string][] }
  const expected = new Map(files).get('desktop-routes.json')
  assert.equal(readFileSync(join(repository, 'apps/api/generated/desktop-routes.json'), 'utf8'), expected, 'run `node apps/api/scripts/generate-routes.mjs`')
})

test('a path resolves to the route the server would serve before its desktop declaration is read', () => {
  // `/api/settings/[read]` is declared; the literal routes beside it decide for themselves.
  assert.equal(allowedApiPath('/api/settings/issue-states', 'GET'), true)
  assert.equal(allowedApiPath('/api/settings/schema', 'GET'), false)
  assert.equal(allowedApiPath('/api/billing/stripe', 'POST'), false, 'the Stripe webhook is never a renderer route')
  // Catch-all routes allow only the sub-paths they list.
  assert.equal(allowedApiPath('/api/auth/unlink-account', 'POST'), true)
  assert.equal(allowedApiPath('/api/auth/sign-out', 'POST'), false)
  assert.equal(allowedApiPath('/api/auth/get-session', 'GET'), false)
  assert.equal(allowedApiPath('/api/agents/eve/v1/session/wrun_1/stream', 'GET'), true)
  assert.equal(allowedApiPath('/api/agents/eve/v1/session/wrun_1/stream', 'POST'), false)
  assert.equal(allowedApiPath('/api/agents/eve/v1/admin', 'GET'), false)
  assert.equal(allowedApiPath(`/api/bots/${UUID}/computer/viewer`, 'POST'), false, 'viewer grants come only through owner-bound IPC')
})

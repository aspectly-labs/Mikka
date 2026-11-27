// Every API route the official UI requests must exist on the server, with the
// method the UI sends: a contract between the UI checkout (.hosted-ui) and this
// repository's route table (apps/api/generated/routes.json). A route renamed or
// removed on one side shows here instead of as a 404 in the web and desktop apps.
//
// The scan (apps/desktop/scripts/renderer-requests.mjs) walks each build's real
// module graph and follows request helpers across modules. Without the UI
// checkout there is nothing to scan: that skips in a public-only checkout and
// fails wherever CI pairs the two (the desktop release and mikka-hosted-ui's CI
// set MIKKA_REQUIRE_OFFICIAL_UI=1), so the contract cannot pass by skipping.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopAliases, desktopOverlayAliases } from '../apps/frontend/scripts/application-plugin.mjs'
import { HOLE, rendererModules, rendererRequests } from '../apps/desktop/scripts/renderer-requests.mjs'
import { CLIENT_FLAG_KEYS } from '../lib/feature-flags.ts'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const overlay = join(repository, '.hosted-ui')

/**
 * `/api/…` paths the UI names that this server does not serve, each with the
 * reason. Everything else the UI names must be a route the server has.
 */
const UNSERVED = {
  '/api/agents': 'the Eve client\'s base path; its requests go below it (/api/agents/eve/v1/…)',
  '/api/auth': 'the Better Auth client\'s base path',
  '/api/devices/hosts': 'asked of a Mikka that may report SSH hosts; a 404 falls back to typing a host (lib/computer/client.ts listKnownHosts)',
}

const UUID = '84c182d1-661c-461b-bca2-10410cb646d4'
const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const routes = JSON.parse(readFileSync(join(repository, 'apps/api/generated/routes.json'), 'utf8')).routes
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The server's own matching order and patterns (apps/api/src/routes.ts). */
const matchers = routes.map(route => ({
  route,
  pattern: new RegExp(`^${route.template.split('/').map(segment => (segment.startsWith('[[...') ? '(.*)' : segment.startsWith('[...') ? '(.+)' : segment.startsWith('[') ? '([^/]+)' : escape(segment))).join('/').replace('/(.*)', '(?:/(.*))?')}$`),
}))
const serving = path => matchers.find(matcher => matcher.pattern.test(path))?.route

/** The routes a path with holes could name: same depth, every literal segment equal. */
function matching(path) {
  const parts = path.split('/')
  return routes.filter(route => {
    const candidate = route.template.split('/')
    return candidate.length === parts.length && candidate.every((segment, index) => parts[index] === HOLE || segment === parts[index] || segment.startsWith('['))
  })
}

/** Values for each hole: the literal segments the routes it could name put there, then plain ids. */
function samples(path) {
  const parts = path.split('/')
  const near = matching(path)
  let paths = [parts]
  for (const [index, part] of parts.entries()) {
    if (part !== HOLE) continue
    const literals = near.map(route => route.template.split('/')[index]).filter(segment => !segment.startsWith('['))
    const candidates = [...new Set([...literals, UUID, ULID, `vol_${ULID}`, `vver_${ULID}`, 'a'.repeat(64), '1', 'abc123'])]
    paths = paths.flatMap(current => candidates.map(value => current.map((segment, at) => (at === index ? value : segment)))).slice(0, 2000)
  }
  return paths.map(segments => segments.join('/'))
}

/** Only a hole that fills a whole segment says which route the path becomes. */
const checkable = path => !path.endsWith('/') && path.split('/').every((part, index) => !part.includes(HOLE) || (part === HOLE && index > 0))
const key = path => path.replaceAll(HOLE, '*')
const described = path => path.replaceAll(HOLE, '${…}')

const required = process.env.MIKKA_REQUIRE_OFFICIAL_UI === '1'
const present = existsSync(join(overlay, 'core/renderer/index.tsx'))
const skip = !present && !required && 'needs the official UI checkout at .hosted-ui (set MIKKA_REQUIRE_OFFICIAL_UI=1 to require it)'

const graphs = new Map()
function modules(target) {
  assert.ok(present, 'MIKKA_REQUIRE_OFFICIAL_UI=1 but .hosted-ui/core/renderer/index.tsx is missing: check out mikka-hosted-ui at .hosted-ui')
  if (!graphs.has(target)) {
    const overlayAliases = new Map([...desktopOverlayAliases].map(([specifier, name]) => [specifier, { desktopAuthForm: 'core/renderer/auth-form.tsx' }[name]]))
    const graph = rendererModules(repository, { overlay, aliases: desktopAliases, overlayAliases, target })
    graphs.set(target, { graph, sites: rendererRequests(graph) })
  }
  return graphs.get(target)
}

for (const target of ['desktop', 'web']) {
  test(`every API route the ${target} UI requests exists on the server with its method`, { skip }, () => {
    const missing = []
    for (const site of modules(target).sites.values()) {
      if (!checkable(site.path) || UNSERVED[key(site.path)] !== undefined) continue
      const served = samples(site.path).map(serving).filter(Boolean)
      const where = `(${[...site.files].join(', ')})`
      if (!served.length) { missing.push(`${site.bare ? 'ANY' : [...site.methods].join('|')} ${described(site.path)}: no route ${where}`); continue }
      // A literal seen outside a request (a SWR key, a `…Path()` result) names a route but not its method.
      if (site.bare) continue
      const methods = new Set(served.flatMap(route => route.methods.includes('GET') ? [...route.methods, 'HEAD'] : route.methods))
      for (const method of site.methods) if (!methods.has(method)) missing.push(`${method} ${described(site.path)}: the route has ${[...methods].join(', ')} ${where}`)
    }
    assert.deepEqual(missing, [], 'the UI requests these, but the server does not serve them: fix the UI or the route, or record in UNSERVED why the server does not serve it')
  })
}

test('the recorded literals are still in the UI', { skip }, () => {
  const named = new Set(['desktop', 'web'].flatMap(target => [...modules(target).sites.keys()].map(key)))
  assert.deepEqual(Object.keys(UNSERVED).filter(path => !named.has(path)), [], 'stale UNSERVED entries')
})

test('the scan sees the requests whose drift shipped before, including calls through shared helpers', { skip }, () => {
  // Guards the scan itself: a broken walk would make the rules above pass for the wrong reason.
  const named = new Set([...modules('desktop').sites.keys()].map(key))
  const expected = [
    '/api/integrations/github/tools', '/api/organizations', '/api/artifacts/shared/*', '/api/devices', '/api/integrations/github/repositories/pulls',
    // Mikka Desktop 2026.10000.1939: read through settingsRead(), crew-rail's readJson(), fetchBillingCatalog() and fetchSettingsData().
    '/api/settings/issue-states', '/api/settings/activity', '/api/coordinator/overview', '/api/billing/catalog',
    '/api/workspaces/*/task-labels', '/api/workspaces/*/ops-metrics', '/api/threads/*/children', '/api/integrations/mcp/*/check',
  ]
  assert.deepEqual(expected.filter(path => !named.has(path)), [], 'missing from the scan')
})

test('every flag the desktop renderer reads is one its bootstrap carries', { skip }, () => {
  // The desktop renderer reads flags from its bootstrap snapshot (CLIENT_FLAG_KEYS); a flag missing there would
  // silently read as not loaded on the desktop while the web follows PostHog.
  const read = new Map()
  for (const module of modules('desktop').graph.values()) {
    const constants = new Map([...module.source.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*['"]([^'"]+)['"]/g)].map(match => [match[1], match[2]]))
    for (const match of module.source.matchAll(/\bpostHogFlag\(\s*(?:['"]([^'"]+)['"]|([A-Z][A-Z0-9_]*)\s*\))/g)) {
      const flag = match[1] ?? constants.get(match[2])
      if (flag) read.set(flag, module.name)
    }
  }
  assert.ok(read.has('mikka-personal-writes-off'), 'the scan sees use-approval-live\'s flag read')
  assert.deepEqual([...read].filter(([flag]) => !CLIENT_FLAG_KEYS.includes(flag)).map(([flag, file]) => `${flag} (${file})`), [], 'add these to CLIENT_FLAG_KEYS in lib/feature-flags.ts')
})

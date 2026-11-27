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
import { officialUiSkip } from './official-ui-requirement.mjs'
import ts from 'typescript'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const overlay = join(repository, '.hosted-ui')

/**
 * `/api/…` paths the UI names that this server does not serve, each with the
 * reason. Everything else the UI names must be a route the server has.
 */
const UNSERVED = {
  '/api/agents': 'the Eve client\'s base path; its requests go below it (/api/agents/eve/v1/…)',
  '/api/auth': 'the Better Auth client\'s base path',
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

/** The keys of an object literal `const <name> = {…}` in a route's source, one per line at two spaces. */
function literalKeys(file, name) {
  const source = readFileSync(join(repository, file), 'utf8')
  const start = source.search(new RegExp(`\\bconst ${name}\\b[^\\n]*= \\{$`, 'm'))
  assert.ok(start >= 0, `${file} has no const ${name} = {…}`)
  const body = source.slice(start, source.indexOf('\n}', start))
  return new Set([...body.matchAll(/^ {2}(?:'([^']+)'|([A-Za-z][\w-]*))\s*:/gm)].map(match => match[1] ?? match[2]))
}

/**
 * Routes whose one handler dispatches on a path segment: the route table has
 * `/api/settings/[read]`, but only the reads its READS table names exist, so
 * `/api/settings/issue-statez` must fail here rather than 404 in the app.
 * The catch-alls (`/api/auth/[...all]` is Better Auth's router,
 * `/api/agents/[...path]` Eve's) dispatch in their libraries and are not
 * checked below their base path.
 */
const DISPATCHED = {
  '/api/settings/[read]': { segment: 3, values: literalKeys('app/api/settings/[read]/route.ts', 'READS') },
}
/** Whether a sample of the UI's path names something the route serves. A hole in the dispatched segment cannot be checked. */
function dispatches(path, sample, route) {
  const dispatch = DISPATCHED[route.template]
  if (!dispatch) return true
  return path.split('/')[dispatch.segment] === HOLE || dispatch.values.has(sample.split('/')[dispatch.segment])
}

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

const present = existsSync(join(overlay, 'core/renderer/index.tsx'))
// With MIKKA_REQUIRE_OFFICIAL_UI=1 a missing checkout fails the file at import; a value other than 1 or 0 fails too.
const skip = officialUiSkip(present, '.hosted-ui')

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

/** What the server does not serve of the requests the scan found. */
function unserved(sites) {
  const missing = []
  for (const site of sites) {
    if (!checkable(site.path) || UNSERVED[key(site.path)] !== undefined) continue
    const served = samples(site.path).map(sample => [sample, serving(sample)]).filter(([sample, route]) => route && dispatches(site.path, sample, route)).map(([, route]) => route)
    const where = `(${[...site.files].join(', ')})`
    if (!served.length) { missing.push(`${site.bare ? 'ANY' : [...site.methods].join('|')} ${described(site.path)}: no route ${where}`); continue }
    // A literal seen outside any request (a `…Path()` result, an endpoint
    // constant) names a route but not its method. A SWR key is not bare: the
    // scan records it as the GET its fetcher sends, so its method is checked.
    if (site.bare) continue
    const methods = new Set(served.flatMap(route => route.methods.includes('GET') ? [...route.methods, 'HEAD'] : route.methods))
    for (const method of site.methods) if (!methods.has(method)) missing.push(`${method} ${described(site.path)}: the route has ${[...methods].join(', ')} ${where}`)
  }
  return missing
}

for (const target of ['desktop', 'web']) {
  test(`every API route the ${target} UI requests exists on the server with its method`, { skip }, () => {
    assert.deepEqual(unserved(modules(target).sites.values()), [], 'the UI requests these, but the server does not serve them: fix the UI or the route, or record in UNSERVED why the server does not serve it')
  })
}

test('a parameter-dispatched route serves only the values its handler names', () => {
  // Needs no UI checkout: the check itself, on requests written here.
  const reads = DISPATCHED['/api/settings/[read]'].values
  for (const read of ['issue-states', 'activity', 'issue-prefix', 'audit']) assert.ok(reads.has(read), read)
  assert.equal(reads.has('personal'), false, 'personal is its own route, not a READS entry')
  const site = (path, method = 'GET') => ({ path, methods: new Set([method]), files: new Set(['test']), bare: false })
  assert.deepEqual(unserved([site('/api/settings/issue-states'), site('/api/settings/personal', 'PATCH'), site(`/api/settings/${HOLE}`)]), [])
  assert.deepEqual(unserved([site('/api/settings/issue-statez')]), ['GET /api/settings/issue-statez: no route (test)'])
  assert.deepEqual(unserved([site('/api/settings/issue-states', 'POST')]), ['POST /api/settings/issue-states: the route has GET, HEAD (test)'])
})

test('a SWR key is a GET the route must serve, not just a route that exists', () => {
  // Needs no UI checkout: the scan and the check, on a module written here.
  const writeOnly = routes.find(route => !route.methods.includes('GET') && !route.template.includes('['))
  assert.ok(writeOnly, 'the route table has a static route without GET')
  const source = [
    "import useSWR from 'swr'",
    "export function A({ on }: { on: boolean }) { useSWR(on ? '/api/settings/issue-states' : null, fetcher); useSWR(`" + writeOnly.template + "`, fetcher); return null }",
    "const endpoint = { path: '/api/settings/activity' }",
  ].join('\n')
  const ast = ts.createSourceFile('fixture.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const sites = rendererRequests(new Map([['fixture.tsx', { name: 'fixture.tsx', path: 'fixture.tsx', source, ast, imports: new Map() }]]))
  assert.deepEqual([...sites.values()].map(site => [site.path, [...site.methods], site.bare]), [
    ['/api/settings/issue-states', ['GET'], false], [writeOnly.template, ['GET'], false], ['/api/settings/activity', ['GET'], true],
  ])
  assert.deepEqual(unserved(sites.values()), [`GET ${writeOnly.template}: the route has ${writeOnly.methods.join(', ')} (fixture.tsx)`])
})

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

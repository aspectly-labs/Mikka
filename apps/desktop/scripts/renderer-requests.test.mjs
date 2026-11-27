import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { HOLE, rendererModules, rendererRequests } from './renderer-requests.mjs'

// The call shapes Mikka Desktop 2026.10000.1939 failed on: none of them names its
// route at a `fetch`, so the earlier scan read none of them.
const files = {
  'apps/frontend/src/index.ts': "import 'mikka:frontend-runtime'\nawait import('mikka:application')\n",
  '.hosted-ui/core/renderer/installed-startup.ts': 'export {}\n',
  '.hosted-ui/core/renderer/index.tsx': "import '@hosted/web/settings'\nimport './rail'\nimport { lazy } from 'react'\nexport const Page = lazy(() => import('@hosted/web/lazy'))\n",
  // A settings read builds its URL from its argument (lib/settings-read.ts).
  'lib/settings-read.ts': "import { withBasePath } from '@/lib/base-path'\nexport async function settingsRead(read, query = {}) {\n  const params = new URLSearchParams(query)\n  const search = params.size ? `?${params}` : ''\n  return fetch(withBasePath(`/api/settings/${read}${search}`), { cache: 'no-store' })\n}\n",
  'lib/base-path.ts': 'export const withBasePath = path => path\n',
  // A pass-through helper imported from another module, with the method as an argument.
  '.hosted-ui/web/lib/send.ts': "export function send(url, method, body) { return fetch(url, { method, body: JSON.stringify(body) }) }\nexport const fetchSettingsData = url => fetch(url).then(response => response.json())\n",
  '.hosted-ui/web/settings.tsx': [
    "import { settingsRead } from '@/lib/settings-read'",
    "import { send, fetchSettingsData as read } from '@hosted/web/lib/send'",
    "export const a = () => settingsRead('issue-states')",
    "export const b = id => read(`/api/workspaces/${encodeURIComponent(id)}/task-labels`)",
    "export const c = (id, label) => send(`/api/workspaces/${id}/task-labels/${label}`, 'PATCH', {})",
    "export const d = (bot, id) => send(bot ? `/api/mobile/bots/${id}` : `/api/mobile/groups/${id}`, 'PATCH', {})",
    "export const e = () => <a href=\"/api/integrations/github/install\">install</a>",
    '',
  ].join('\n'),
  // A URL kept in a variable and handed to a module-local reader (crew-rail.tsx).
  '.hosted-ui/core/renderer/rail.tsx': [
    "async function readJson(url) { const response = await fetch(url); return response.json() }",
    'export function Rail({ workspaceId, useSWR }) {',
    '  const key = `/api/coordinator/overview?workspaceId=${workspaceId}`',
    '  return useSWR(key, url => readJson(url))',
    '}',
    "export const catalogPath = query => query ? `/api/billing/catalog?${query}` : '/api/billing/catalog'",
    '',
  ].join('\n'),
  '.hosted-ui/web/lazy.tsx': "export default () => fetch('/api/threads/shared/' + 'x', { method: 'GET' })\n",
  // Never bundled: nothing imports it.
  '.hosted-ui/web/unused.tsx': "export const x = () => fetch('/api/unused')\n",
}

test('the scan follows the renderer graph and the helpers between a route and its fetch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'renderer-requests-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), source)
  }
  const modules = rendererModules(root, { overlay: join(root, '.hosted-ui'), aliases: new Map(), overlayAliases: new Map() })
  assert.ok(modules.has('.hosted-ui/web/lazy.tsx'), 'lazy imports are part of the graph')
  assert.ok(!modules.has('.hosted-ui/web/unused.tsx'), 'modules nothing imports are not')
  const sites = new Map([...rendererRequests(modules).values()].map(site => [site.path.replaceAll(HOLE, '*'), site]))
  const methods = path => [...(sites.get(path)?.methods ?? [])].sort()
  assert.deepEqual(methods('/api/settings/issue-states'), ['GET'])
  assert.deepEqual(methods('/api/workspaces/*/task-labels'), ['GET'])
  assert.deepEqual(methods('/api/workspaces/*/task-labels/*'), ['PATCH'])
  assert.deepEqual(methods('/api/mobile/bots/*'), ['PATCH'])
  assert.deepEqual(methods('/api/mobile/groups/*'), ['PATCH'])
  assert.deepEqual(methods('/api/coordinator/overview'), ['GET'])
  // The key reaches the reader through SWR, so the scan sees it as a literal: any method its route declares will do.
  assert.equal(sites.get('/api/coordinator/overview').bare, true)
  assert.equal(sites.get('/api/billing/catalog').bare, true, 'a returned path is a bare literal')
  assert.ok(!sites.has('/api/integrations/github/install'), 'links never reach the main process')
  assert.ok(!sites.has('/api/unused'))
})

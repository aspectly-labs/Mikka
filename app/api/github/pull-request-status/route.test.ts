import '../../../../tests/support/server-only.mjs'
import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import { metadataSchema, withIssueMetadata } from '@/lib/issue-metadata'
import { startGitHubAccessHttp } from '../../../../tests/fakes/github-access-http.mjs'

const issueId = '00000000-0000-4000-8000-000000000001'
const url = 'https://github.com/private/repo/pull/81'
const content = withIssueMetadata({ type: 'doc' }, metadataSchema.parse({ pullRequests: [{ url, state: 'open' }] }))
let userId: string | null = 'viewer'
let sessionUsers: (string | null)[] = []
let canReadIssue = true
let repoAllowed = true
let pullStatus = 200
let githubPrReads = 0
const issueLookup = mock.fn(async (_user: { id: string }, _issueId: string) => canReadIssue ? { content } : null)
const pullPayload = () => ({
  number: 81, state: 'closed', merged: true, updated_at: '2026-10-27T12:00:00Z',
  title: 'Add issue activity', created_at: '2026-10-26T09:30:00Z', merged_at: '2026-10-27T11:00:00Z',
  base: { repo: { id: 34, full_name: 'private/repo', private: true } },
})
mock.module(new URL('../../../../lib/auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async () => {
  const id = sessionUsers.length ? sessionUsers.shift()! : userId
  return id ? { user: { id }, session: { id: 'pull-request-status-fixture-session' } } : null
} } } } })
mock.module(new URL('../../../../lib/issue-access.ts', import.meta.url).href, { namedExports: { issueForUser: issueLookup } })
mock.module(new URL('../../../../lib/github/app-config.ts', import.meta.url).href, { namedExports: { readGitHubAppConfig: async () => ({ id: '4840908', source: 'database' }) } })
mock.module(new URL('../../../../lib/github/connection.ts', import.meta.url).href, { namedExports: {
  githubConnectionToken: async () => ({ token: 'never-return-this', githubAccountId: '12', expiresAt: null }),
} })
const liveWorkspaceId = '00000000-0000-4000-8000-0000000000aa'
const liveLookup = mock.fn(async (_database: unknown, _workspaceDatabase: unknown, _issueId: string, _viewerId: string) => liveWorkspaceId)
mock.module(new URL('../../../../lib/live/panels.ts', import.meta.url).href, { namedExports: { documentLiveWorkspace: liveLookup } })
mock.module(new URL('../../../../lib/db/index.ts', import.meta.url).href, { namedExports: { pool: {} } })
mock.module(new URL('../../../../lib/workspace-db.ts', import.meta.url).href, { namedExports: { workspacePool: {} } })
let POST: typeof import('./route')['POST']
let githubHttp: Awaited<ReturnType<typeof startGitHubAccessHttp>>
const realFetch = globalThis.fetch
before(async () => {
  githubHttp = await startGitHubAccessHttp({
    installationId: 56,
    getUser: () => ({ id: 12, login: 'viewer' }),
    getRepositories: () => (repoAllowed ? [{ id: 34, full_name: 'private/repo', private: true }] : []),
    onRequest: reqUrl => {
      if (reqUrl.pathname !== '/repos/private/repo/pulls/81') return undefined
      githubPrReads++
      if (pullStatus !== 200) return new Response('private provider payload', { status: pullStatus })
      return Response.json(pullPayload())
    },
  })
  globalThis.fetch = githubHttp.routeFetch(realFetch) as typeof fetch
  ;({ POST } = await import('./route'))
})
after(async () => {
  globalThis.fetch = realFetch
  await githubHttp.close()
})
beforeEach(() => {
  userId = 'viewer'; sessionUsers = []; canReadIssue = true; repoAllowed = true; pullStatus = 200; githubPrReads = 0
  githubHttp.requests.length = 0
  issueLookup.mock.resetCalls()
})
const call = (body: unknown = { issueId, url }, origin: string | null = 'https://preview.example') => POST(new Request('https://preview.example/api/github/pull-request-status', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
}))

test('requires a session and same origin before reading issues or GitHub', async () => {
  userId = null
  assert.equal((await call()).status, 401)
  userId = 'viewer'
  for (const origin of ['https://other.example', null]) assert.equal((await call(undefined, origin)).status, 403)
  assert.equal(issueLookup.mock.callCount(), 0)
  assert.equal(githubHttp.requests.length, 0)
})

test('rejects invalid, arbitrary and unlinked URLs before GitHub access', async () => {
  for (const candidate of ['https://evil.example/repo/pull/81', `${url}?token=x`, 'https://github.com/private/repo/pull/82']) {
    const response = await call({ issueId, url: candidate })
    assert.ok([400, 404].includes(response.status))
  }
  assert.equal((await call({ issueId: 'invalid', url })).status, 400)
  assert.equal(githubHttp.requests.length, 0)
})

test('issue visibility is checked for the current viewer before GitHub', async () => {
  canReadIssue = false
  assert.equal((await call()).status, 404)
  const [reader, requestedIssue] = issueLookup.mock.calls[0].arguments
  assert.equal(reader.id, 'viewer'); assert.equal(requestedIssue, issueId)
  const { enterprisePrincipal } = await import('@/lib/enterprise/principal')
  assert.deepEqual((reader as { id: string; [enterprisePrincipal]?: unknown })[enterprisePrincipal], { kind: 'session', sessionId: 'pull-request-status-fixture-session' })
  assert.equal(githubHttp.requests.length, 0)
})

test('only minimal viewer-authorized state is returned and shared metadata is unchanged', async () => {
  const beforeContent = JSON.stringify(content)
  const response = await call({ issueId, url: `${url}/` })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await response.json(), { viewerId: 'viewer', url, state: 'merged', updatedAt: '2026-10-27T12:00:00Z', title: 'Add issue activity', createdAt: '2026-10-26T09:30:00Z', mergedAt: '2026-10-27T11:00:00Z', live: { workspaceId: liveWorkspaceId } })
  // The channel is the viewer's own for this task (#1212), looked up only after the task and GitHub checks.
  assert.deepEqual(liveLookup.mock.calls.at(-1)!.arguments.slice(2), [issueId, 'viewer'])
  assert.equal(githubPrReads, 1)
  assert.equal(JSON.stringify(content), beforeContent)
})

test('revoked repository access fails closed without stale state', async () => {
  assert.equal((await call()).status, 200)
  repoAllowed = false
  const response = await call()
  assert.equal(response.status, 403)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await response.json(), { error: 'githubRepositoryForbidden' })
})

test('session changes and unexpected provider failures never return state or internal details', async () => {
  sessionUsers = ['viewer', 'other']
  assert.equal((await call()).status, 401)
  pullStatus = 500
  const response = await call()
  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), { error: 'githubUnavailable' })
})

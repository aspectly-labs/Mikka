import assert from 'node:assert/strict'
import test, { before } from 'node:test'
import { basePath } from './base-path-config.mjs'

// Runs with the app's real basePath; fetch is mocked per test — these cover the client's
// reading of the team-skill registry contract, not the route.
process.env.MIKKA_BASE_PATH = basePath
let client: typeof import('./team-skill-client')
before(async () => { client = await import('./team-skill-client') })

const WORKSPACE = '9b2f4c1e-3d5a-4e6f-8a7b-1c2d3e4f5a6b'
const entry = {
  versionId: 'a1b2c3d4-0000-4000-8000-000000000001', skillId: 'a1b2c3d4-0000-4000-8000-000000000002',
  catalogOwnerId: 'u1', name: 'web-research', description: 'searches the web', license: 'MIT',
  source: 'workspace-upload', createdAt: '2026-11-20T00:00:00.000Z',
  artifact: { sha256: 'a'.repeat(64), format: 'team-skill-v1' }, status: 'pending' as const,
}

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = []
  const original = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const result = handler(url, init)
    return new Response(JSON.stringify(result.body), { status: result.status })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('list hits the workspace skills route, adding inspect=1 for admins', async () => {
  const { calls, restore } = fakeFetch(() => ({ status: 200, body: [entry] }))
  try {
    assert.deepEqual(await client.listTeamSkills(WORKSPACE, true), [entry])
    assert.equal(calls[0].url, `${basePath}/api/workspaces/${WORKSPACE}/skills?inspect=1`)
    await client.listTeamSkills(WORKSPACE, false)
    assert.equal(calls[1].url, `${basePath}/api/workspaces/${WORKSPACE}/skills`)
  } finally { restore() }
})

test('review posts the operation bound to the artifact sha256', async () => {
  const { calls, restore } = fakeFetch(() => ({ status: 200, body: { ok: true } }))
  try {
    await client.reviewTeamSkill(WORKSPACE, { versionId: entry.versionId, sha256: entry.artifact.sha256, operation: 'approve' })
    assert.equal(calls[0].init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { versionId: entry.versionId, sha256: entry.artifact.sha256, operation: 'approve' })
  } finally { restore() }
})

test('a refused request surfaces the route error code', async () => {
  const { restore } = fakeFetch(() => ({ status: 404, body: { error: 'notFound' } }))
  try {
    await assert.rejects(client.listTeamSkills(WORKSPACE, true), (failure: unknown) =>
      failure instanceof client.TeamSkillRequestError && failure.code === 'notFound')
  } finally { restore() }
})

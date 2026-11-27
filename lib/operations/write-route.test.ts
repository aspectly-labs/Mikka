import test from 'node:test'
import assert from 'node:assert/strict'
import { GET, POST } from '../../app/api/approved-writes/route'
import { createPersonalWriteRoute, PERSONAL_WRITES_ENABLED } from './write-route'
import { personalWritesEnabled } from './write-feature'
import { overrideDeploymentSwitch } from '../deployment-switches'

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://candidate.invalid/api/approved-writes', { method: 'POST', headers: { cookie: 'synthetic=fixture', origin: 'https://candidate.invalid', ...headers }, body: JSON.stringify(body) })
}
const read = { op: 'view', action: 'send_slack_message', id }

test('public availability reports only the server gate as 200 no-store without runtime services', async () => {
  try {
    for (const enabled of [false, true]) {
      overrideDeploymentSwitch('personalWrites', enabled)
      const response = await GET(new Request('https://candidate.invalid/api/approved-writes'))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.deepEqual(await response.json(), { enabled })
    }
  } finally {
    overrideDeploymentSwitch('personalWrites', undefined)
  }
})

test('the explicit incident switch closes product POST without initializing runtime', async () => {
  assert.equal(PERSONAL_WRITES_ENABLED, true)
  overrideDeploymentSwitch('personalWrites', false)
  let response: Response
  try { response = await POST(request(read)) }
  finally {
    overrideDeploymentSwitch('personalWrites', undefined)
  }
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'approvedWritesDisabled' })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  let loads = 0
  const handler = createPersonalWriteRoute({ enabled: () => false, load: async () => { loads++; throw Error('runtime must not initialize') } })
  assert.equal((await handler(request(read))).status, 503)
  assert.equal(loads, 0)
})

test('production rollout delegates browser authority and receipt reads to the existing HTTP service; decisions are retired', async () => {
  const calls: unknown[] = []
  const handler = createPersonalWriteRoute({ enabled: () => personalWritesEnabled(), load: async () => ({
    auth: { api: { getSession: async ({ query }) => { assert.equal(query.disableCookieCache, true); return { user: { id: 'owner' }, session: { id: 'session' } } } } },
    operations: action => ({
      view: async (actor, actionId) => { calls.push({ action, actor, actionId }); return { id, status: 'running', error: 'operationUncertain' } as never },
    }),
  }) })
  assert.equal((await handler(request(read, { authorization: 'Bearer synthetic' }))).status, 401)
  assert.equal((await handler(request(read, { origin: 'https://other.invalid' }))).status, 403)
  assert.equal((await handler(request({ ...read, ownerId: 'other' }))).status, 400)
  assert.equal(calls.length, 0)
  assert.equal((await (await handler(request(read))).json()).status, 'running')
  assert.deepEqual(calls[0], { action: read.action, actor: { userId: 'owner', sessionId: 'session' }, actionId: id })
  const decided = await handler(request({ op: 'decide', action: read.action, id, approve: true }))
  assert.equal(decided.status, 409); assert.deepEqual(await decided.json(), { error: 'pendingActionUnavailable' })
  assert.equal(calls.length, 1)
})

test('runtime load failure returns an unavailable response without diagnostics', async () => {
  const handler = createPersonalWriteRoute({ enabled: () => true, load: async () => { throw Error('private synthetic configuration diagnostic') } })
  const response = await handler(request(read))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'writeServiceUnavailable' })
})

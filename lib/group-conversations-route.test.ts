import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

let status = 200
let scheduled: string[] = []
mock.module('@/lib/api-auth', { namedExports: {
  apiWorkspaceAllowed: () => true,
  auth: { api: { getSession: async () => ({ user: { id: 'user' }, tokenWorkspaceId: 'ws' }) } },
} })
mock.module('@/lib/db', { namedExports: { db: {}, pool: {} } })
mock.module('@/lib/workspace-db', { namedExports: { workspaceDb: {} } })
mock.module('@/lib/background', { namedExports: {
  afterJob: (label: string) => scheduled.push(label),
  runInBackground: () => {},
} })
mock.module('@/lib/group-conversations-store', { namedExports: {
  handleGroup: async () => ({ status, body: {} }),
} })
mock.module('@/lib/group-conversations-directory', { namedExports: { groupDirectory: () => async () => [] } })
mock.module('@/lib/coordinator/group-turns', { namedExports: { groupsWithPendingTurns: async () => [], processGroupTurn: async () => true } })
mock.module('@/lib/coordinator/group-factory', { namedExports: { groupsWithPendingTaskReports: async () => [], reconcileGroupTaskReports: async () => {} } })
mock.module('@/lib/coordinator/group-runtime', { namedExports: { groupRuntime: {} } })
mock.module('@/lib/coordinator/group-decision-feedback', { namedExports: { handleGroupDecisionQuality: async () => ({ status: 404, body: {} }) } })
mock.module('@/lib/coordinator/group-decision-replay-api', { namedExports: { handleGroupDecisionReplay: async () => ({ status: 404, body: {} }) } })
mock.module('@/lib/abuse/context', { namedExports: { hostedBillingScope: { run: async (_: unknown, task: () => unknown) => task() } } })
const { respondGroup } = await import('./group-conversations-route')

const call = (method: string) => respondGroup(new Request('https://localhost/api/groups/conv/messages', { method }), 'messages', 'conv')

test('#2820: a history read never schedules group work', async () => {
  scheduled = []
  status = 200
  const result = await call('GET')
  assert.equal(result.status, 200)
  assert.deepEqual(scheduled, [])
})

test('#2820: a successful send schedules the drain', async () => {
  scheduled = []
  status = 201
  const result = await call('POST')
  assert.equal(result.status, 201)
  assert.deepEqual(scheduled, ['after:group-turn'])
})

test('#2820: a rejected send schedules nothing', async () => {
  scheduled = []
  status = 403
  const result = await call('POST')
  assert.equal(result.status, 403)
  assert.deepEqual(scheduled, [])
})

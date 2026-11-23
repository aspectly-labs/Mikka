import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { taskMachine } from './ingress/task-machine.mjs'

const grant = { ownerId: 'owner', workspaceId: randomUUID(), taskId: randomUUID(), runId: randomUUID(),
  operationId: randomUUID(), repositoryKey: 'v2/github.com/owner/repo', expiresAt: Date.now() + 300_000 }

const request = path => new Request('http://task-machine.internal' + path, {
  method: 'POST',
  headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
  body: JSON.stringify({ grant }),
})
const open = (machine) => taskMachine(request('/v1/open'), { TASK_MACHINE: machine }, { params: { token: 'fixture-token' } })

test('a full workspace capacity pool rejects admission as retryable capacity, not a generic failure', async () => {
  const response = await open({ async open() { throw new Error('Workspace task machine capacity exhausted') } })
  assert.equal(response.status, 429)
  assert.deepEqual(await response.json(), { error: 'capacity' })
})

test('grant, lease and writer failures keep their distinct refusal codes', async () => {
  for (const [message, status, code] of [
    ['Invalid task machine grant', 400, 'invalid_grant'],
    ['Task machine lease expired', 410, 'lease_expired'],
    ['Task machine already has a writer', 409, 'machine_unavailable'],
    ['provider exploded', 503, 'machine_unavailable'],
  ]) {
    const response = await open({ async open() { throw new Error(message) } })
    assert.deepEqual([response.status, await response.json()], [status, { error: code }], message)
  }
})

test('a valid open passes the grant to the machine and returns its receipt', async () => {
  const seen = []
  const response = await open({ async open(identity) { seen.push(identity); return { state: 'running', instanceId: 'a'.repeat(64) } } })
  assert.equal(response.status, 200)
  assert.deepEqual(seen, [grant])
  assert.equal((await response.json()).state, 'running')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { FactoryTask } from './store'
import { projectFactoryExecution, FACTORY_EXECUTION_VIEW_VERSION } from './execution-view'
import { EXECUTION_ROUTE_VERSION } from './execution-route'

const task: FactoryTask = {
  id: randomUUID(), userId: 'owner', botId: null, issueId: randomUUID(), sourceEventId: randomUUID(),
  route: { issueId: 'x' } as never, stage: 'execute', status: 'running', revision: 3, attemptId: randomUUID(), candidateId: null, reason: 'test', scopeVersion: null,
}

const runId = randomUUID(), attemptId = randomUUID(), deviceId = randomUUID(), agentId = randomUUID(), rootRunId = randomUUID()

const baseRow = {
  attemptId, stage: 'execute', stageStatus: 'running', position: 1,
  attemptCreatedAt: new Date('2026-11-21T00:00:00Z'), attemptFinishedAt: null,
  candidateId: null, boundRunId: runId, recordedRoute: null, evidence: [],
  runId, runStatus: 'running', runCreatedAt: new Date('2026-11-21T00:01:00Z'), runStartedAt: new Date('2026-11-21T00:02:00Z'), runFinishedAt: null,
  agentId, agentName: 'Codex agent', harness: 'codex', model: 'gpt-5.6',
  deviceId, deviceName: 'Build server', deviceKind: 'local',
  candidateSha: null, hasMachine: false, computeSeconds: null,
}

function fakeTx(rows: unknown[], roots: unknown[] = [], publications: unknown[] = []) {
  const calls: string[] = []
  const tx = {
    async query(text: string) {
      calls.push(text)
      if (text.includes('FROM factory_attempts a')) return { rows }
      if (text.includes('WITH RECURSIVE')) return { rows: roots }
      if (text.includes('FROM run_publications')) return { rows: publications }
      throw new Error(`unexpected query: ${text.slice(0, 80)}`)
    },
  }
  return { tx: tx as unknown as PoolClient, calls }
}

test('#3087 envelope: task + attempt + run + route + cost assemble into one shape', async () => {
  const recorded = { version: EXECUTION_ROUTE_VERSION, routeId: 'device.codex', place: 'device', executor: 'local_daemon', harness: 'codex', provider: null, declared: true }
  const row = { ...baseRow, recordedRoute: recorded, candidateSha: 'a'.repeat(40), hasMachine: true, computeSeconds: '120',
    evidence: [{ artifact: 'artifact-1', kind: 'log' }, { artifact: 'artifact-2', kind: 'report' }] }
  const { tx } = fakeTx([row], [{ runId, threadId: rootRunId, depthExceeded: false }], [{ runId, url: 'https://github.com/o/r/pull/7' }])
  const view = await projectFactoryExecution(tx, task)
  assert.equal(view.version, FACTORY_EXECUTION_VIEW_VERSION)
  assert.equal(view.task.id, task.id)
  assert.equal(view.task.stage, 'execute')
  assert.equal(view.executions.length, 1)
  const execution = view.executions[0]
  assert.equal(execution.attemptId, attemptId)
  assert.equal(execution.runId, runId)
  assert.equal(execution.threadId, rootRunId)
  assert.equal(execution.routeSource, 'recorded')
  assert.deepEqual(execution.route, recorded)
  assert.equal(execution.executor, 'local_daemon')
  assert.equal(execution.place, 'device')
  assert.equal(execution.harness, 'codex')
  assert.equal(execution.model, 'gpt-5.6')
  assert.equal(execution.sourceSha, 'a'.repeat(40))
  assert.deepEqual(execution.artifacts, [
    { ref: 'artifact-1', kind: 'log' }, { ref: 'artifact-2', kind: 'report' },
    { ref: 'https://github.com/o/r/pull/7', kind: 'pull_request' },
  ])
  assert.deepEqual(execution.cost, { source: 'thread_machines', computeSeconds: 120 })
  assert.equal(execution.timers.runStartedAt, '2026-11-21T00:02:00.000Z')
})

test('older attempts derive their route from the persisted run when no receipt exists', async () => {
  const { tx } = fakeTx([{ ...baseRow, deviceKind: 'cloud', harness: 'claude_code', hasMachine: true, computeSeconds: 5 }],
    [{ runId, threadId: runId, depthExceeded: false }])
  const [execution] = (await projectFactoryExecution(tx, task)).executions
  assert.equal(execution.routeSource, 'derived')
  assert.equal(execution.route?.routeId, 'cloud.claude_code')
  assert.equal(execution.route?.declared, true)
  assert.equal(execution.executor, 'cf_task_machine')
})

test('unmatched persisted combinations surface as an explicit null route, never a guess', async () => {
  const { tx } = fakeTx([{ ...baseRow, deviceKind: 'cloud', harness: 'mock' }], [{ runId, threadId: runId, depthExceeded: false }])
  const [execution] = (await projectFactoryExecution(tx, task)).executions
  assert.equal(execution.route, null)
  assert.equal(execution.routeSource, null)
  assert.equal(execution.executor, null)
  assert.equal(execution.place, null)
  // The persisted harness is still reported as data — it is not rewritten.
  assert.equal(execution.harness, 'mock')
})

test('an unbound or other-owner run is hidden and cost is marked unavailable', async () => {
  const { tx } = fakeTx([
    { ...baseRow, runId: null },                       // bound run failed the owner join
    { ...baseRow, attemptId: randomUUID(), position: 2, boundRunId: null, runId: null, hasMachine: false },
  ])
  const view = await projectFactoryExecution(tx, task)
  assert.equal(view.executions[0].runId, null)
  assert.equal(view.executions[0].runUnavailable, true)
  assert.equal(view.executions[0].device, null)
  assert.equal(view.executions[0].agent, null)
  assert.equal(view.executions[1].runId, null)
  assert.equal(view.executions[1].runUnavailable, false)
  assert.equal(view.executions[1].threadId, null)
  assert.deepEqual(view.executions[1].cost, { source: 'unavailable', computeSeconds: null })
})

test('depth-exceeded chains mark threadId unavailable instead of guessing a root', async () => {
  const { tx } = fakeTx([baseRow], [{ runId, threadId: rootRunId, depthExceeded: true }])
  const [execution] = (await projectFactoryExecution(tx, task)).executions
  assert.equal(execution.threadId, null)
  assert.equal(execution.runId, runId)
})

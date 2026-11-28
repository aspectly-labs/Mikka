import assert from 'node:assert/strict'
import test from 'node:test'
import type { ActiveAgent } from './active-agents'
import { activeToWorkers, revisionChanged, workersKey, workingAvatars, workingLabel, workingPollMs, WORKING_POLL_MS } from './working-status'

const agent = (over: Partial<ActiveAgent> = {}): ActiveAgent => ({
  id: 'a1', kind: 'agent', name: 'Agent', avatarUrl: null, startedAt: '2026-01-01T00:00:00Z', state: 'working', runId: 'r1', issueId: null, ...over,
})

test('workingLabel picks the key and params by count', () => {
  assert.equal(workingLabel([]), null)
  assert.deepEqual(workingLabel(['A']), { key: 'one', values: { a: 'A' } })
  assert.deepEqual(workingLabel(['A', 'B']), { key: 'two', values: { a: 'A', b: 'B' } })
  assert.deepEqual(workingLabel(['A', 'B', 'C']), { key: 'three', values: { a: 'A', b: 'B', c: 'C' } })
  assert.deepEqual(workingLabel(['A', 'B', 'C', 'D']), { key: 'many', values: { a: 'A', b: 'B', count: 2 } })
  assert.deepEqual(workingLabel(['A', 'B', 'C', 'D', 'E', 'F']), { key: 'many', values: { a: 'A', b: 'B', count: 4 } })
})

test('workingAvatars caps at three and counts the rest', () => {
  assert.deepEqual(workingAvatars([1, 2]), { shown: [1, 2], overflow: 0 })
  assert.deepEqual(workingAvatars([1, 2, 3]), { shown: [1, 2, 3], overflow: 0 })
  assert.deepEqual(workingAvatars([1, 2, 3, 4, 5]), { shown: [1, 2, 3], overflow: 2 })
})

test('activeToWorkers keeps only working entries with their avatar traits', () => {
  assert.deepEqual(activeToWorkers(undefined), [])
  const workers = activeToWorkers([
    agent({ id: 'a1' }),
    agent({ id: 'a2', state: 'waiting_input' }),
    { id: 'b1', kind: 'bot', name: 'Ghost', avatarUrl: null, startedAt: '2026-01-01T00:00:01Z', state: 'working', runId: null, issueId: null, color: 'vert', shape: 'nuage' },
    { id: 'c1', kind: 'coordinator', name: 'Coordinator', avatarUrl: null, startedAt: '2026-01-01T00:00:02Z', state: 'working', runId: null, issueId: null },
  ])
  assert.deepEqual(workers, [
    { id: 'a1', kind: 'agent', name: 'Agent', color: undefined, shape: undefined },
    { id: 'b1', kind: 'bot', name: 'Ghost', color: 'vert', shape: 'nuage' },
    { id: 'c1', kind: 'coordinator', name: 'Coordinator', color: undefined, shape: undefined },
  ])
})

test('workersKey is order sensitive and stable', () => {
  assert.equal(workersKey([{ id: 'a', kind: 'agent', name: 'A' }, { id: 'b', kind: 'bot', name: 'B' }]), 'a|b')
  assert.equal(workersKey([]), '')
})

test('workingPollMs polls only while someone is working, zero otherwise', () => {
  assert.equal(workingPollMs(undefined), 0)
  assert.equal(workingPollMs({ agents: [] }), 0)
  assert.equal(workingPollMs({ agents: [agent({ state: 'waiting_input' })] }), WORKING_POLL_MS)
  assert.equal(workingPollMs({ agents: [agent(), agent()] }), WORKING_POLL_MS)
})

test('revisionChanged refetches on first sighting and later revisions', () => {
  assert.equal(revisionChanged(undefined, 5), true) // a bot may have started between the mount read and the first revision
  assert.equal(revisionChanged(5, 5), false)
  assert.equal(revisionChanged(5, 6), true)
  assert.equal(revisionChanged(5, undefined), false)
})

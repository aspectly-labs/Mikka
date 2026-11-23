import assert from 'node:assert/strict'
import test from 'node:test'
import { agentStateOf, BLOCKED_COLUMN, BOARD_COLUMNS, boardBlocks, boardColumnOf, cardStateKind, type BoardTask } from './kanban-board-data'

const open = { status: 'todo', metadata: { pullRequests: [] } }

test('a card shows its newest run group, not its raw status', () => {
  assert.equal(agentStateOf({ status: 'failed', outcome: 'idle' }, open), null)
  assert.equal(agentStateOf({ status: 'succeeded', outcome: 'needs_input' }, open), 'waiting')
  assert.equal(agentStateOf({ status: 'succeeded', outcome: 'blocked' }, open), 'blocked')
  assert.equal(agentStateOf({ status: 'succeeded', outcome: 'done' }, open), null)
  assert.equal(agentStateOf({ status: 'running', outcome: null }, open), 'running')
  assert.equal(agentStateOf({ status: 'waiting_input', outcome: null }, open), 'waiting')
})

test('a done task settles a failed run; no run shows nothing', () => {
  assert.equal(agentStateOf({ status: 'failed', outcome: 'failed' }, { status: 'done', metadata: { pullRequests: [] } }), null)
  assert.equal(agentStateOf(undefined, open), null)
})

test('cardStateKind maps canonical and idle task states cleanly', () => {
  assert.equal(cardStateKind('running'), 'running')
  assert.equal(cardStateKind('queued'), 'running')
  assert.equal(cardStateKind('waiting'), 'waiting')
  assert.equal(cardStateKind('blocked'), 'waiting')
  assert.equal(cardStateKind('failed'), 'blocked')
  assert.equal(cardStateKind('canceled'), null)
  assert.equal(cardStateKind('done'), null)
  assert.equal(cardStateKind('todo'), null)
  assert.equal(cardStateKind('idle'), null)
})

test('boardColumnOf and boardBlocks resolve blocked state and blocker identifiers', () => {
  assert.ok(BOARD_COLUMNS.some(column => column.value === BLOCKED_COLUMN))
  assert.equal(boardColumnOf('todo', false), 'todo')
  assert.equal(boardColumnOf('todo', true), BLOCKED_COLUMN)
  assert.equal(boardColumnOf('unknown', false), null)

  const blocker = { id: 'b1', identifier: 'MIK-1', status: 'doing', metadata: { pullRequests: [], blockedByIds: [] } } as unknown as BoardTask
  const blocked = { id: 'b2', identifier: 'MIK-2', status: 'todo', metadata: { pullRequests: [], blockedByIds: ['b1'] } } as unknown as BoardTask
  const blocks = boardBlocks([blocker, blocked], [])
  assert.equal(blocks.get('b2')?.blockerIdentifier, 'MIK-1')
})

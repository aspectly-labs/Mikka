import assert from 'node:assert/strict'
import test from 'node:test'
import { subagentCardOf, subagentCounts, subagentMarkState, subagentStatusOf } from './subagent-card'
import { resolveProfileMark } from './factory/agent-profile-mark'

test('a run reads as one of the five card labels, the same mapping its ProfileMark draws', () => {
  const cases: [Parameters<typeof subagentStatusOf>[0], string, string][] = [
    [{ status: 'queued' }, 'queued', 'idle'], [{ status: 'preparing' }, 'queued', 'idle'],
    [{ status: 'running' }, 'working', 'working'], [{ status: 'finishing' }, 'working', 'working'],
    [{ status: 'waiting_input' }, 'needs-you', 'needs-you'], [{ status: 'paused' }, 'needs-you', 'needs-you'],
    [{ status: 'stopped', stopReason: 'asked_human' }, 'needs-you', 'needs-you'], [{ status: 'succeeded', outcome: 'needs_input' }, 'needs-you', 'needs-you'],
    [{ status: 'failed' }, 'failed', 'failed'], [{ status: 'succeeded', outcome: 'blocked' }, 'failed', 'failed'],
    [{ status: 'succeeded', outcome: 'done' }, 'done', 'idle'], [{ status: 'cancelled' }, 'done', 'idle'],
  ]
  for (const [run, label, mark] of cases) {
    assert.equal(subagentStatusOf(run), label, JSON.stringify(run))
    assert.equal(subagentMarkState(subagentStatusOf(run)), mark, JSON.stringify(run))
  }
})

test('a card is named for its Profile, else for its Agent with the derived mark; nothing is invented', () => {
  assert.deepEqual(subagentCardOf({ id: 'a', harness: 'claude_code', status: 'running',
    subagent: { profile: { name: 'Reviewer', icon: 'lines', color: 'pink' }, model: 'anthropic/claude-opus-5-5', brief: ' 审一遍 Coder 的改动 ' } }),
  { id: 'a', name: 'Reviewer', profile: { icon: 'lines', color: 'pink' }, model: 'Opus 5.5', status: 'working', brief: '审一遍 Coder 的改动' })
  assert.deepEqual(subagentCardOf({ id: 'b', harness: 'codex', status: 'queued' }),
    { id: 'b', name: 'Codex', profile: resolveProfileMark({ name: 'Codex' }), model: null, status: 'queued', brief: null })
})

test('the block counts its cards in label order and leaves out labels with none', () => {
  assert.deepEqual(subagentCounts([{ status: 'failed' }, { status: 'working' }, { status: 'queued' }, { status: 'working' }]),
    [{ status: 'working', count: 2 }, { status: 'failed', count: 1 }, { status: 'queued', count: 1 }])
})

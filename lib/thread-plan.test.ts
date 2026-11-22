import test from 'node:test'
import assert from 'node:assert/strict'
import { chainChunks } from './issue-run-conversation'
import { runPlan, threadPlan } from './thread-plan'

const at = '2026-11-22T10:00:00Z'
const row = (chunk: Record<string, unknown>) => ({ chunk, at })
const call = (toolCallId: string, toolName: string, input: unknown) => row({ type: 'tool-input-available', toolCallId, toolName, input })
const todos = (...items: [string, string][]) => ({ todos: items.map(([content, status]) => ({ content, status, activeForm: `${content}…` })) })
const steps = (...items: [string, string][]) => ({ plan: items.map(([step, status]) => ({ step, status })) })
const view = (plan: ReturnType<typeof threadPlan>) => plan?.map(item => [item.text, item.status])

test("Claude Code's TodoWrite becomes the plan, each item with its state", () => {
  const plan = threadPlan([call('toolu_1', 'TodoWrite', todos(['Read the brief', 'completed'], ['Write the parser', 'in_progress'], ['Add tests', 'pending']))])
  assert.deepEqual(view(plan), [['Read the brief', 'completed'], ['Write the parser', 'in_progress'], ['Add tests', 'pending']])
})

test("Codex's update_plan becomes the plan, its camel-case state included", () => {
  const plan = threadPlan([call('plan-turn-1-1', 'update_plan', { explanation: 'Start small', ...steps(['Inspect', 'completed'], ['Patch', 'inProgress'], ['Verify', 'in_progress'], ['Ship', 'pending']) })])
  assert.deepEqual(view(plan), [['Inspect', 'completed'], ['Patch', 'in_progress'], ['Verify', 'in_progress'], ['Ship', 'pending']])
})

test('a revision replaces the plan: the newest call wins, other tools in between leave it alone', () => {
  const plan = threadPlan([
    call('a', 'TodoWrite', todos(['Read', 'in_progress'], ['Write', 'pending'])),
    call('b', 'Bash', { command: 'pnpm test' }),
    row({ type: 'tool-output-available', toolCallId: 'b', output: 'ok' }),
    call('c', 'TodoWrite', todos(['Read', 'completed'], ['Write', 'in_progress'], ['Review', 'pending'])),
    row({ type: 'text-delta', id: 't', delta: 'Writing now.' }),
  ])
  assert.deepEqual(view(plan), [['Read', 'completed'], ['Write', 'in_progress'], ['Review', 'pending']])
})

test('an item keeps its id while only its state changes, so the list updates in place', () => {
  const before = threadPlan([call('a', 'update_plan', steps(['Inspect', 'in_progress'], ['Patch', 'pending']))])
  const after = threadPlan([call('a', 'update_plan', steps(['Inspect', 'in_progress'], ['Patch', 'pending'])), call('b', 'update_plan', steps(['Inspect', 'completed'], ['Patch', 'in_progress']))])
  assert.deepEqual(after?.map(item => item.id), before?.map(item => item.id))
})

test('an emptied plan clears it; no plan call or a malformed one is no plan', () => {
  assert.equal(threadPlan([call('a', 'TodoWrite', todos(['Read', 'pending'])), call('b', 'TodoWrite', { todos: [] })]), null)
  assert.equal(threadPlan([call('a', 'Read', { file_path: 'a.ts' })]), null)
  assert.equal(threadPlan([call('a', 'TodoWrite', { todos: 'nope' })]), null)
  // A malformed revision does not wipe the plan the agent last wrote.
  assert.deepEqual(view(threadPlan([call('a', 'TodoWrite', todos(['Read', 'pending'])), call('b', 'TodoWrite', { nope: true })])), [['Read', 'pending']])
})

test('items without words are left out; an unknown state reads as pending; words are one trimmed line', () => {
  const plan = threadPlan([call('a', 'TodoWrite', { todos: [
    { content: '  Read\n the   brief ', status: 'completed' }, { content: '   ', status: 'pending' }, { content: 'Ship', status: 'blocked' }, { status: 'pending' }, 'x',
  ] })])
  assert.deepEqual(view(plan), [['Read the brief', 'completed'], ['Ship', 'pending']])
})

test('across runs, only the asked run counts: a new run without a plan has none', () => {
  const rows = [
    { runId: 'r1', ...call('a', 'TodoWrite', todos(['Old step', 'in_progress'])) },
    { runId: 'r2', ...call('b', 'Bash', { command: 'ls' }) },
  ]
  const chunks = chainChunks(rows)
  assert.deepEqual(view(threadPlan(chunks, 'r1')), [['Old step', 'in_progress']])
  assert.equal(threadPlan(chunks, 'r2'), null)
  const later = chainChunks([...rows, { runId: 'r2', ...call('c', 'update_plan', steps(['New step', 'pending'])) }])
  assert.deepEqual(view(threadPlan(later, 'r2')), [['New step', 'pending']])
})

test('a very long plan or item is cut to what the pinned list can hold', () => {
  const plan = threadPlan([call('a', 'TodoWrite', todos(...Array.from({ length: 80 }, (_, i): [string, string] => [`${'x'.repeat(300)}${i}`, 'pending'])))])
  assert.equal(plan?.length, 50)
  assert.ok(plan!.every(item => item.text.length <= 200 && item.text.endsWith('…')))
})

test("a read's plan is its run's: one run's chunks only when they are that run's, else that run's calls", () => {
  const one = [call('a', 'TodoWrite', todos(['Read', 'in_progress']))]
  assert.deepEqual(view(runPlan({ chunks: one, chunkCursor: { runs: 1, runId: 'r1' } }, 'r1')), [['Read', 'in_progress']])
  // A follow-up run that has written nothing yet does not show the run before it.
  assert.equal(runPlan({ chunks: one, chunkCursor: { runs: 1, runId: 'r1' } }, 'r2'), null)
  assert.equal(runPlan({ chunks: [], chunkCursor: null }, 'r1'), null)
  const both = chainChunks([{ runId: 'r1', ...one[0] }, { runId: 'r2', ...call('b', 'update_plan', steps(['Next', 'pending'])) }])
  assert.deepEqual(view(runPlan({ chunks: both, chunkCursor: { runs: 2, runId: 'r2' } }, 'r2')), [['Next', 'pending']])
  assert.deepEqual(view(runPlan({ chunks: both, historyPage: { chain: 'r1,r2' } }, 'r1')), [['Read', 'in_progress']])
  assert.deepEqual(view(runPlan({ chunks: one, historyPage: { chain: 'r1' } }, 'r1')), [['Read', 'in_progress']])
  assert.equal(runPlan({ chunks: one, historyPage: { chain: 'r1' } }, 'r2'), null)
})

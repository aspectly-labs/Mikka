import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EveMessage } from 'eve/client'
import { chainChunks, conversationItems, threadItems, threadPeople, type ThreadPersonMessage } from '../issue-run-conversation'
import { coordinatorAgentReplies } from '../eve/chat-view'
import { createChunkFolder, foldChunks, type ChunkRow } from './fold'
import { eveTurnMessageId, runScoped, splitRunScoped, storedChatMessageId } from './ids'
import { interleave } from './interleave'
import type { ConversationMessage } from './model'
import { projectEntries } from './project'
import { mergeConversation, resetConversation } from './store'

const RUN_A = '11111111-1111-4111-8111-111111111111'
const RUN_B = '22222222-2222-4222-8222-222222222222'
const at = (s: number) => new Date(Date.UTC(2026, 10, 22, 9, 0, s))

/** Stored rows as run_chunks holds them: ids the daemon gave, unscoped. */
const runA = [
  { runId: RUN_A, seq: 0, chunk: { type: 'data-run-stage', data: { stage: 'worktree', ms: 400, ok: true } }, at: at(0) },
  { runId: RUN_A, seq: 1, chunk: { type: 'text-start', id: 't1' }, at: at(1) },
  { runId: RUN_A, seq: 2, chunk: { type: 'text-delta', id: 't1', delta: 'Reading ' }, at: at(1) },
  { runId: RUN_A, seq: 3, chunk: { type: 'text-delta', id: 't1', delta: 'the page.' }, at: at(2) },
  { runId: RUN_A, seq: 4, chunk: { type: 'text-end', id: 't1' }, at: at(2) },
  { runId: RUN_A, seq: 5, chunk: { type: 'tool-input-available', toolCallId: 'c1', toolName: 'Read', input: { file_path: 'a.ts' } }, at: at(3) },
  { runId: RUN_A, seq: 6, chunk: { type: 'tool-output-available', toolCallId: 'c1', output: 'export {}', toolDurationMs: 12 }, at: at(4) },
  // An older daemon: a delta with no start.
  { runId: RUN_A, seq: 7, chunk: { type: 'text-delta', id: 't2', delta: 'Done.' }, at: at(8) },
]
const runB = [
  { runId: RUN_B, seq: 0, chunk: { type: 'text-delta', id: 't1', delta: 'Again.' }, at: at(20) },
  { runId: RUN_B, seq: 1, chunk: { type: 'tool-input-available', toolCallId: 'c1', toolName: 'Bash', input: { command: 'pnpm test' } }, at: at(21) },
  { runId: RUN_B, seq: 2, chunk: { type: 'error', errorText: 'The agent stopped responding.' }, at: at(22) },
]
const people: ThreadPersonMessage[] = [
  { id: 'row-1', submissionId: 'sent-1', text: 'Also check b.ts', author: 'Alex', mine: true, at: at(5) },
  { id: 'row-2', text: 'Go on.', author: 'Alex', mine: true, at: at(20) },
]

test('every chunk id is scoped to its run from the first run on, and scoping a scoped id changes nothing', () => {
  const once = chainChunks(runA)
  assert.deepEqual(once.map(row => row.chunk.id ?? row.chunk.toolCallId), [`${RUN_A}:#0`, `${RUN_A}:t1`, `${RUN_A}:t1`, `${RUN_A}:t1`, `${RUN_A}:t1`, `${RUN_A}:c1`, `${RUN_A}:c1`, `${RUN_A}:t2`])
  const twice = chainChunks(once.map((row, index) => ({ ...row, runId: RUN_A, seq: index })))
  assert.deepEqual(twice.map(row => row.chunk), once.map(row => row.chunk))
  assert.equal(runScoped(RUN_A, `${RUN_A}:x`), `${RUN_A}:x`)
  assert.deepEqual(splitRunScoped(`${RUN_A}:t1`), { runId: RUN_A, local: 't1' })
})

test('the server\'s fold and the client\'s live fold are the same fold: identical messages and items', async () => {
  const rows = chainChunks([...runA, ...runB])
  const server = await foldChunks(rows)
  // The client folds what it holds, then the appended chunks, reusing the runs that did not grow.
  const fold = createChunkFolder()
  const prefix = rows.slice(0, 5)
  await fold(prefix)
  const client = await fold(rows)
  assert.deepEqual(client, server)
  assert.deepEqual(conversationItems(interleave(client, threadPeople(people)), RUN_A), await threadItems(rows, people, RUN_A))
  // The SDK did the folding: one assistant message per run, its tool part complete, the open delta repaired.
  assert.deepEqual(server.map(message => message.id), [`run:${RUN_A}`, `run:${RUN_B}`])
  const parts = server[0].parts.map(part => part.type === 'text' ? `text:${part.text}` : part.type === 'dynamic-tool' ? `tool:${part.toolName}:${part.state}` : part.type)
  assert.deepEqual(parts, ['data-run-stage', 'text:Reading the page.', 'tool:Read:output-available', 'text:Done.'])
  assert.deepEqual(server[0].metadata?.parts?.[2], { key: `tool:${RUN_A}:c1`, at: at(3).getTime(), durationMs: 12 })
})

test('ids stay put when the thread runs a second time: the first run\'s items keep theirs', async () => {
  const first = await threadItems(chainChunks(runA), [], RUN_A)
  const both = await threadItems(chainChunks([...runA, ...runB]), [], RUN_A)
  assert.deepEqual(both.slice(0, first.length).map(item => item.id), first.map(item => item.id))
  assert.deepEqual(first.map(item => item.id), [`stages:${RUN_A}:#0`, `text:${RUN_A}:t1`, `steps:${RUN_A}:c1`, `text:${RUN_A}:t2`])
  // The second run's own ids never collide with the first's (both runs number their text t1 and their call c1).
  assert.equal(new Set(both.map(item => item.id)).size, both.length)
})

test('people\'s messages sit before the first Agent part stored after them; a tie goes to the Agent; the Agent is never re-sorted', async () => {
  const rows = chainChunks([...runA, ...runB])
  const items = await threadItems(rows, people, RUN_A)
  assert.deepEqual(items.map(item => item.kind === 'person' ? `person:${item.text}` : item.kind === 'agent' ? `agent:${item.text}` : item.kind),
    ['stages', 'agent:Reading the page.', 'steps', 'person:Also check b.ts', 'agent:Done.', 'agent:Again.', 'person:Go on.', 'steps', 'error'])
  // The person's message is keyed by the id the client minted when it sent it.
  assert.equal(items.find(item => item.kind === 'person')?.id, 'sent-1')
  // A late batch (an earlier time stored after later chunks) keeps the daemon's order.
  const late = chainChunks([...runA.slice(0, 5), { ...runA[7], at: at(1) }])
  assert.deepEqual((await threadItems(late, [])).map(item => item.kind === 'agent' ? item.text : item.kind), ['stages', 'Reading the page.', 'Done.'])
})

test('a stretch of Agent output between two people\'s messages keeps its id as later chunks and messages arrive', () => {
  const run = (parts: number): ConversationMessage => ({ id: `run:${RUN_A}`, role: 'assistant',
    parts: Array.from({ length: parts }, (_, index) => ({ type: 'text' as const, text: `p${index}` })),
    metadata: { at: 0, parts: Array.from({ length: parts }, (_, index) => ({ key: `text:${RUN_A}:p${index}`, at: index * 10 })) } })
  const before = interleave([run(2)], [])
  const after = interleave([run(4)], [{ id: 'late', text: 'hi', at: 15 }])
  assert.deepEqual(before.map(message => message.id), [`text:${RUN_A}:p0`])
  assert.deepEqual(after.map(message => message.id), [`text:${RUN_A}:p0`, 'late', `text:${RUN_A}:p2`])
})

test('one store per conversation: an optimistic message, its streaming reply and both stored keep one id and one order', () => {
  resetConversation()
  const key = 'bot:fixture'
  const person = (delivery?: 'sending' | 'sent'): ConversationMessage => ({ id: 'sub-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }], metadata: { at: 1000, ...(delivery ? { delivery } : {}) } })
  const reply = (text: string, streaming: boolean): ConversationMessage => ({ id: eveTurnMessageId('wrun', 'turn-1'), role: 'assistant', parts: [{ type: 'text', text }], metadata: { at: 0, streaming } })
  const welcome: ConversationMessage = { id: '1', role: 'assistant', parts: [{ type: 'text', text: 'Welcome' }], metadata: { at: 0 } }
  const ids = (messages: ConversationMessage[]) => messages.map(message => message.id)
  const optimistic = mergeConversation(key, { stored: [welcome], optimistic: [person('sending')] }, 1000)
  const streaming = mergeConversation(key, { stored: [welcome], optimistic: [person('sent')], live: [reply('Hel', true)] }, 1200)
  const committed = mergeConversation(key, { stored: [welcome, { ...person(), id: storedChatMessageId({ from: 'person', position: 2, submissionId: 'sub-1' }) },
    { ...reply('Hello', false), id: storedChatMessageId({ from: 'coordinator', position: 3, streamId: 'eve:wrun:turn-1' }) }] }, 1500)
  assert.deepEqual(ids(optimistic), ['1', 'sub-1'])
  assert.deepEqual(ids(streaming), ['1', 'sub-1', 'eve:wrun:turn-1'])
  assert.deepEqual(ids(committed), ['1', 'sub-1', 'eve:wrun:turn-1'])
  // The order is the conversation's, not the component's: merged again later (a remount), nothing moves.
  assert.deepEqual(ids(mergeConversation(key, { stored: [welcome], optimistic: [person('sent')], live: [reply('Hello', true)] }, 9000)), ids(streaming))
})

test('eve splits a turn around a message the person wrote mid-turn: the parts are `eve:<session>:<turn>` and `…:1`', () => {
  const messages: EveMessage[] = [
    { id: 'a', role: 'assistant', metadata: { status: 'complete', turnId: 'turn-1' }, parts: [{ type: 'text', text: 'Before.' }] },
    { id: 'p', role: 'user', metadata: { status: 'complete' }, parts: [{ type: 'text', text: 'Also the footer' }] },
    { id: 'b', role: 'assistant', metadata: { status: 'streaming', turnId: 'turn-1' }, parts: [{ type: 'text', text: 'After.' }] },
    { id: 'c', role: 'assistant', metadata: { status: 'streaming', turnId: 'turn-2' }, parts: [{ type: 'text', text: 'Next.' }] },
  ]
  assert.deepEqual(coordinatorAgentReplies(messages, [], 'wrun').map(reply => reply.key), ['eve:wrun:turn-1', 'eve:wrun:turn-1:1', 'eve:wrun:turn-2'])
  // Once the turn is stored, all of its segments leave the live list together.
  assert.deepEqual(coordinatorAgentReplies(messages, ['eve:wrun:turn-1'], 'wrun').map(reply => reply.key), ['eve:wrun:turn-2'])
  // Without a session the reply keeps eve's own id.
  assert.deepEqual(coordinatorAgentReplies(messages.slice(3)).map(reply => reply.key), ['c'])
})

test('one error surface: a run\'s failure is its reply\'s error part, last, and nowhere else', async () => {
  const conversation = interleave(await foldChunks(chainChunks(runB)), [])
  const entries = projectEntries(conversation, { text: text => ({ kind: 'text', text, node: null }), tools: (id, parts) => ({ kind: 'tools', id, tools: parts.map(() => ({ id, label: 'tool', status: 'done' as const })) }) })
  assert.equal(entries.length, 1)
  const [reply] = entries
  assert.ok(reply.role === 'bot')
  assert.deepEqual(reply.parts.map(part => part.kind), ['text', 'tools', 'error'])
  assert.deepEqual(reply.parts.at(-1), { kind: 'error', text: 'The agent stopped responding.' })
  assert.equal(reply.id, `text:${RUN_B}:t1`)
})

test('the fold stays fast on a long thread: every run folds once, and a live append refolds only the run that grew', async () => {
  const run = (runId: string, from: number): (ChunkRow & { runId: string; at: Date })[] => Array.from({ length: 400 }, (_, index) => [
    { runId, seq: index * 3, chunk: { type: 'tool-input-available', toolCallId: `c${index}`, toolName: 'Read', input: { file_path: `f${index}.ts`, padding: 'x'.repeat(2000) } }, at: at(from + index) },
    { runId, seq: index * 3 + 1, chunk: { type: 'tool-output-available', toolCallId: `c${index}`, output: 'y'.repeat(4000) }, at: at(from + index) },
    { runId, seq: index * 3 + 2, chunk: { type: 'text-delta', id: `t${index}`, delta: 'Next.' }, at: at(from + index) },
  ]).flat()
  const rows = chainChunks([...run(RUN_A, 0), ...run(RUN_B, 1000)])
  const fold = createChunkFolder()
  let started = performance.now()
  const first = await fold(rows)
  const full = performance.now() - started
  assert.equal(first[0].parts.length, 800)
  started = performance.now()
  await fold([...rows, ...chainChunks([{ runId: RUN_B, seq: 9999, chunk: { type: 'text-delta', id: 'late', delta: 'More.' }, at: at(5000) }])])
  const append = performance.now() - started
  assert.ok(full < 4000, `a 2,400-chunk thread folds in ${Math.round(full)} ms`)
  assert.ok(append < full, `an append refolds one run (${Math.round(append)} ms of ${Math.round(full)} ms)`)
})

test('a live fold that reuses earlier blocks still equals a fresh fold when a late result lands in one of them', async () => {
  const calls = Array.from({ length: 120 }, (_, index) => ({ runId: RUN_A, seq: index, chunk: { type: 'tool-input-available', toolCallId: `c${index}`, toolName: 'Read', input: { file_path: `f${index}.ts` } }, at: at(index) }))
  const results = [0, 60, 119].map((index, n) => ({ runId: RUN_A, seq: 200 + n, chunk: { type: 'tool-output-available', toolCallId: `c${index}`, output: { text: `out ${index}` } }, at: at(300 + n) }))
  const fold = createChunkFolder()
  await fold(chainChunks(calls))
  await fold(chainChunks([...calls, results[2]]))
  const live = await fold(chainChunks([...calls, ...results]))
  assert.deepEqual(live, await foldChunks(chainChunks([...calls, ...results])))
  const parts = live[0].parts as { state?: string; output?: unknown }[]
  assert.deepEqual([parts[0].output, parts[60].output, parts[119].output, parts[1].state], [{ text: 'out 0' }, { text: 'out 60' }, { text: 'out 119' }, 'input-available'])
})

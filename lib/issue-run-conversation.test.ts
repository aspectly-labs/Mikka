import test from 'node:test'
import assert from 'node:assert/strict'
import { activityLineBadgeShown, chainChunks, headerStopShown, runFailureText, runIsActive, runIsWorking, runStopTimeoutRemaining, runSummaryText, runSummaryView, threadItems, threadStepOutput } from './issue-run-conversation'
import { createSecretMasker, withCredentialMasking } from './secrets/mask'
import { maskStreamedChunks } from './secrets/stream-mask'

async function resultStep(output: unknown, toolDurationMs?: unknown) {
  const [item] = await threadItems([
    { chunk: { type: 'tool-input-available', toolCallId: 'cmd', toolName: 'bash', input: { command: 'pnpm test' } }, at: '2026-11-08T00:00:00Z' },
    { chunk: { type: 'tool-output-available', toolCallId: 'cmd', output, ...(toolDurationMs === undefined ? {} : { toolDurationMs }) }, at: '2026-11-08T00:00:00Z' },
  ], [])
  assert.ok(item.kind === 'steps')
  return item.steps[0]
}

test('successful commands expose output and the measured duration, independent of batch insert time', async () => {
  assert.deepEqual(await resultStep('3 tests passed\n', 1250), {
    id: 'cmd', name: 'bash', detail: 'pnpm test', command: 'pnpm test', failed: false, output: '3 tests passed\n', ms: 1250, kind: 'shell', status: 'ok',
  })
  const succeeded = await resultStep({ exitCode: 0, output: 'ok\n' }, 0)
  assert.equal(succeeded.exitCode, 0)
  assert.equal(succeeded.output, '{\n  "exitCode": 0,\n  "output": "ok\\n"\n}')
  assert.equal(threadStepOutput(succeeded), 'ok\n')
  const failed = await resultStep({ exitCode: 2, output: 'failure output' })
  assert.equal(failed.failed, true)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.exitCode, 2)
  assert.equal(threadStepOutput(failed), 'failure output')
  assert.equal(threadStepOutput(await resultStep('plain output\n')), 'plain output\n')
  const printedJson = '{"exitCode":3,"output":"printed as JSON"}'
  assert.equal(threadStepOutput(await resultStep(printedJson)), printedJson)
  const unknownExit = await resultStep({ exitCode: null, output: '' })
  assert.equal(unknownExit.exitCode, null)
  assert.equal(threadStepOutput(unknownExit), '')
  assert.equal((await resultStep('', 0)).ms, 0)
  for (const value of [undefined, null, -1, NaN, Infinity, '1250']) assert.ok(!('ms' in await resultStep('ok', value)))
  for (const value of [undefined, null]) assert.ok(!('output' in await resultStep(value)))
})

test('long output retains both ends and marks truncation', async () => {
  const output = (await resultStep(`HEAD\n${'x'.repeat(20_000)}\nTAIL`)).output!
  assert.ok(output.startsWith('HEAD\n'))
  assert.ok(output.endsWith('\nTAIL'))
  assert.match(output, /\[output truncated\]/)
  assert.ok(output.length < 8300)
  assert.equal((await resultStep(`HEAD\n${'x'.repeat(20_000)}\nTAIL`)).outputTruncated, true)
  assert.ok(!('outputTruncated' in await resultStep('short')))
})

test('failed calls still mark failure without exposing error text, and unmatched results add no steps', async () => {
  const at = new Date(0)
  const [item] = await threadItems([
    { chunk: { type: 'tool-output-available', toolCallId: 'orphan', output: 'ignored', toolDurationMs: 7 }, at },
    { chunk: { type: 'tool-input-available', toolCallId: 'failed', toolName: 'bash' }, at },
    { chunk: { type: 'tool-output-error', toolCallId: 'failed', errorText: 'private failure details', toolDurationMs: 42 }, at },
  ], [])
  assert.ok(item.kind === 'steps')
  assert.equal(item.count, 1)
  assert.deepEqual(item.steps, [{ id: 'failed', name: 'bash', detail: null, failed: true, ms: 42, kind: 'shell', status: 'failed' }])
})

test('output uses persisted workspace masking and masks credentials again before truncation', async () => {
  const secret = 'sk_live_workspace_test_secret'
  const token = `ghp_${'T'.repeat(40)}`
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature'
  const masked = maskStreamedChunks([
    { type: 'tool-input-available', toolCallId: '1', toolName: 'bash' },
    { type: 'tool-output-available', toolCallId: '1', output: { [secret]: [`key=${secret}`, Buffer.from(secret).toString('base64')] } },
  ], withCredentialMasking(createSecretMasker([{ name: 'API_KEY', value: secret }])))
  const [item] = await threadItems(masked.map(chunk => ({ chunk, at: new Date(0) })), [])
  assert.ok(item.kind === 'steps')
  const serialized = JSON.stringify(item)
  assert.ok(!serialized.includes(secret))
  assert.ok(!serialized.includes(Buffer.from(secret).toString('base64')))
  assert.match(serialized, /\[secret:API_KEY\]/)
  const output = (await resultStep(`${'x'.repeat(4080)} ${token} ${jwt} ${'y'.repeat(10_000)} ${token}`)).output!
  assert.ok(!output.includes(token))
  assert.ok(!output.includes(jwt))
  assert.ok(!output.includes('ghp_'), 'mask the complete token before a cutoff can split it')
  assert.match(output, /\[secret:github-token\]/)
  assert.equal((await resultStep({ [token]: jwt })).output, '{\n  "[secret:github-token]": "[secret:jwt]"\n}')
})

test('only active run states offer messages; completed history stays readable', () => {
  for (const state of ['queued', 'preparing', 'running', 'waiting_input', 'finishing']) assert.equal(runIsActive(state), true)
  for (const state of ['succeeded', 'stopped', 'failed', 'cancelled', 'unknown']) assert.equal(runIsActive(state), false)
})
test('a run waiting for the person is live but not working: its composer sends, it does not stop', () => {
  for (const state of ['queued', 'preparing', 'running', 'finishing']) assert.equal(runIsWorking(state), true)
  for (const state of ['waiting_input', 'succeeded', 'stopped', 'failed', 'cancelled', 'unknown']) assert.equal(runIsWorking(state), false)
})
test('a run row shows the report summary, else the first error line, else nothing', () => {
  assert.equal(runSummaryText({ report: { summary: ' Fixed the login loop. ' }, error: null }), 'Fixed the login loop.')
  assert.equal(runSummaryText({ report: { summary: '' }, error: '\nDevice offline\nretrying' }), 'Device offline')
  assert.equal(runSummaryText({ report: 'raw', error: null }), null)
  assert.equal(runSummaryText({ report: null, error: null }), null)
})

test('summary provenance preserves the exact report, error fallback and empty display choices', () => {
  for (const report of [{ summary: '' }, { summary: ' \n\t' }, { summary: null }, null, 'raw', []]) {
    assert.deepEqual(runSummaryView({ report, error: '\n Device offline\nretrying' }), { summary: 'Device offline', summarySource: 'error' })
    assert.deepEqual(runSummaryView({ report, error: null }), { summary: null, summarySource: null })
  }
  assert.deepEqual(runSummaryView({ report: { summary: ' Fixed the login loop. ' }, error: 'Stale error' }),
    { summary: 'Fixed the login loop.', summarySource: 'report' })
})

test('the issue thread list reads on its live key, never on a timer', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync('components/workspace/issue-threads.tsx', 'utf8')
  assert.match(source, /useLiveKey\('issue_threads',/)
  assert.doesNotMatch(source, /refreshInterval/)
})

test('stop acknowledgement has a bounded deadline through polling, reload and retry', () => {
  const requestedAt = Date.parse('2026-10-27T12:00:00Z')
  assert.equal(runStopTimeoutRemaining(requestedAt, requestedAt), 30_000)
  assert.equal(runStopTimeoutRemaining(requestedAt, requestedAt + 25_000), 5_000)
  assert.equal(runStopTimeoutRemaining(requestedAt, requestedAt + 30_000), 0)
  assert.equal(runStopTimeoutRemaining(requestedAt, requestedAt + 60_000), 0)
  assert.equal(runStopTimeoutRemaining(requestedAt + 60_000, requestedAt + 60_000), 30_000, 'retry starts its own wait without changing the durable request')
  assert.equal(runStopTimeoutRemaining(requestedAt, requestedAt - 60_000), 30_000, 'clock skew must not create an unbounded wait')
})

test('a thread reads as one conversation: agent text, folded steps and people in time order', async () => {
  const t = (seconds: number) => new Date(Date.UTC(2026, 9, 25, 12, 0, seconds))
  const items = await threadItems([
    { chunk: { type: 'text-delta', id: 'a', delta: 'Reproduced ' }, at: t(1) },
    { chunk: { type: 'text-delta', id: 'a', delta: 'it.' }, at: t(2) },
    { chunk: { type: 'tool-input-available', toolCallId: '1' }, at: t(3) },
    { chunk: { type: 'tool-output-available', toolCallId: '1', output: 'x' }, at: t(4) },
    { chunk: { type: 'tool-input-available', toolCallId: '2' }, at: t(5) },
    { chunk: { type: 'text-delta', id: 'b', delta: 'Fixed.' }, at: t(20) },
    { chunk: { type: 'text-delta', id: 'c', delta: '  ' }, at: t(21) },
    { chunk: { type: 'error', errorText: 'Interrupted' }, at: t(30) },
  ], [{ id: 'm', text: 'Check the fallback', author: 'Lin', mine: false, at: t(10) }])
  assert.deepEqual(items.map(item => item.kind === 'steps' ? `steps:${item.count}` : item.kind === 'person' ? `person:${item.author}` : item.kind === 'computer' ? `computer:${item.botId}` : item.kind === 'stages' ? `stages:${item.stages.length}` : `${item.kind}:${item.text}`),
    ['agent:Reproduced it.', 'steps:2', 'person:Lin', 'agent:Fixed.', 'error:Interrupted'])
})

test('a folded steps line keeps each tool call so it can open: name, what it ran, whether it failed', async () => {
  const at = new Date()
  const items = await threadItems([
    { chunk: { type: 'tool-input-available', toolCallId: '1', toolName: 'Bash', input: { command: 'pnpm   test\n --watch=false', description: 'Run tests' } }, at },
    { chunk: { type: 'tool-output-error', toolCallId: '1', errorText: 'exit 1' }, at },
    { chunk: { type: 'tool-input-available', toolCallId: '2', toolName: 'apply_patch', input: { files: ['a.ts', 'b.ts'] } }, at },
    { chunk: { type: 'tool-input-available', toolCallId: '3', toolName: 'Read', input: { file_path: `/${'x'.repeat(300)}` } }, at },
    { chunk: { type: 'tool-input-available', toolCallId: '4', input: 'raw' }, at },
  ], [])
  assert.equal(items.length, 1)
  const [steps] = items
  assert.ok(steps.kind === 'steps')
  assert.equal(steps.count, 4)
  assert.deepEqual(steps.steps.slice(0, 2), [
    { id: '1', name: 'Bash', detail: 'pnpm test --watch=false', command: 'pnpm   test\n --watch=false', failed: true, kind: 'shell', status: 'failed' },
    { id: '2', name: 'apply_patch', detail: 'a.ts, b.ts', failed: false, kind: 'edit', status: 'running', target: 'a.ts, b.ts', input: '{"files":["a.ts","b.ts"]}' },
  ])
  assert.ok(!('input' in steps.steps[0]), 'a command\'s input is its command, kept once')
  assert.equal(steps.steps[2].detail?.length, 200)
  assert.ok(steps.steps[2].detail?.endsWith('…'))
  assert.equal(steps.steps[2].target?.length, 200, 'a target is one line too')
  assert.deepEqual(steps.steps[3], { id: '4', name: 'tool', detail: null, failed: false, kind: 'other', status: 'running' })
})

test('a thread shows one computer card only for its own run', async () => {
  const at = new Date()
  const card = { type: 'data-computer', data: { botId: 'bot-a', runId: 'run-a', task: 'Open the page', state: 'working' } }
  const chunks = [{ chunk: card, at }, { chunk: card, at }, { chunk: { ...card, data: { ...card.data, runId: 'run-b' } }, at }]
  assert.deepEqual((await threadItems(chunks, [], 'run-a')).map(item => item.kind), ['computer'])
  assert.deepEqual(await threadItems(chunks, [], 'run-c'), [])
})

test('start-up stages fold into one line in order, keep failures, and ignore malformed stage data', async () => {
  const at = '2026-11-01T12:00:00Z'
  const items = await threadItems([
    { chunk: { type: 'data-run-stage', data: { stage: 'repository', ms: 3200, ok: true } }, at },
    { chunk: { type: 'data-run-stage', data: { stage: 'worktree', ms: 400, ok: true } }, at },
    { chunk: { type: 'data-run-stage', data: { stage: 'agent_start', ms: 65_700, ok: false } }, at },
    { chunk: { type: 'data-run-stage', data: { stage: 'docker', ms: 1, ok: true } }, at },
    { chunk: { type: 'data-run-stage', data: { stage: 'worktree', ms: '1', ok: true } }, at },
  ], [])
  assert.deepEqual(items, [{ kind: 'stages', id: 'stages:data-run-stage@start#0', at: Date.parse(at), stages: [
    { stage: 'repository', ms: 3200, ok: true },
    { stage: 'worktree', ms: 400, ok: true },
    { stage: 'agent_start', ms: 65_700, ok: false },
  ] }])
})

test('a failed run says why; any other run says nothing', () => {
  assert.equal(runFailureText('failed', '  docker timed out after 65s\n'), 'docker timed out after 65s')
  assert.equal(runFailureText('failed', null), null)
  assert.equal(runFailureText('failed', '   '), null)
  assert.equal(runFailureText('succeeded', 'leftover error'), null)
  assert.equal(runFailureText('running', 'transient error'), null)
})

test('a thread that ran again reads as one conversation: each run keeps its own text and steps', async () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 2, 0, 0, s))
  const rows = [
    { runId: 'r1', chunk: { type: 'text-delta', id: 't1', delta: 'First.' }, at: at(1) },
    { runId: 'r1', chunk: { type: 'tool-input-available', toolCallId: 'a', toolName: 'Edit' }, at: at(2) },
    { runId: 'r2', chunk: { type: 'text-delta', id: 't1', delta: 'Second.' }, at: at(10) },
    { runId: 'r2', chunk: { type: 'tool-input-available', toolCallId: 'a', toolName: 'Bash' }, at: at(11) },
    { runId: 'r2', chunk: { type: 'tool-output-error', toolCallId: 'a', errorText: 'x' }, at: at(12) },
  ]
  const items = await threadItems(chainChunks(rows), [{ id: 'm', text: 'Go on.', author: 'Alex', mine: true, at: at(9) }])
  assert.deepEqual(items.map(item => item.kind === 'agent' ? `agent:${item.text}` : item.kind === 'steps' ? `steps:${item.steps.map(step => `${step.name}${step.failed ? '!' : ''}`).join(',')}` : item.kind),
    ['agent:First.', 'steps:Edit', 'person', 'agent:Second.', 'steps:Bash!'])
  // Ids are scoped to their run from the first run on, so the second run renames nothing (lib/conversation/ids.ts).
  assert.deepEqual(chainChunks(rows.slice(0, 2)).map(row => row.chunk.id ?? row.chunk.toolCallId), ['r1:t1', 'r1:a'], 'one run scopes its ids too')
})

test('a folded steps row counts commands and tools the way iOS does (#1770)', async () => {
  const { isCommandStep, threadStepCounts } = await import('./issue-run-conversation')
  for (const name of ['Bash', 'bash', 'shell', 'execute']) assert.equal(isCommandStep({ name }), true)
  for (const name of ['Read', 'apply_patch', 'mcp__mikka__record_decision', 'tool']) assert.equal(isCommandStep({ name }), false)
  assert.deepEqual(threadStepCounts([{ name: 'Bash' }, { name: 'bash' }, { name: 'Edit' }]), { commands: 2, tools: 1 })
  assert.deepEqual(threadStepCounts([{ name: 'Read' }]), { commands: 0, tools: 1 })
  assert.deepEqual(threadStepCounts([]), { commands: 0, tools: 0 })
})

// #2937: the structured fields the thread folds by, from Claude Code's and Codex's chunks as their adapters write them
// (packages/daemon/src/adapters/claude.ts claudeChunks, codex.ts codexItemChunks); old rows read the same way.
test('tool calls carry kind, status, target and the daemon\'s truncation mark (#2937)', async () => {
  const { threadStepStatus } = await import('./issue-run-conversation')
  const at = new Date(0)
  const claude = [
    { type: 'tool-input-available', toolCallId: 'r', toolName: 'Read', input: { file_path: 'components/task-detail-skeleton.tsx' } },
    { type: 'tool-output-available', toolCallId: 'r', output: 'export function Skeleton() {}' },
    { type: 'tool-input-available', toolCallId: 'g', toolName: 'Grep', input: { pattern: 'TaskDetailLoading', path: 'components/workspace' } },
    { type: 'tool-output-available', toolCallId: 'g', output: 'components/workspace/task-detail.tsx' },
    { type: 'tool-input-available', toolCallId: 'b', toolName: 'Bash', input: { command: 'pnpm lint:ui', description: 'Lint' } },
    { type: 'tool-output-available', toolCallId: 'b', output: 'x'.repeat(4000), outputTruncated: true },
    { type: 'tool-input-available', toolCallId: 'm', toolName: 'mcp__github__pull_request_read', input: { pullNumber: 2837 } },
  ]
  const codex = [
    { type: 'tool-input-available', toolCallId: 'c', toolName: 'bash', input: { command: 'pnpm lint:ui' } },
    { type: 'tool-output-available', toolCallId: 'c', output: { exitCode: 1, output: '1 problem' } },
    { type: 'tool-input-available', toolCallId: 'p', toolName: 'apply_patch', input: { files: ['a.ts', 'b.ts'] } },
    { type: 'tool-output-available', toolCallId: 'p', output: { status: 'completed' } },
  ]
  const steps = async (chunks: Record<string, unknown>[]) => {
    const [item] = await threadItems(chunks.map(chunk => ({ chunk, at })), [])
    assert.ok(item.kind === 'steps')
    return item.steps
  }
  assert.deepEqual((await steps(claude)).map(({ kind, status, target, scope, outputTruncated }) => ({ kind, status, target, scope, outputTruncated })), [
    { kind: 'read', status: 'ok', target: 'components/task-detail-skeleton.tsx', scope: undefined, outputTruncated: undefined },
    { kind: 'search', status: 'ok', target: 'TaskDetailLoading', scope: 'components/workspace', outputTruncated: undefined },
    { kind: 'shell', status: 'ok', target: undefined, scope: undefined, outputTruncated: true },
    { kind: 'other', status: 'running', target: undefined, scope: undefined, outputTruncated: undefined },
  ])
  assert.deepEqual((await steps(codex)).map(({ kind, status, target, exitCode }) => ({ kind, status, target, exitCode })), [
    { kind: 'shell', status: 'failed', target: undefined, exitCode: 1 },
    { kind: 'edit', status: 'ok', target: 'a.ts, b.ts', exitCode: undefined },
  ])
  const running = (await steps(claude)).at(-1)!
  assert.equal(threadStepStatus(running, true), 'running')
  assert.equal(threadStepStatus(running, false), 'cancelled', 'a call its ended run left running never finished')
  assert.equal(threadStepStatus((await steps(codex))[0], false), 'failed')
})

test('the activity line is the one running indicator: no status badge beside a working, waiting or stopping run', () => {
  const none = { waiting: false, stopping: false, outcome: null }
  for (const status of ['queued', 'preparing', 'running', 'finishing', 'waiting_input']) assert.equal(activityLineBadgeShown(status, none), false, status)
  assert.equal(activityLineBadgeShown('succeeded', { ...none, waiting: true }), false)
  assert.equal(activityLineBadgeShown('failed', { ...none, stopping: true }), false)
  // What the line does not say stays: a run that ended blocked, paused, or with an outcome to judge.
  assert.equal(activityLineBadgeShown('failed', none), true)
  assert.equal(activityLineBadgeShown('paused', none), true)
  assert.equal(activityLineBadgeShown('succeeded', { ...none, outcome: 'merged' }), true)
  assert.equal(activityLineBadgeShown('succeeded', none), false)
})

test('a run has one Stop: the composer while it works there, the header only where the composer cannot', () => {
  assert.equal(headerStopShown({ canStop: true, working: true, composerStop: true }), false)
  assert.equal(headerStopShown({ canStop: true, working: false, composerStop: true }), true, 'waiting for an answer: the composer sends')
  assert.equal(headerStopShown({ canStop: true, working: true, composerStop: false }), true, 'no composer on screen')
  assert.equal(headerStopShown({ canStop: false, working: true, composerStop: false }), false)
})

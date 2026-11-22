import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mock, test } from 'node:test'

// The real Chinese words, so the rows follow zh-CN.json.
const zh = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8')).IssueThreads.tool as Record<string, string>
mock.module('@/lib/intl/i18n-client', { namedExports: { useTranslations: () => (key: string, args: Record<string, unknown> = {}) => {
  assert.ok(zh[key], key)
  return zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(args[name]))
} } })

const { threadItems } = await import('@/lib/issue-run-conversation')
const { useThreadStepRows } = await import('./thread-step-rows')

const at = new Date(0)
const steps = async (chunks: Record<string, unknown>[]) => {
  const [item] = await threadItems(chunks.map(chunk => ({ chunk, at })), [])
  assert.ok(item.kind === 'steps')
  return item.steps
}

test('a run\'s tool calls are named by what they did, from the structured fields (#2923, #2937)', async () => {
  const rows = useThreadStepRows()(await steps([
    { type: 'tool-input-available', toolCallId: 'r', toolName: 'Read', input: { file_path: 'task-detail-skeleton.tsx' } },
    { type: 'tool-output-available', toolCallId: 'r', output: 'export {}' },
    { type: 'tool-input-available', toolCallId: 'g', toolName: 'Grep', input: { pattern: 'TaskDetailLoading', path: 'components/workspace' } },
    { type: 'tool-output-available', toolCallId: 'g', output: '' },
    { type: 'tool-input-available', toolCallId: 'ok', toolName: 'bash', input: { command: 'pnpm test --filter task-detail -u' } },
    { type: 'tool-output-available', toolCallId: 'ok', output: { exitCode: 0, output: 'Tests 20 passed (20)\n' }, toolDurationMs: 4100 },
    { type: 'tool-input-available', toolCallId: 'bad', toolName: 'Bash', input: { command: 'pnpm lint:ui\n  --fix' } },
    { type: 'tool-output-available', toolCallId: 'bad', output: { exitCode: 1, output: '1 problem' }, outputTruncated: true },
    { type: 'tool-input-available', toolCallId: 'mcp', toolName: 'mcp__github__pull_request_read', input: { title: 'Mikka#2837' } },
  ]), true)
  // Alex, 2026-11-22: the tool's English title, then what it acted on, also in a Chinese UI.
  assert.deepEqual(rows.map(row => [row.label, row.note, row.kind, row.status]), [
    ['Read file', 'task-detail-skeleton.tsx', 'read', 'done'],
    ['Search', '"TaskDetailLoading" in components/workspace', 'search', 'done'],
    ['Run command', 'pnpm test --filter task-detail -u', 'shell', 'done'],
    ['Run command', 'pnpm lint:ui', 'shell', 'failed'],
    ['Pull request read', 'Mikka#2837', 'other', 'running'],
  ])
  for (const row of rows) assert.doesNotMatch(row.label, /_|\p{Script=Han}/u, row.label)
  assert.equal(rows[3].error, '退出码 1', 'a failed command says how it ended')
  assert.equal(rows[1].target, 'TaskDetailLoading')
  assert.equal(rows[0].input, JSON.stringify({ file_path: 'task-detail-skeleton.tsx' }), 'the call\'s input opens with the row')
  assert.equal(rows[2].detail, 'Tests 20 passed (20)\n', 'the Shell box shows the output, not its JSON envelope')
  assert.equal(rows[2].exitCode, 0)
  assert.equal(rows[2].ms, 4100)
  assert.equal(rows[3].outputTruncated, true)
})

test('a search names its folder only when it is not the workspace root', async () => {
  const rows = useThreadStepRows()(await steps([
    { type: 'tool-input-available', toolCallId: 'a', toolName: 'Grep', input: { pattern: 'redirect', path: 'lib/auth' } },
    { type: 'tool-input-available', toolCallId: 'b', toolName: 'Grep', input: { pattern: 'redirect', path: '.' } },
    { type: 'tool-input-available', toolCallId: 'c', toolName: 'Grep', input: { pattern: 'redirect' } },
  ]), true)
  assert.deepEqual(rows.map(row => `${row.label} · ${row.note}`), ['Search · "redirect" in lib/auth', 'Search · "redirect"', 'Search · "redirect"'])
})

test('a call its ended run left running reads as stopped', async () => {
  const [row] = useThreadStepRows()(await steps([{ type: 'tool-input-available', toolCallId: 'b', toolName: 'Bash', input: { command: 'pnpm build' } }]), false)
  assert.equal(row.status, 'stopped')
  assert.equal(row.label, 'Run command')
  assert.equal(row.note, 'pnpm build')
})

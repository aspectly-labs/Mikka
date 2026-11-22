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
const steps = (chunks: Record<string, unknown>[]) => {
  const [item] = threadItems(chunks.map(chunk => ({ chunk, at })), [])
  assert.ok(item.kind === 'steps')
  return item.steps
}

test('a run\'s tool calls are named by what they did, from the structured fields (#2923, #2937)', () => {
  const rows = useThreadStepRows()(steps([
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
  assert.deepEqual(rows.map(row => [row.label, row.kind, row.status]), [
    ['已读取 task-detail-skeleton.tsx', 'read', 'done'],
    ['已在 components/workspace 中搜索“TaskDetailLoading”', 'search', 'done'],
    ['pnpm test --filter task-detail -u', 'shell', 'done'],
    ['命令失败 (pnpm lint:ui) · exit 1', 'shell', 'failed'],
    ['mcp__github__pull_request_read', 'other', 'running'],
  ])
  assert.equal(rows[2].detail, 'Tests 20 passed (20)\n', 'the Shell box shows the output, not its JSON envelope')
  assert.equal(rows[2].exitCode, 0)
  assert.equal(rows[2].ms, 4100)
  assert.equal(rows[3].outputTruncated, true)
  assert.equal(rows[4].note, 'Mikka#2837', 'a tool with no kind keeps the input that says what it did')
  assert.ok(!('note' in rows[0]), 'a named row does not repeat its target')
})

test('a call its ended run left running reads as stopped', () => {
  const [row] = useThreadStepRows()(steps([{ type: 'tool-input-available', toolCallId: 'b', toolName: 'Bash', input: { command: 'pnpm build' } }]), false)
  assert.equal(row.status, 'stopped')
  assert.equal(row.label, 'pnpm build')
})

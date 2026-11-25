import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChatItem, ChatTool } from '@/lib/coordinator/context'
import { chainChunks, threadItems } from '@/lib/issue-run-conversation'
import {
  classifyShellCommand,
  enrichMobileChatItems,
  enrichMobileChatTool,
  enrichMobileThreadItems,
  enrichMobileThreadStep,
  extractThreadStepContext,
  unwrapShellCommand,
} from './mobile-tool-projection'

function makeChatTool(overrides: Partial<ChatTool> & { name: string }): ChatTool {
  return { call: 'call-1', state: 'done', ...overrides }
}

test('unwrapShellCommand strips shell wrappers cleanly without redacting values', () => {
  assert.equal(unwrapShellCommand(`/bin/zsh -lc 'pnpm test --filter web'`), 'pnpm test --filter web')
  assert.equal(unwrapShellCommand(`/bin/bash -lc "git log -n 5 --oneline"`), 'git log -n 5 --oneline')
  assert.equal(unwrapShellCommand(`/usr/bin/env bash -lc 'rg -n "foo" src/'`), 'rg -n "foo" src/')
  assert.equal(unwrapShellCommand(String.raw`sh -c 'echo '\''hello'\'' && pwd'`), `echo 'hello' && pwd`)
  assert.equal(unwrapShellCommand('pnpm test'), 'pnpm test')
})

test('classifyShellCommand aligns with Codex CommandAction exploration vs exec', () => {
  const readCmd = classifyShellCommand(`/bin/zsh -lc 'cat lib/coordinator/context.ts'`)
  assert.equal(readCmd.kind, 'read')
  assert.equal(readCmd.command, 'cat lib/coordinator/context.ts')
  assert.equal(readCmd.path, 'lib/coordinator/context.ts')
  assert.deepEqual(readCmd.commandActions, [
    { type: 'read', command: 'cat lib/coordinator/context.ts', name: 'context.ts', path: 'lib/coordinator/context.ts' },
  ])

  const sedRead = classifyShellCommand(`sed -n '1,40p' app/api/mobile/chat/route.ts`)
  assert.equal(sedRead.kind, 'read')
  assert.equal(sedRead.path, 'app/api/mobile/chat/route.ts')

  const sedInPlace = classifyShellCommand(`sed -i '' 's/foo/bar/g' app/page.tsx`)
  assert.equal(sedInPlace.kind, 'exec')

  const listCmd = classifyShellCommand('ls -la apps/desktop')
  assert.equal(listCmd.kind, 'listFiles')
  assert.equal(listCmd.path, 'apps/desktop')

  const findRead = classifyShellCommand(`find lib -name '*.ts'`)
  assert.equal(findRead.kind, 'listFiles')
  assert.equal(findRead.path, 'lib')

  const findDelete = classifyShellCommand(`find tmp -name '*.log' -delete`)
  assert.equal(findDelete.kind, 'exec')

  const rgFiles = classifyShellCommand('rg --files components/')
  assert.equal(rgFiles.kind, 'listFiles')
  assert.equal(rgFiles.path, 'components/')

  const searchCmd = classifyShellCommand(`cd /repo && rg -n -C 2 "ThreadItem" lib/ 2>/dev/null | head -n 20`)
  assert.equal(searchCmd.kind, 'search')
  assert.equal(searchCmd.inferredCwd, '/repo')
  assert.equal(searchCmd.query, 'ThreadItem')
  assert.equal(searchCmd.path, 'lib/')

  const writeRedirect = classifyShellCommand('cat a.txt > b.txt')
  assert.equal(writeRedirect.kind, 'exec')

  const testCmd = classifyShellCommand('pnpm test:unit')
  assert.equal(testCmd.kind, 'exec')
  assert.deepEqual(testCmd.commandActions, [{ type: 'unknown', command: 'pnpm test:unit' }])
})

test('NO regex secret masking and NO UUID scrubbing in mobile tool projection', () => {
  const token = `ghp_${'A'.repeat(36)}`
  const uuid = '11111111-2222-3333-4444-555555555555'
  const shellTool = enrichMobileChatTool(makeChatTool({
    name: 'bash',
    input: JSON.stringify({ command: `/bin/zsh -lc 'echo ${token} ${uuid}'`, cwd: '/workspace/mikka' }),
    output: JSON.stringify({ exitCode: 0, output: `ok ${token} run=${uuid}` }),
  }))

  assert.equal(shellTool.kind, 'exec')
  assert.equal(shellTool.status, 'completed')
  assert.equal(shellTool.command, `echo ${token} ${uuid}`)
  assert.equal(shellTool.cwd, '/workspace/mikka')
  assert.equal(shellTool.exitCode, 0)
  assert.equal(shellTool.aggregatedOutput, `ok ${token} run=${uuid}`)

  const dispatchTool = enrichMobileChatTool(makeChatTool({
    name: 'dispatch_run',
    input: JSON.stringify({ issueId: uuid, harness: 'codex', prompt: `Fix run ${uuid}` }),
    output: JSON.stringify({ runId: uuid, status: 'queued' }),
  }))
  assert.equal(dispatchTool.kind, 'agent')
  assert.equal(dispatchTool.agentAction, 'spawn')
  assert.equal(dispatchTool.targetThreadId, uuid)
  assert.deepEqual(dispatchTool.arguments, { issueId: uuid, harness: 'codex', prompt: `Fix run ${uuid}` })
  assert.deepEqual(dispatchTool.result, { runId: uuid, status: 'queued' })
})

test('enrichMobileChatTool classifies MCP, edit, web, search, agent, think and error/declined states', () => {
  const mcp = enrichMobileChatTool(makeChatTool({
    name: 'github_call',
    input: JSON.stringify({ name: 'get_pull_request', arguments: { owner: 'aspectly-labs', repo: 'Mikka', pull_number: 3300 } }),
    output: JSON.stringify({ number: 3300, state: 'open' }),
  }))
  assert.equal(mcp.kind, 'mcp')
  assert.equal(mcp.server, 'github')
  assert.equal(mcp.tool, 'get_pull_request')
  assert.equal(mcp.status, 'completed')
  assert.deepEqual(mcp.result, { number: 3300, state: 'open' })

  const createIssue = enrichMobileChatTool(makeChatTool({
    name: 'create_issue',
    input: JSON.stringify({ title: 'Mobile 2.0 tool projection', status: 'in_progress' }),
    output: JSON.stringify({ identifier: 'MIK-541', title: 'Mobile 2.0 tool projection' }),
  }))
  assert.equal(createIssue.kind, 'mcp')
  assert.equal(createIssue.server, 'mikka')
  assert.equal(createIssue.tool, 'create_issue')

  const denied = enrichMobileChatTool(makeChatTool({
    name: 'bash',
    state: 'error',
    errorCode: 'approval_denied',
    input: JSON.stringify({ command: 'rm -rf /tmp/foo' }),
  }))
  assert.equal(denied.kind, 'exec')
  assert.equal(denied.status, 'declined')
  assert.equal(denied.error, 'approval_denied')

  const web = enrichMobileChatTool(makeChatTool({
    name: 'web_search',
    input: JSON.stringify({ query: 'Codex Electron ThreadItem' }),
    output: JSON.stringify({ results: [{ title: 'Spec' }] }),
  }))
  assert.equal(web.kind, 'web')
  assert.equal(web.query, 'Codex Electron ThreadItem')

  const streamingShell = enrichMobileChatTool(makeChatTool({
    name: 'bash',
    state: 'running',
    input: '{}',
  }))
  assert.equal(streamingShell.kind, 'exec')
  assert.equal(streamingShell.status, 'running')
})

test('enrichMobileChatItems marks in-progress tools on stopped items as declined + interrupted without mutation', () => {
  const original: ChatItem[] = [{
    id: 'm1',
    position: 1,
    from: 'coordinator',
    text: 'Working...',
    tools: ['bash'],
    threads: [],
    artifacts: [],
    createdAt: '2026-11-25T14:00:00Z',
    stopped: true,
    activity: {
      thought: false,
      tools: [makeChatTool({ name: 'bash', state: 'running', input: JSON.stringify({ command: 'pnpm test' }) })],
    },
  }]

  const enriched = enrichMobileChatItems(original)
  const tool = enriched[0].activity!.tools[0] as ReturnType<typeof enrichMobileChatTool>
  assert.equal(tool.status, 'declined')
  assert.equal(tool.interrupted, true)
  assert.equal('kind' in original[0].activity!.tools[0], false)
})

test('enrichMobileThreadItems extracts Codex fileChange stats, shell commandActions, chunk timing, cwd, and errorText', async () => {
  const t0 = Date.parse('2026-11-25T14:00:00.000Z')
  const t1 = Date.parse('2026-11-25T14:00:02.450Z')
  const t2 = Date.parse('2026-11-25T14:00:03.000Z')
  const t3 = Date.parse('2026-11-25T14:00:03.200Z')

  const patchInput = [
    '*** Begin Patch',
    '*** Update File: lib/app.ts',
    '@@ -1,2 +1,3 @@',
    '-const a = 1',
    '+const a = 2',
    '+const b = 3',
    '*** Add File: lib/new.ts',
    '+export const ok = true',
    '*** End Patch',
  ].join('\n')

  const rawChunks = [
    { runId: 'run-1', seq: 1, at: new Date(t0), chunk: { type: 'tool-input-available', toolCallId: 'c1', toolName: 'Bash', input: { command: `/bin/zsh -lc 'pnpm test'`, cwd: '/repo/mikka' } } },
    { runId: 'run-1', seq: 2, at: new Date(t1), chunk: { type: 'tool-output-available', toolCallId: 'c1', output: { output: 'all 42 passed\n', exitCode: 0 } } },
    { runId: 'run-1', seq: 3, at: new Date(t2), chunk: { type: 'tool-input-available', toolCallId: 'c2', toolName: 'apply_patch', input: { patch: patchInput } } },
    { runId: 'run-1', seq: 4, at: new Date(t3), chunk: { type: 'tool-output-available', toolCallId: 'c2', output: 'Success' } },
    { runId: 'run-1', seq: 5, at: new Date(t3), chunk: { type: 'tool-input-available', toolCallId: 'c3', toolName: 'mcp__github__pull_request_read', input: { pullNumber: 3300 } } },
    { runId: 'run-1', seq: 6, at: new Date(t3 + 100), chunk: { type: 'tool-output-error', toolCallId: 'c3', errorText: 'GitHub rate limit exceeded' } },
    { runId: 'run-1', seq: 7, at: new Date(t3 + 200), chunk: { type: 'tool-input-available', toolCallId: 'c4', toolName: 'Bash', input: { command: 'rg -n "foo" src/' } } },
    { runId: 'run-1', seq: 8, at: new Date(t3 + 250), chunk: { type: 'tool-output-available', toolCallId: 'c4', output: { output: 'src/a.ts:1:foo', exitCode: 0 } } },
  ]

  const chunks = chainChunks(rawChunks)
  const items = await threadItems(chunks, [])
  const stepContext = extractThreadStepContext(chunks)
  const enriched = enrichMobileThreadItems(items, { active: false, contextByCallId: stepContext })

  assert.equal(enriched.length, 1)
  assert.equal(enriched[0].kind, 'steps')
  const [s1, s2, s3, s4] = enriched[0].steps

  assert.equal(s1.kind, 'exec')
  assert.equal(s1.status, 'completed')
  assert.equal(s1.command, 'pnpm test')
  assert.equal(s1.cwd, '/repo/mikka')
  assert.equal(s1.exitCode, 0)
  assert.equal(s1.aggregatedOutput, 'all 42 passed\n')
  assert.equal(s1.startedAtMs, t0)
  assert.equal(s1.completedAtMs, t1)
  assert.equal(s1.durationMs, 2450)

  assert.equal(s2.kind, 'edit')
  assert.equal(s2.status, 'completed')
  assert.equal(s2.fileChange?.path, 'lib/app.ts')
  assert.equal(s2.fileChange?.changeKind, 'update')
  assert.equal(s2.fileChange?.linesAdded, 2)
  assert.equal(s2.fileChange?.linesRemoved, 1)
  assert.equal(s2.fileChanges?.length, 2)
  assert.equal(s2.fileChanges?.[1].path, 'lib/new.ts')
  assert.equal(s2.fileChanges?.[1].changeKind, 'add')
  assert.equal(s2.fileChanges?.[1].linesAdded, 1)

  assert.equal(s3.kind, 'mcp')
  assert.equal(s3.server, 'github')
  assert.equal(s3.tool, 'pull_request_read')
  assert.equal(s3.status, 'failed')
  assert.equal(s3.error, 'GitHub rate limit exceeded')
  assert.deepEqual(s3.arguments, { pullNumber: 3300 })

  assert.equal(s4.kind, 'search')
  assert.equal(s4.query, 'foo')
  assert.equal(s4.path, 'src/')
  assert.equal(s4.command, 'rg -n "foo" src/')
  assert.equal(s4.aggregatedOutput, 'src/a.ts:1:foo')
})

test('enrichMobileThreadStep computes Edit line diff stats and bounds huge outputs safely', () => {
  const edit = enrichMobileThreadStep({
    id: 'e1',
    name: 'Edit',
    detail: 'src/button.tsx',
    failed: false,
    kind: 'edit',
    status: 'ok',
    target: 'src/button.tsx',
    input: JSON.stringify({
      file_path: 'src/button.tsx',
      old_string: 'const a = 1\nconst b = 2\nconst c = 3',
      new_string: 'const a = 1\nconst b = 20\nconst d = 40\nconst c = 3',
    }),
  })
  assert.equal(edit.kind, 'edit')
  assert.equal(edit.fileChange?.path, 'src/button.tsx')
  assert.equal(edit.fileChange?.changeKind, 'update')
  assert.equal(edit.fileChange?.linesRemoved, 1)
  assert.equal(edit.fileChange?.linesAdded, 2)

  const huge = 'a'.repeat(10_000)
  const cmd = enrichMobileThreadStep({
    id: 'b1',
    name: 'Bash',
    detail: 'node big.mjs',
    command: 'node big.mjs',
    output: huge,
    exitCode: 0,
    failed: false,
    kind: 'shell',
    status: 'ok',
  })
  assert.ok(cmd.aggregatedOutput)
  assert.ok(cmd.aggregatedOutput.includes('[output truncated]'))
  assert.ok(cmd.aggregatedOutput.length < huge.length)
})

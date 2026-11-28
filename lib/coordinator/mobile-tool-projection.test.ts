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

test('classifyShellCommand aligns with Codex CommandAction exploration vs exec including multiline scripts', () => {
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

  // Multiline scripts split on unquoted newlines so mutating lines are never hidden as exploration.
  const multilineScript = classifyShellCommand('ls -la\nmkdir -p /tmp/demo')
  assert.equal(multilineScript.kind, 'exec')
  assert.equal(multilineScript.commandActions.length, 2)
  assert.equal(multilineScript.commandActions[0].type, 'listFiles')
  assert.equal(multilineScript.commandActions[1].type, 'unknown')

  // Wrapped read-only pipelines across `|\n` stay grouped as exploration.
  const wrappedPipeline = classifyShellCommand('ls -la |\n  sort |\n  head -n 20')
  assert.equal(wrappedPipeline.kind, 'listFiles')
  assert.equal(wrappedPipeline.commandActions.length, 1)
  assert.equal(wrappedPipeline.commandActions[0].type, 'listFiles')

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
  assert.equal(shellTool.codexKind, 'exec')
  assert.equal(shellTool.status, 'completed')
  assert.equal(shellTool.codexStatus, 'completed')
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
  assert.equal(dispatchTool.codexKind, 'agent')
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

  // Successful command printing "Permission denied" stays completed, never declined.
  const searchDenied = enrichMobileChatTool(makeChatTool({
    name: 'bash',
    state: 'done',
    input: JSON.stringify({ command: 'rg denied server.log' }),
    output: JSON.stringify({ exitCode: 0, output: 'server.log:14:Permission denied' }),
  }))
  assert.equal(searchDenied.kind, 'search')
  assert.equal(searchDenied.status, 'completed')
  assert.equal(searchDenied.aggregatedOutput, 'server.log:14:Permission denied')

  // Successful `get_run` reading a failed run must stay completed and keep its structured result.
  const failedRunLookup = enrichMobileChatTool(makeChatTool({
    name: 'get_run',
    state: 'done',
    input: JSON.stringify({ runId: '11111111-2222-3333-4444-555555555555' }),
    output: JSON.stringify({ id: '11111111-2222-3333-4444-555555555555', status: 'failed', error: null }),
  }))
  assert.equal(failedRunLookup.kind, 'search')
  assert.equal(failedRunLookup.status, 'completed')
  assert.equal(failedRunLookup.codexStatus, 'completed')
  assert.deepEqual(failedRunLookup.result, { id: '11111111-2222-3333-4444-555555555555', status: 'failed', error: null })

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

test('enrichMobileThreadItems preserves legacy ThreadStep kind/status while adding Codex 1:1 fields', async () => {
  const t0 = Date.parse('2026-11-25T14:00:00.000Z')
  const t1 = Date.parse('2026-11-25T14:00:02.450Z')
  const t2 = Date.parse('2026-11-25T14:00:03.000Z')
  const t3 = Date.parse('2026-11-25T14:00:03.200Z')

  const rawChunks = [
    // 1. Standard command execution
    { runId: 'run-1', seq: 1, at: new Date(t0), chunk: { type: 'tool-input-available', toolCallId: 'c1', toolName: 'Bash', input: { command: `/bin/zsh -lc 'pnpm test'`, cwd: '/repo/mikka' } } },
    { runId: 'run-1', seq: 2, at: new Date(t1), chunk: { type: 'tool-output-available', toolCallId: 'c1', output: { output: 'all 42 passed\n', exitCode: 0 } } },
    // 2. Real Codex adapter fileChange sequence (`input.files` + `output.status` + `data-file-change` chunks)
    { runId: 'run-1', seq: 3, at: new Date(t2), chunk: { type: 'tool-input-available', toolCallId: 'c2', toolName: 'apply_patch', input: { files: ['lib/new.ts', 'lib/old.ts'] } } },
    { runId: 'run-1', seq: 4, at: new Date(t3), chunk: { type: 'tool-output-available', toolCallId: 'c2', output: { status: 'completed' } } },
    { runId: 'run-1', seq: 5, at: new Date(t3), chunk: { type: 'data-file-change', data: { path: 'lib/new.ts', change: 'added' } } },
    { runId: 'run-1', seq: 6, at: new Date(t3), chunk: { type: 'data-file-change', data: { path: 'lib/old.ts', change: 'deleted' } } },
    // 3. Failed Codex adapter fileChange (`output: { status: 'failed' }`)
    { runId: 'run-1', seq: 7, at: new Date(t3), chunk: { type: 'tool-input-available', toolCallId: 'c2f', toolName: 'apply_patch', input: { files: ['lib/bad.ts'] } } },
    { runId: 'run-1', seq: 8, at: new Date(t3), chunk: { type: 'tool-output-available', toolCallId: 'c2f', output: { status: 'failed' } } },
    // 4. Failed MCP tool call
    { runId: 'run-1', seq: 9, at: new Date(t3), chunk: { type: 'tool-input-available', toolCallId: 'c3', toolName: 'mcp__github__pull_request_read', input: { pullNumber: 3300 } } },
    { runId: 'run-1', seq: 10, at: new Date(t3 + 100), chunk: { type: 'tool-output-error', toolCallId: 'c3', errorText: 'GitHub rate limit exceeded' } },
    // 5. Exploration command with "Permission denied" in successful stdout (exitCode 0)
    { runId: 'run-1', seq: 11, at: new Date(t3 + 200), chunk: { type: 'tool-input-available', toolCallId: 'c4', toolName: 'Bash', input: { command: 'rg -n "denied" server.log' } } },
    { runId: 'run-1', seq: 12, at: new Date(t3 + 250), chunk: { type: 'tool-output-available', toolCallId: 'c4', output: { output: 'server.log:1:Permission denied', exitCode: 0 } } },
    // 6. Shell command printing JSON that happens to contain an `output` field (must not be double-unwrapped!)
    { runId: 'run-1', seq: 13, at: new Date(t3 + 300), chunk: { type: 'tool-input-available', toolCallId: 'c5', toolName: 'Bash', input: { command: 'node print-json.mjs' } } },
    { runId: 'run-1', seq: 14, at: new Date(t3 + 300), chunk: { type: 'tool-output-available', toolCallId: 'c5', toolDurationMs: 120, output: { output: '{"output":"inner","meta":42}', exitCode: 0 } } },
  ]

  const chunks = chainChunks(rawChunks)
  const items = await threadItems(chunks, [])
  const stepContext = extractThreadStepContext(chunks)
  const enriched = enrichMobileThreadItems(items, { active: false, contextByCallId: stepContext })

  assert.equal(enriched.length, 1)
  assert.equal(enriched[0].kind, 'steps')
  const [s1, s2, s2f, s3, s4, s5] = enriched[0].steps

  // Legacy ThreadStep contract preserved verbatim for older installed clients!
  assert.equal(s1.kind, 'shell')
  assert.equal(s1.status, 'ok')
  // Codex 1:1 additive projection fields
  assert.equal(s1.codexKind, 'exec')
  assert.equal(s1.codexStatus, 'completed')
  assert.equal(s1.command, 'pnpm test')
  assert.equal(s1.cwd, '/repo/mikka')
  assert.equal(s1.exitCode, 0)
  assert.equal(s1.aggregatedOutput, 'all 42 passed\n')
  assert.equal(s1.startedAtMs, t0)
  assert.equal(s1.completedAtMs, t1)
  assert.equal(s1.durationMs, 2450)

  // Real Codex multi-file patch events preserved individually with add/delete kinds!
  assert.equal(s2.kind, 'edit')
  assert.equal(s2.codexKind, 'edit')
  assert.equal(s2.codexStatus, 'completed')
  assert.deepEqual(s2.fileChanges, [
    { path: 'lib/new.ts', changeKind: 'add' },
    { path: 'lib/old.ts', changeKind: 'delete' },
  ])
  assert.deepEqual(s2.fileChange, { path: 'lib/new.ts', changeKind: 'add' })

  // Failed Codex apply_patch output `{ status: 'failed' }` surfaces as failed!
  assert.equal(s2f.codexKind, 'edit')
  assert.equal(s2f.codexStatus, 'failed')
  assert.deepEqual(s2f.fileChanges, [{ path: 'lib/bad.ts', changeKind: 'update' }])

  // Failed MCP call
  assert.equal(s3.kind, 'other')
  assert.equal(s3.status, 'failed')
  assert.equal(s3.codexKind, 'mcp')
  assert.equal(s3.codexStatus, 'failed')
  assert.equal(s3.server, 'github')
  assert.equal(s3.tool, 'pull_request_read')
  assert.equal(s3.error, 'GitHub rate limit exceeded')
  assert.deepEqual(s3.arguments, { pullNumber: 3300 })

  // Successful search containing "Permission denied" stays completed, never declined!
  assert.equal(s4.kind, 'shell')
  assert.equal(s4.status, 'ok')
  assert.equal(s4.codexKind, 'search')
  assert.equal(s4.codexStatus, 'completed')
  assert.equal(s4.query, 'denied')
  assert.equal(s4.path, 'server.log')
  assert.equal(s4.aggregatedOutput, 'server.log:1:Permission denied')

  // JSON stdout with `output` key is NOT double-unwrapped, and single-batch timing aligns with toolDurationMs!
  assert.equal(s5.aggregatedOutput, '{"output":"inner","meta":42}')
  assert.equal(s5.durationMs, 120)
  assert.equal(s5.completedAtMs, t3 + 300)
  assert.equal(s5.startedAtMs, t3 + 300 - 120)
})

test('enrichMobileThreadStep computes Edit line diffs past 1024-char prefix and handles oversized inputs via chunk context', () => {
  const unchangedPrefix = Array.from({ length: 40 }, (_, i) => `const unchangedLine_${i} = '${'x'.repeat(30)}'`).join('\n')
  const oldStr = `${unchangedPrefix}\nconst target = 'before'`
  const newStr = `${unchangedPrefix}\nconst target = 'after'\nconst extra = true`
  assert.ok(unchangedPrefix.length > 1300)

  const editFromSerialized = enrichMobileThreadStep({
    id: 'e1',
    name: 'Edit',
    detail: 'src/button.tsx',
    failed: false,
    kind: 'edit',
    status: 'ok',
    target: 'src/button.tsx',
    input: JSON.stringify({ file_path: 'src/button.tsx', old_string: oldStr, new_string: newStr }),
  })
  assert.equal(editFromSerialized.codexKind, 'edit')
  assert.equal(editFromSerialized.fileChange?.path, 'src/button.tsx')
  assert.equal(editFromSerialized.fileChange?.linesRemoved, 1)
  assert.equal(editFromSerialized.fileChange?.linesAdded, 2)

  // Even when `step.input` is omitted (exceeded 8192-char legacy thread preview), chunk context computes exact diff stats!
  const editFromOversizedChunk = enrichMobileThreadStep(
    {
      id: 'e2',
      name: 'Edit',
      detail: 'src/large.tsx',
      failed: false,
      kind: 'edit',
      status: 'ok',
      target: 'src/large.tsx',
    },
    {
      context: {
        rawInput: { file_path: 'src/large.tsx', old_string: oldStr, new_string: newStr },
      },
    },
  )
  assert.equal(editFromOversizedChunk.fileChange?.linesRemoved, 1)
  assert.equal(editFromOversizedChunk.fileChange?.linesAdded, 2)

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

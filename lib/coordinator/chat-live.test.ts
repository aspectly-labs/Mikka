import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const hostedWeb = resolve('.hosted-ui/web')

test('the chat reads on its live key, never on a timer', t => {
  const file = resolve(hostedWeb, 'components/coordinator/coordinator-chat.tsx')
  if (!existsSync(file)) { t.skip('.hosted-ui not checked out'); return }
  const source = readFileSync(file, 'utf8')
  assert.match(source, /useLiveKey\('bot_chat',/)
  assert.doesNotMatch(source, /refreshInterval/)
})

test('migrated lists use shared invalidation while the fallback interval remains one minute', t => {
  // Lists read on push only; the one-minute read is the live layer's fallback while its socket is down.
  assert.match(readFileSync('lib/live/channel.ts', 'utf8'), /export const LIVE_FALLBACK_MS = 60_000/)
  assert.doesNotMatch(readFileSync('components/swr-defaults.tsx', 'utf8'), /POLL_MS|refreshInterval/)
  if (!existsSync(hostedWeb)) { t.skip('.hosted-ui not checked out'); return }
  // Actual React + SWR tests in .hosted-ui/web/tests/scripts/use-live-lists.live.test.tsx cover
  // healthy silence beyond 60 s, push, foreground catch-up and owner changes.
  for (const [rel, hooks] of [
    ['components/nav/bot-list.tsx', ['useLiveBotChatList', 'useLiveGroupList']],
    ['components/workspace/issue-workspace.tsx', ['useLiveIssueList', 'useLiveThreadList', 'useLiveBotRoster', 'useLiveGroupList']],
    ['components/workspace/board-page.tsx', ['useLiveTaskRunList']],
  ] as const) {
    const file = resolve(hostedWeb, rel)
    const source = readFileSync(file, 'utf8')
    for (const hook of hooks) assert.ok(source.includes(hook + '('), file + ': ' + hook)
    assert.doesNotMatch(source, /refreshInterval\s*:/, file)
  }
})

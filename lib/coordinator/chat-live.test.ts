import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { officialUiSkip } from '../../scripts/official-ui-requirement.mjs'

const hostedWeb = resolve('.hosted-ui/web')

test('the chat reads on its live key, never on a timer', t => {
  const file = resolve(hostedWeb, 'components/coordinator/coordinator-chat.tsx')
  const missing = officialUiSkip(existsSync(file), '.hosted-ui')
  if (missing) { t.skip(missing); return }
  const source = readFileSync(file, 'utf8')
  assert.match(source, /useLiveKey\('bot_chat',/)
  assert.doesNotMatch(source, /refreshInterval/)
})

test('migrated lists use shared invalidation while the fallback interval remains one minute', t => {
  // Lists read on push only; the one-minute read is the live layer's fallback while its socket is down.
  assert.match(readFileSync('lib/live/channel.ts', 'utf8'), /export const LIVE_FALLBACK_MS = 60_000/)
  const missing = officialUiSkip(existsSync(hostedWeb), '.hosted-ui')
  if (missing) { t.skip(missing); return }
  // The site's SWR defaults moved to the official UI checkout's core/ (decision 2026-11-24-1000).
  assert.doesNotMatch(readFileSync(resolve(hostedWeb, '../core/components/swr-defaults.tsx'), 'utf8'), /POLL_MS|refreshInterval/)
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

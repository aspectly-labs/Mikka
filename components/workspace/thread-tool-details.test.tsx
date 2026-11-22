import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

// Alex, 2026-11-22: an opened tool call is one panel that reads as what it did, as LobeHub's and Claude Code's
// renderers; nothing twice, no 原始数据, no 输入 / 输出 boxes for known tools.
mock.module('@/lib/intl/i18n-client', { namedExports: {
  useLocale: () => 'zh-CN',
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
} })
mock.module('@/components/agents/file-diff', { namedExports: { FileDiff: (props: { file: string }) => <div data-file-diff={props.file} /> } })

const { ThreadToolDetails } = await import('./thread-tool-details')
const html = (props: Parameters<typeof ThreadToolDetails>[0]) => renderToStaticMarkup(<ThreadToolDetails {...props} />)
const panels = (out: string) => out.match(/data-thread-tool-details=""/g)?.length ?? 0
const once = (out: string, text: string) => out.split(text).length - 1

test('a file read is one panel of code: no path title (the row has it), no labels, no JSON', () => {
  const out = html({ kind: 'read', target: 'lib/auth/redirect.ts', input: '{"path":"lib/auth/redirect.ts"}', output: '{"type":"text","value":"export function readRedirect() {}"}', status: 'done' })
  assert.match(out, /data-thread-tool-file/)
  assert.equal(panels(out), 1)
  assert.match(out, /readRedirect/)
  assert.doesNotMatch(out, />lib\/auth\/redirect\.ts</, 'the path is on the row, not repeated')
  assert.doesNotMatch(out, /card\.args|card\.result</)
  assert.doesNotMatch(out, /&quot;path&quot;/)
})

test('a command is its command then its output; no Shell title, no status glyph, no exit line (the row says it)', () => {
  const out = html({ kind: 'shell', command: 'pnpm test', output: 'ok', exitCode: 1, status: 'failed' })
  assert.match(out, /data-thread-terminal/)
  assert.equal(panels(out), 1)
  assert.doesNotMatch(out, /card\.shell|card\.exitCode|card\.succeeded|<svg/)
})

test('a search shows its matches; an edit its diff', () => {
  const search = html({ kind: 'search', target: 'readRedirect', output: 'a.ts:1:readRedirect\nb.ts:2:readRedirect' })
  assert.equal(search.match(/<li /g)?.length, 2)
  const edit = html({ kind: 'edit', target: 'lib/a.ts', input: JSON.stringify({ file_path: 'lib/a.ts', old_string: 'a', new_string: 'b' }) })
  assert.match(edit, /data-thread-tool-diff/)
})

test('another tool, as AI Elements\' Tool: Parameters only when the row lacks them, then Result or Error, each once', () => {
  const plain = html({ kind: 'other', target: 'ALEX-45', input: JSON.stringify({ identifier: 'ALEX-45' }), output: '找到 1 个任务' })
  assert.equal(panels(plain), 1)
  assert.doesNotMatch(plain, /card\.args/, 'the row already shows the only parameter')
  assert.equal(once(plain, 'Coordinator.activity.card.result'), 1)
  assert.equal(once(plain, '找到 1 个任务'), 1)
  const more = html({ kind: 'other', target: 'ALEX-45', input: JSON.stringify({ identifier: 'ALEX-45', limit: 5 }), output: '{"ok":true}' })
  assert.equal(once(more, 'Coordinator.activity.card.args'), 1)
  assert.doesNotMatch(more, /<dl|<dt/, 'no key/value table')
  const failed = html({ kind: 'other', output: 'rate limited', status: 'failed' })
  assert.equal(once(failed, 'Coordinator.activity.card.error'), 1)
})

test('no raw data anywhere', () => {
  for (const props of [{ kind: 'other' as const, input: '{"q":"x"}', output: '{"ok":true}' }, { kind: 'read' as const, target: 'a.ts', output: 'x' }]) {
    const out = html(props)
    assert.doesNotMatch(out, /data-thread-tool-raw|detail\.raw|trace-collapsible/)
  }
})

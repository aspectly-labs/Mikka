import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

// Alex, 2026-11-22: an opened tool call reads as what it did; the raw JSON waits, folded, under 原始数据.
mock.module('@/lib/intl/i18n-client', { namedExports: {
  useLocale: () => 'zh-CN',
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
} })
mock.module('@/components/agents/file-diff', { namedExports: { FileDiff: (props: { file: string }) => <div data-file-diff={props.file} /> } })

const { ThreadToolDetails } = await import('./thread-tool-details')
const html = (props: Parameters<typeof ThreadToolDetails>[0]) => renderToStaticMarkup(<ThreadToolDetails {...props} />)
const RAW = 'Coordinator.activity.detail.raw'

test('a file read shows the file\'s code under its path, not the call\'s JSON', () => {
  const out = html({ kind: 'read', target: 'lib/auth/redirect.ts', input: '{"path":"lib/auth/redirect.ts"}', output: '{"type":"text","value":"export function readRedirect() {}"}', status: 'done' })
  assert.match(out, /data-thread-tool-file/)
  assert.match(out, />lib\/auth\/redirect\.ts</)
  assert.match(out, /readRedirect/)
  assert.doesNotMatch(out, /Coordinator\.activity\.card\.args/, 'no 参数 heading over JSON')
})

test('a search shows its matches; an edit its diff; another tool its inputs as a list and its output as text', () => {
  const search = html({ kind: 'search', target: 'readRedirect', output: 'a.ts:1:readRedirect\nb.ts:2:readRedirect' })
  assert.equal(search.match(/<li /g)?.length, 2)
  const edit = html({ kind: 'edit', target: 'lib/a.ts', input: JSON.stringify({ file_path: 'lib/a.ts', old_string: 'a', new_string: 'b' }) })
  assert.match(edit, /data-thread-tool-diff/, 'the diff view (loaded on open) stands in place of the JSON')
  const other = html({ kind: 'other', input: JSON.stringify({ identifier: 'ALEX-45' }), output: '找到 1 个任务' })
  assert.match(other, /<dt[^>]*>identifier<\/dt><dd[^>]*>ALEX-45<\/dd>/)
  assert.match(other, /<p[^>]*>找到 1 个任务<\/p>/)
  assert.doesNotMatch(other, /\{&quot;identifier&quot;/, 'the input JSON is not shown open')
})

test('the raw input and output are there, folded under 原始数据', () => {
  const out = html({ kind: 'other', input: '{"identifier":"ALEX-45"}', output: '{"ok":true}' })
  assert.match(out, new RegExp(`data-thread-tool-raw[^>]*>.*${RAW.replace(/\./g, '\\.')}`, 's'))
  assert.match(out, /data-closed=""[^>]*data-thread-tool-raw=""[^>]*><button[^>]*aria-expanded="false"/, 'closed until opened')
  assert.doesNotMatch(out.slice(out.indexOf('data-thread-tool-raw')), /ALEX-45/, 'the raw JSON is not rendered while folded')
})

test('a command keeps its Shell box, with no raw data under it', () => {
  const out = html({ kind: 'shell', command: 'pnpm test', output: 'ok', exitCode: 0, status: 'done' })
  assert.match(out, /data-thread-terminal/)
  assert.doesNotMatch(out, /data-thread-tool-raw/)
})

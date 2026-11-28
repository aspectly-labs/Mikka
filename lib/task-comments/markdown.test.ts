import assert from 'node:assert/strict'
import test from 'node:test'
import { issueContentToMarkdown } from './markdown'

test('mobile Task descriptions keep native mention display labels without exporting identities', () => {
  const nodes = [
    { type: 'text', text: 'Ask ' },
    { type: 'mention', attrs: { id: 'test-account-id', label: 'A*[Ren]' } },
    { type: 'text', text: ' today' },
    { type: 'mention', attrs: { id: 'legacy-account-id' } },
  ]
  const paragraph = { type: 'paragraph', content: nodes }
  const doc = { type: 'doc', content: [paragraph, { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph] }] }] }
  const mobile = issueContentToMarkdown(doc, { mentionLabels: true })
  const visible = String.raw`Ask @A\*\[Ren\] today`
  assert.equal(mobile, visible + '\n\n- ' + visible)
  assert.doesNotMatch(mobile, /test-account-id|legacy-account-id/)
  assert.equal(issueContentToMarkdown(doc), 'Ask  today\n\n- Ask  today')
})

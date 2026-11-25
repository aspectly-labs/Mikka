import assert from 'node:assert/strict'
import test from 'node:test'
import { extractLegacyOpenUIMarkdown, isLegacyOpenUIReply } from '../../lib/legacy-chat-content.ts'
import { CHATS } from './chats.mjs'
import { CHATS as CHATS_EN } from './chats-en.mjs'

const placeholder = (text: string) => text.replace(/\{\{\w+:[\w-]+\}\}/g, '11111111-1111-4111-8111-111111111111')
const replies = [
  ...Object.entries(CHATS),
  ...Object.entries(CHATS_EN).map(([bot, messages]) => [`en:${bot}`, messages] as const),
].flatMap(([bot, messages]) => messages
  .filter(message => message.role === 'assistant')
  .map(message => ({
    bot,
    text: placeholder((message.content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('\n\n')),
  })))

test('every demo assistant reply is non-empty and any historical OpenUI sample projects cleanly to readable Markdown', () => {
  assert.ok(replies.length > 0)
  for (const { bot, text } of replies) {
    assert.ok(text.trim().length > 0, bot)
    if (isLegacyOpenUIReply(text)) {
      const projected = extractLegacyOpenUIMarkdown(text)
      assert.ok(projected !== null, `${bot}: legacy OpenUI reply must project without throwing`)
      assert.doesNotMatch(projected, /^\s*root\s*=/m, `${bot}: projected fallback must not leak root assignment`)
    }
  }
})

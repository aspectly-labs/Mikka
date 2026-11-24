// A pick that did not save names the model and why; the chip keeps the saved one (Figma 843:2 #3).
import assert from 'node:assert/strict'
import test from 'node:test'
import { choiceFailureLine } from '../lib/model-choice.ts'
import { mobileLocale } from '../lib/messages.ts'

const zh = mobileLocale === 'zh-CN'

test('each refusal reads as its reason, anything else as no connection', () => {
  assert.equal(choiceFailureLine('claude-sonnet-5-5', 'modelUnavailable'), zh ? '没换成 claude-sonnet-5-5：这个模型现在不可用' : 'Couldn’t switch to claude-sonnet-5-5: This model isn’t available right now')
  assert.equal(choiceFailureLine('deepseek-chat', 'botNotFound'), zh ? '没换成 deepseek-chat：找不到这个 bot' : 'Couldn’t switch to deepseek-chat: Can’t find this bot')
  assert.equal(choiceFailureLine('deepseek-chat', 'invalidModel'), zh ? '没换成 deepseek-chat：需要更新 App' : 'Couldn’t switch to deepseek-chat: Update the app')
  assert.equal(choiceFailureLine('Mikka 默认', null), zh ? '没换成 Mikka 默认：连不上 Mikka' : 'Couldn’t switch to Mikka 默认: Can’t reach Mikka')
})

// A reply slow to start says so after 30 seconds, with the time it has waited (Figma 843:2 #1).
import assert from 'node:assert/strict'
import test from 'node:test'
import { waitingLabel } from '../lib/waiting.ts'
import { mobileLocale } from '../lib/messages.ts'

const zh = mobileLocale === 'zh-CN'

test('the spinner stays alone for the first 30 seconds, then counts', () => {
  assert.equal(waitingLabel(0, 29_999), null)
  assert.equal(waitingLabel(0, 30_000), zh ? '等待回复 · 30 秒' : 'Waiting for a reply · 30 s')
  assert.equal(waitingLabel(0, 72_400), zh ? '等待回复 · 1 分 12 秒' : 'Waiting for a reply · 1 min 12 s')
  assert.equal(waitingLabel(0, 120_000), zh ? '等待回复 · 2 分 0 秒' : 'Waiting for a reply · 2 min 0 s')
})

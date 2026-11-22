import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chatStampText } from './chat-time-stamps'

test('the stamp says today or yesterday with the clock, and the date beyond that', () => {
  const words = { today: (time: string) => `今天 ${time}`, yesterday: (time: string) => `昨天 ${time}` }
  const now = new Date(2026, 10, 22, 18, 0).getTime()
  assert.equal(chatStampText(new Date(2026, 10, 22, 14, 32).getTime(), now, 'zh-CN', words), '今天 14:32')
  assert.equal(chatStampText(new Date(2026, 10, 21, 9, 5).getTime(), now, 'zh-CN', words), '昨天 9:05')
  const english = { today: (time: string) => `Today ${time}`, yesterday: (time: string) => `Yesterday ${time}` }
  assert.equal(chatStampText(new Date(2026, 10, 22, 14, 32).getTime(), now, 'en', english), 'Today 2:32 PM')
  // Within six days the weekday names it, as Capy's message times do.
  const week = chatStampText(new Date(2026, 10, 17, 14, 32).getTime(), now, 'en', english)
  assert.match(week, /^Tue,? 2:32/)
  assert.equal(chatStampText(new Date(2026, 10, 17, 14, 32).getTime(), now, 'zh-CN', words), '周二 14:32')
  const earlier = chatStampText(new Date(2026, 10, 3, 14, 32).getTime(), now, 'en', english)
  assert.match(earlier, /Nov 3/)
  assert.match(earlier, /2:32/)
  assert.doesNotMatch(earlier, /2026/, 'this year needs no year')
  assert.match(chatStampText(new Date(2025, 0, 3, 14, 32).getTime(), now, 'en', english), /2025/)
})

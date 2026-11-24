// A cited thread's icon follows the group the server decided, never the run's raw status (R-52).
import assert from 'node:assert/strict'
import test from 'node:test'
import { runIcon } from '../lib/thread-icon.ts'
import { mobileLocale } from '../lib/messages.ts'

const zh = mobileLocale === 'zh-CN'

test('the server group decides the icon, whatever the raw status says', () => {
  assert.equal(runIcon({ status: 'succeeded', group: 'blocked' } as { group: 'blocked' }), 'failed')
  assert.equal(runIcon({ status: 'failed', group: 'idle' } as { group: 'idle' }), 'stopped')
  assert.equal(runIcon({ group: 'resolved' }), 'done')
  assert.equal(runIcon({ group: 'waiting' }), 'waiting')
  assert.equal(runIcon({ group: 'running' }), 'running')
})

test('a lost or queued run without a group never spins', () => {
  assert.equal(runIcon({}), 'waiting')
})

// Alex, 2026-11-04: a task and a thread never look alike. A thread is a bubble whose dot is its state, with the state's word.
test('a thread\'s dot follows its status, and names it for the screen reader', async () => {
  const { threadDot } = await import('../lib/thread-icon.ts')
  assert.deepEqual(threadDot('running'), { dot: 'running', label: zh ? '进行中' : 'Running' })
  assert.deepEqual(threadDot('waiting'), { dot: 'waiting', label: zh ? '等待你' : 'Waiting for you' })
  assert.deepEqual(threadDot('failed'), { dot: 'blocked', label: zh ? '受阻' : 'Blocked' })
  assert.deepEqual(threadDot('paused'), { dot: 'blocked', label: zh ? '受阻' : 'Blocked' }, 'a run paused on its quota is 受阻 (R-52)')
  assert.deepEqual(threadDot('stopped'), { dot: 'idle', label: zh ? '空闲' : 'Idle' })
  assert.deepEqual(threadDot('done'), { dot: 'resolved', label: zh ? '已解决' : 'Resolved' })
})

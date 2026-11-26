import test from 'node:test'
import assert from 'node:assert/strict'

import { desktopCandidateReason, desktopMentionUpdate, desktopMergeUpdate, desktopNotifyQuestions, desktopRunUpdate, type DesktopGroup, type DesktopRun, type DesktopThread } from './desktop-notifications'

function run(overrides: Partial<DesktopRun> = {}): DesktopRun {
  return {
    issueId: 'issue-1',
    runId: `run-${overrides.issueId ?? 'issue-1'}`,
    issueTitle: 'Ship the desktop app',
    agentName: 'Coordinator',
    status: 'running',
    ...overrides,
  }
}

test('the launch snapshot seeds the badge without replaying notifications', () => {
  const update = desktopRunUpdate(null, [
    run({ issueId: 'a', status: 'waiting_input' }),
    run({ issueId: 'b', status: 'failed' }),
    run({ issueId: 'c', status: 'running' }),
  ])
  assert.equal(update.badge, 1)
  assert.deepEqual(update.notifications, [])
  assert.deepEqual(update.next, new Map([['a', 'waiting_input'], ['b', 'failed'], ['c', 'running']]))
})

test('entering 等你 and failing raise one notification each', () => {
  const previous = new Map<string, DesktopRun['status']>([['a', 'running'], ['b', 'running'], ['c', 'succeeded']])
  const update = desktopRunUpdate(previous, [
    run({ issueId: 'a', status: 'waiting_input' }),
    run({ issueId: 'b', status: 'failed' }),
    run({ issueId: 'c', status: 'succeeded' }),
  ], 1_000)
  assert.equal(update.badge, 1)
  assert.deepEqual(update.notifications, [
    { id: 'run:a:awaiting:1000', kind: 'awaiting', title: 'Ship the desktop app', body: 'Coordinator', href: '/?issue=a&thread=run-a' },
    { id: 'run:b:failed:1000', kind: 'failed', title: 'Ship the desktop app', body: 'Coordinator', href: '/?issue=b&thread=run-b' },
  ])
})

test('an unchanged poll stays silent', () => {
  const previous = new Map<string, DesktopRun['status']>([['a', 'waiting_input'], ['b', 'failed']])
  const update = desktopRunUpdate(previous, [
    run({ issueId: 'a', status: 'waiting_input' }),
    run({ issueId: 'b', status: 'failed' }),
  ])
  assert.equal(update.badge, 1)
  assert.deepEqual(update.notifications, [])
})

test('a run that appears after launch can notify', () => {
  const update = desktopRunUpdate(new Map(), [run({ issueId: 'new', status: 'waiting_input' })], 1_000)
  assert.deepEqual(update.notifications.map(item => item.id), ['run:new:awaiting:1000'])
})

test('runs that disappear only update the map', () => {
  const update = desktopRunUpdate(new Map<string, DesktopRun['status']>([['gone', 'waiting_input']]), [])
  assert.equal(update.badge, 0)
  assert.deepEqual(update.notifications, [])
  assert.equal(update.next.size, 0)
})

test('a finished thread notifies the desktop when 线程完成 is on', () => {
  const previous = new Map<string, DesktopRun['status']>([['a', 'running'], ['b', 'succeeded']])
  const update = desktopRunUpdate(previous, [
    run({ issueId: 'a', status: 'succeeded' }),
    run({ issueId: 'b', status: 'succeeded' }),
  ], 2_000, true)
  assert.deepEqual(update.notifications, [
    { id: 'run:a:finished:2000', kind: 'finished', title: 'Ship the desktop app', body: 'Coordinator', href: '/?issue=a&thread=run-a' },
  ])
})

test('a finished thread stays silent on the desktop when 线程完成 is off', () => {
  const previous = new Map<string, DesktopRun['status']>([['a', 'running']])
  assert.deepEqual(desktopRunUpdate(previous, [run({ issueId: 'a', status: 'succeeded' })], 2_000, false).notifications, [])
  assert.deepEqual(desktopRunUpdate(previous, [run({ issueId: 'a', status: 'succeeded' })], 2_000).notifications, [])
})

test('the launch snapshot never replays finished threads', () => {
  assert.deepEqual(desktopRunUpdate(null, [run({ issueId: 'a', status: 'succeeded' })], 2_000, true).notifications, [])
})

test('whether a transition raises a notification is the Decisions API\'s answer, per candidate', async () => {
  const { desktopNotifyQuestions, readDesktopNotify } = await import('./desktop-notifications')
  const candidates = [
    { id: 'run:a:awaiting:1', kind: 'awaiting' as const, title: 'Ship the desktop app', agent: 'Coordinator' },
    { id: 'run:b:failed:1', kind: 'failed' as const, title: 'Retry flaky job', agent: 'Coordinator' },
  ]
  const questions = desktopNotifyQuestions(candidates)
  assert.deepEqual(questions.map(question => question.name), ['show0', 'show1'])
  assert.match(questions[0].instructions, /is waiting for the person/)
  const answers = new Map([['show0', { type: 'predicate' as const, name: 'show0', probability: 0.2 }], ['show1', { type: 'predicate' as const, name: 'show1', probability: 0.9 }]])
  // A run waiting on the person is not shown just because of its state; a failure the model flags is.
  assert.deepEqual(readDesktopNotify(answers, candidates), ['run:b:failed:1'])
  // No answer shows nothing.
  assert.deepEqual(readDesktopNotify(null, candidates), [])
})

function thread(overrides: Partial<DesktopThread> = {}): DesktopThread {
  return { id: 'run-1', issueId: 'issue-1', agentName: 'Codex', prompt: 'Fix the login page\nmore', title: null, pullState: 'open', ...overrides }
}

test('a thread whose pull request merges raises one notification; the first read and already-merged threads do not', () => {
  const baseline = desktopMergeUpdate(null, [thread({ pullState: 'merged' })])
  assert.deepEqual(baseline.notifications, [])
  const previous = new Map<string, DesktopThread['pullState'] | null>([['run-1', 'open'], ['run-2', 'merged']])
  const update = desktopMergeUpdate(previous, [
    thread(),
    thread({ id: 'run-1', pullState: 'merged', title: 'Login fix' }),
    thread({ id: 'run-2', pullState: 'merged' }),
    thread({ id: 'run-3', pullState: 'merged' }),
  ].slice(1))
  assert.deepEqual(update.notifications, [
    { id: 'merged:run-1', kind: 'merged', title: 'Login fix', body: 'Codex', href: '/?issue=issue-1&thread=run-1' },
  ])
  assert.equal(desktopMergeUpdate(new Map([['run-1', 'open']]), [thread({ pullState: 'merged' })]).notifications[0]?.title, 'Fix the login page')
})

function group(lastMessage: Partial<NonNullable<DesktopGroup['lastMessage']>> | null, id = GROUP): DesktopGroup {
  return {
    id, title: 'Release crew',
    lastMessage: lastMessage && { id: 'm-1', conversationId: id, position: '1', authorType: 'user', authorId: 'u-2', body: '@Alex can you check?', mentions: [{ memberType: 'user', memberId: 'u-1' }], replyToId: null, createdAt: '2026-11-25T00:00:00Z', ...lastMessage },
  }
}

const GROUP = '0b9f6c1e-1111-4a6b-8c3d-000000000001'

test('a new group message that @-mentions the person raises one notification', () => {
  assert.deepEqual(desktopMentionUpdate(null, [group({})], 'u-1').notifications, [])
  const update = desktopMentionUpdate(new Map([[GROUP, 'm-0']]), [group({})], 'u-1')
  assert.deepEqual(update.notifications, [
    { id: 'mentioned:m-1', kind: 'mentioned', title: 'Release crew', body: '@Alex can you check?', href: `/?group=${GROUP}` },
  ])
  assert.deepEqual(update.next, new Map([[GROUP, 'm-1']]))
  // The same message again, the person's own message, and a message naming someone else stay quiet.
  assert.deepEqual(desktopMentionUpdate(new Map([[GROUP, 'm-1']]), [group({})], 'u-1').notifications, [])
  assert.deepEqual(desktopMentionUpdate(new Map([[GROUP, 'm-0']]), [group({ authorId: 'u-1' })], 'u-1').notifications, [])
  assert.deepEqual(desktopMentionUpdate(new Map([[GROUP, 'm-0']]), [group({ mentions: [{ memberType: 'bot', memberId: 'u-1' }] })], 'u-1').notifications, [])
  // A group the person was just added to, opening with a mention, counts.
  assert.equal(desktopMentionUpdate(new Map(), [group({}, 'g-2')], 'u-1').notifications.length, 1)
})

test('mentions and merged pull requests ride the 等你 switch and get their own question', () => {
  assert.equal(desktopCandidateReason('mentioned'), 'decide')
  assert.equal(desktopCandidateReason('merged'), 'decide')
  const [mentioned, merged] = desktopNotifyQuestions([
    { id: 'a', kind: 'mentioned', title: 'Release crew', agent: 'Sam' },
    { id: 'b', kind: 'merged', title: 'Login fix', agent: 'Codex' },
  ])
  assert.match(mentioned!.instructions, /Sam mentioned the person in the group chat "Release crew"/)
  assert.match(merged!.instructions, /pull request of the thread "Login fix" \(Codex\) was just merged/)
})

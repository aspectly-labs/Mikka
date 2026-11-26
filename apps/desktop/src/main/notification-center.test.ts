import test from 'node:test'
import assert from 'node:assert/strict'

import { NotificationCenter, deniedByOs, type NotificationSink } from './notification-center'

function recordingSink(supported = true) {
  const shown: { title: string; body: string; onClick: () => void }[] = []
  const badges: number[] = []
  const sink: NotificationSink = {
    isSupported: () => supported,
    show: (title, body, onClick) => { shown.push({ title, body, onClick }) },
    setBadge: count => { badges.push(count) },
  }
  return { sink, shown, badges }
}

const notification = (id: string) => ({
  id,
  kind: 'failed',
  title: 'MIK-1 · 失败',
  body: '构建任务',
  href: '/issue/mik-1',
})

test('shows each notification id once', () => {
  const recorder = recordingSink()
  const delivered: string[] = []
  const center = new NotificationCenter(recorder.sink, href => delivered.push(href), () => 0)
  center.show(notification('a'))
  center.show(notification('a'))
  assert.equal(recorder.shown.length, 1)
  recorder.shown[0].onClick()
  assert.deepEqual(delivered, ['/issue/mik-1'])
})

test('caps notifications at five per minute', () => {
  const recorder = recordingSink()
  const center = new NotificationCenter(recorder.sink, () => {}, () => 1_000)
  for (let index = 0; index < 6; index += 1) center.show(notification(String(index)))
  assert.equal(recorder.shown.length, 5)
})

test('allows a new notification after the window passes', () => {
  const recorder = recordingSink()
  let now = 1_000
  const center = new NotificationCenter(recorder.sink, () => {}, () => now)
  center.show(notification('a'))
  now += 61_000
  center.show(notification('b'))
  assert.equal(recorder.shown.length, 2)
})

test('does nothing where notifications are unsupported', () => {
  const recorder = recordingSink(false)
  const center = new NotificationCenter(recorder.sink, () => {}, () => 0)
  center.show(notification('a'))
  assert.equal(recorder.shown.length, 0)
})

test('refuses an invalid payload instead of showing it', () => {
  const recorder = recordingSink()
  const center = new NotificationCenter(recorder.sink, () => {}, () => 0)
  assert.throws(() => center.show({ id: 'a', kind: 'other', title: 'x', body: 'y', href: '/z' }))
  assert.throws(() => center.show({ id: 'a', kind: 'failed', title: 'x', body: 'y', href: 'https://evil.example' }))
  assert.equal(recorder.shown.length, 0)
})

test('badge counts are bounded', () => {
  const recorder = recordingSink()
  const center = new NotificationCenter(recorder.sink, () => {}, () => 0)
  center.setBadge(3)
  assert.deepEqual(recorder.badges, [3])
  assert.throws(() => center.setBadge(-1))
  assert.throws(() => center.setBadge(10_000))
})

test('a finished thread (线程完成) is a desktop notification kind', () => {
  const recorder = recordingSink()
  const delivered: string[] = []
  const center = new NotificationCenter(recorder.sink, href => delivered.push(href), () => 0)
  center.show({ ...notification('done'), kind: 'finished', title: 'Ship the desktop app', body: 'Coordinator' })
  assert.equal(recorder.shown.length, 1)
  assert.equal(recorder.shown[0].title, 'Ship the desktop app')
  recorder.shown[0].onClick()
  assert.deepEqual(delivered, ['/issue/mik-1'])
})

test('tracks whether the OS shows notifications from what it did with the last one', () => {
  const outcomes: { shown(): void; failed(error: string): void }[] = []
  const changes: string[] = []
  const sink: NotificationSink = {
    isSupported: () => true,
    show: (_title, _body, _onClick, outcome) => { if (outcome) outcomes.push(outcome) },
    setBadge: () => {},
  }
  const center = new NotificationCenter(sink, () => {}, () => 0, access => changes.push(access))
  assert.equal(center.access(), 'unknown')
  center.show(notification('a'))
  outcomes[0].failed('Notifications are not allowed for this application')
  assert.equal(center.access(), 'denied')
  center.show(notification('b'))
  outcomes[1].failed('timed out')
  assert.equal(center.access(), 'denied', 'a one-off failure does not flip the access')
  outcomes[1].shown()
  assert.equal(center.access(), 'granted')
  assert.deepEqual(changes, ['denied', 'granted'])
})

test('deniedByOs reads macOS and Windows refusals, not other failures', () => {
  assert.equal(deniedByOs('UNErrorCodeNotificationsNotAllowed'), true)
  assert.equal(deniedByOs('Notifications are not authorized'), true)
  assert.equal(deniedByOs('The notification platform is disabled'), true)
  assert.equal(deniedByOs('Failed to create toast XML'), false)
})

import test from 'node:test'
import assert from 'node:assert/strict'

import type { MenuItemConstructorOptions } from 'electron'
import { INBOX_HREF, THREADS_HREF, trayMenu, trayTitle } from './tray.ts'

function build(state: Parameters<typeof trayMenu>[0], locale = 'zh-CN') {
  const opened: string[] = []
  const calls: string[] = []
  const menu = trayMenu(state, locale, {
    openHref: href => { opened.push(href) },
    newThread: () => { calls.push('new') },
    openApp: () => { calls.push('open') },
  })
  return { menu, opened, calls }
}
const labels = (menu: MenuItemConstructorOptions[]) => menu.map(item => item.type === 'separator' ? '—' : item.label)
const click = (item: MenuItemConstructorOptions) => (item.click as unknown as () => void)()

test('the tray lists the waiting count, recent threads, New Thread, Open and Quit, as Capy and Codex do', () => {
  const threads = Array.from({ length: 6 }, (_, index) => ({ title: `Thread ${index + 1}`, href: `/?thread=${index + 1}` }))
  const { menu, opened, calls } = build({ signedIn: true, waiting: 2, threads: threads.slice(0, 5), hasMore: true })
  assert.deepEqual(labels(menu), ['2 个线程在等你', '—', '最近线程', 'Thread 1', 'Thread 2', 'Thread 3', 'Thread 4', 'Thread 5', '查看全部线程…', '—', '新建线程', '—', '打开 Mikka', '—', '退出 Mikka'])
  assert.equal(menu[2]!.enabled, false)
  click(menu[0]!)
  click(menu[3]!)
  click(menu[8]!)
  assert.deepEqual(opened, [INBOX_HREF, '/?thread=1', THREADS_HREF])
  click(menu[10]!)
  click(menu[12]!)
  assert.deepEqual(calls, ['new', 'open'])
  assert.equal(menu.at(-1)!.role, 'quit')
})

test('signed out, loading and empty trays say so; nothing waiting shows no count', () => {
  assert.deepEqual(labels(build({ signedIn: false, waiting: 3, threads: null, hasMore: false }).menu).slice(0, 1), ['登录后查看线程'])
  assert.deepEqual(labels(build({ signedIn: true, waiting: 0, threads: null, hasMore: false }).menu).slice(0, 1), ['正在加载线程…'])
  assert.deepEqual(labels(build({ signedIn: true, waiting: 0, threads: [], hasMore: false }, 'en').menu), ['No recent threads', '—', 'New Thread', '—', 'Open Mikka', '—', 'Quit Mikka'])
  assert.equal(labels(build({ signedIn: true, waiting: 1, threads: [], hasMore: false }, 'en').menu)[0], '1 thread needs you')
})

test('titles are cut at 48 characters and an empty one reads as untitled', () => {
  assert.equal(trayTitle('x'.repeat(60), 'Untitled thread'), `${'x'.repeat(47)}…`)
  assert.equal(trayTitle('  ', 'Untitled thread'), 'Untitled thread')
})

import test from 'node:test'
import assert from 'node:assert/strict'

import type { MenuItemConstructorOptions } from 'electron'
import type { DesktopMenuCommand } from '@mikka/protocol/bridge'
import { applicationMenu, menuAccelerators, menuCopy, newWindowMenuItem, unresponsiveChoice, unresponsiveCopy, type ApplicationMenuOptions } from './window-menu.ts'

test('New Window uses the standard shortcut and invokes only the supplied opener', () => {
  let opened = 0
  const item = newWindowMenuItem(() => { opened++ })

  assert.equal(item.label, 'New Window')
  assert.equal(item.accelerator, 'CommandOrControl+Shift+N')
  assert.equal(opened, 0)
  item.click()
  assert.equal(opened, 1)
})

test('menuCopy localizes native menubar entries for zh and en locales', () => {
  const zh = menuCopy('zh-CN')
  assert.equal(zh.file, '文件')
  assert.equal(zh.history, '历史')
  assert.equal(zh.newThread, '新建线程')
  assert.equal(zh.closeOtherTabs, '关闭其他标签页')
  assert.equal(zh.tab(3), '标签页 3')
  const en = menuCopy('en-US')
  assert.equal(en.settings, 'Settings…')
  assert.equal(en.reopenClosedTab, 'Reopen Closed Tab')
  assert.equal(newWindowMenuItem(() => {}, 'zh-Hans').label, '新建窗口')
})

function build(platform: NodeJS.Platform, overrides: Partial<ApplicationMenuOptions> = {}) {
  const sent: DesktopMenuCommand[] = []
  const calls: string[] = []
  const template = applicationMenu({
    platform, locale: 'en-US', appName: 'Mikka', packaged: true,
    command: command => { sent.push(command) },
    closeTab: () => { calls.push('closeTab') },
    newWindow: () => { calls.push('newWindow') },
    reload: () => { calls.push('reload') },
    checkForUpdates: () => { calls.push('updates') },
    openWebsite: () => { calls.push('website') },
    showLogs: () => { calls.push('logs') },
    zoomItems: [{ role: 'resetZoom' }],
    ...overrides,
  })
  return { template, sent, calls }
}

function find(template: readonly MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions {
  for (const item of template) {
    if (item.id === id) return item
    if (Array.isArray(item.submenu)) {
      try { return find(item.submenu, id) } catch { /* keep looking */ }
    }
  }
  throw new Error(`no menu item ${id}`)
}

const click = (item: MenuItemConstructorOptions) => (item.click as unknown as () => void)()

test('macOS menu bar: app menu with Settings…, File, Edit, View, History, Window, Help', () => {
  const { template } = build('darwin')
  assert.deepEqual(template.map(item => item.label ?? item.role), ['Mikka', 'File', 'Edit', 'View', 'History', 'Window', 'Help'])
  const appMenu = template[0].submenu as MenuItemConstructorOptions[]
  assert.ok(appMenu.some(item => item.id === 'mikka-settings' && item.accelerator === 'CommandOrControl+,'))
  assert.ok(appMenu.some(item => item.id === 'mikka-check-for-updates'))
})

test('Windows and Linux keep Settings and Quit in File and updates in Help', () => {
  const { template } = build('win32')
  assert.deepEqual(template.map(item => item.label ?? item.role), ['File', 'Edit', 'View', 'History', 'Window', 'Help'])
  assert.equal(find(template, 'mikka-settings').accelerator, 'CommandOrControl+,')
  assert.ok(find(template, 'mikka-check-for-updates'))
})

test('tab and history commands are menu accelerators sent to the focused window, so they work in a text field', () => {
  const { template, sent, calls } = build('darwin')
  const expectations: [string, string, DesktopMenuCommand][] = [
    ['mikka-new-tab', 'CommandOrControl+T', { type: 'tab.new' }],
    ['mikka-reopen-tab', 'CommandOrControl+Shift+T', { type: 'tab.reopen' }],
    ['mikka-close-other-tabs', 'CommandOrControl+Alt+W', { type: 'tab.closeOthers' }],
    ['mikka-copy-url', 'CommandOrControl+L', { type: 'tab.copyUrl' }],
    ['mikka-copy-url-alias', 'CommandOrControl+Shift+C', { type: 'tab.copyUrl' }],
    ['mikka-back', 'CommandOrControl+[', { type: 'history.back' }],
    ['mikka-forward', 'CommandOrControl+]', { type: 'history.forward' }],
    ['mikka-next-tab', 'Control+Tab', { type: 'tab.next' }],
    ['mikka-previous-tab', 'Control+Shift+Tab', { type: 'tab.previous' }],
    ['mikka-new-thread', 'CommandOrControl+Shift+O', { type: 'thread.new' }],
    ['mikka-settings', 'CommandOrControl+,', { type: 'settings.open' }],
  ]
  for (const [id, accelerator, command] of expectations) {
    const item = find(template, id)
    assert.equal(item.accelerator, accelerator, id)
    click(item)
    assert.deepEqual(sent.at(-1), command, id)
  }
  // ⌘W goes through main, which closes a child window instead of a tab.
  const close = find(template, 'mikka-close-tab')
  assert.equal(close.accelerator, 'CommandOrControl+W')
  click(close)
  assert.deepEqual(calls, ['closeTab'])
  click(find(template, 'mikka-duplicate-tab'))
  assert.deepEqual(sent.at(-1), { type: 'tab.duplicate' })
})

test('⌘1–⌘9 select tabs; aliases stay hidden but keep working', () => {
  const { template, sent } = build('darwin')
  for (let index = 1; index <= 9; index++) {
    const item = find(template, `mikka-select-tab-${index}`)
    assert.equal(item.accelerator, `CommandOrControl+${index}`)
    assert.equal(item.visible, false)
    assert.equal(item.acceleratorWorksWhenHidden, true)
    click(item)
    assert.deepEqual(sent.at(-1), { type: 'tab.select', index })
  }
  const alias = find(template, 'mikka-next-tab-alias')
  assert.equal(alias.accelerator, 'CommandOrControl+Alt+Right')
  assert.equal(alias.visible, false)
})

test('no two menu items claim the same shortcut', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const accelerators = menuAccelerators(build(platform).template)
    assert.deepEqual(accelerators.filter((value, index) => accelerators.indexOf(value) !== index), [], platform)
  }
})

test('development builds have no update item', () => {
  const { template } = build('darwin', { packaged: false })
  assert.throws(() => find(template, 'mikka-check-for-updates'))
})

test('the not-responding dialog offers wait, reload, logs and quit in that order', () => {
  assert.deepEqual(unresponsiveCopy('zh-CN').buttons, ['继续等待', '重新加载', '查看日志', '退出'])
  assert.equal(unresponsiveCopy('en').message, 'Mikka is not responding')
  assert.equal(unresponsiveChoice(0), 'wait')
  assert.equal(unresponsiveChoice(1), 'reload')
  assert.equal(unresponsiveChoice(2), 'logs')
  assert.equal(unresponsiveChoice(3), 'quit')
  assert.equal(unresponsiveChoice(-1), 'wait')
})

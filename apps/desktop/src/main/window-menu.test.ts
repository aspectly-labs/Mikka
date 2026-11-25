import test from 'node:test'
import assert from 'node:assert/strict'

import { menuCopy, newWindowMenuItem } from './window-menu.ts'

test('New Window uses the standard shortcut and invokes only the supplied opener', () => {
  let opened = 0
  const item = newWindowMenuItem(() => { opened++ })

  assert.equal(item.label, 'New Window')
  assert.equal(item.accelerator, 'CommandOrControl+Shift+N')
  assert.equal(opened, 0)
  item.click()
  assert.equal(opened, 1)
})

test('menuCopy and newWindowMenuItem localize native menubar entries for zh and en locales', () => {
  assert.deepEqual(menuCopy('zh-CN'), {
    file: '文件',
    edit: '编辑',
    view: '视图',
    window: '窗口',
    newWindow: '新建窗口',
    reload: '重新加载',
  })
  assert.deepEqual(menuCopy('en-US'), {
    file: 'File',
    edit: 'Edit',
    view: 'View',
    window: 'Window',
    newWindow: 'New Window',
    reload: 'Reload',
  })
  assert.equal(newWindowMenuItem(() => {}, 'zh-Hans').label, '新建窗口')
})

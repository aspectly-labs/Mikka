import assert from 'node:assert/strict'
import test from 'node:test'

const { displayTitle, withoutMachineIds } = await import('../lib/display-title.ts')

test('a leading issue key is not shown', () => {
  assert.equal(displayTitle('ALEX-12: 修复 iOS 登录回调'), '修复 iOS 登录回调')
  assert.equal(displayTitle('ALEX-1203 修复 iOS 登录回调'), '修复 iOS 登录回调')
  assert.equal(displayTitle('#1408 iOS 按 Comma 的布局重做'), 'iOS 按 Comma 的布局重做')
  assert.equal(displayTitle('[MIK-3] 设置页改用原生表单'), '设置页改用原生表单')
})

test('a trailing date or time stamp is not shown', () => {
  assert.equal(displayTitle('Factory review 2026-11-06'), 'Factory review')
  assert.equal(displayTitle('Factory review 2026-11-06 03:12'), 'Factory review')
  assert.equal(displayTitle('Factory review (2026-11-06T03:12:44Z)'), 'Factory review')
  assert.equal(displayTitle('周报 · 11/06 09:30'), '周报')
  assert.equal(displayTitle('nightly check 20261106-0312'), 'nightly check')
  assert.equal(displayTitle('ALEX-77: 生产部署回滚检查 2026-11-05 22:10'), '生产部署回滚检查')
})

test('the rest of the title is untouched', () => {
  assert.equal(displayTitle('提交 1.0.0 (7) 审核'), '提交 1.0.0 (7) 审核')
  assert.equal(displayTitle('PR #1459 设置页改用原生表单'), 'PR #1459 设置页改用原生表单')
  assert.equal(displayTitle('升级到 Node 24'), '升级到 Node 24')
  assert.equal(displayTitle('升级到 Expo 58.0'), '升级到 Expo 58.0')
  assert.equal(displayTitle('发布 v1.2.3'), '发布 v1.2.3')
  assert.equal(displayTitle('提交 1.0.0'), '提交 1.0.0')
})

test('a title that is only a key or a stamp keeps its text', () => {
  assert.equal(displayTitle('ALEX-12'), 'ALEX-12')
  assert.equal(displayTitle('2026-11-06'), '2026-11-06')
})

test('UUIDs and hashes are not shown (Alex 2026-11-24)', () => {
  assert.equal(displayTitle('Local native subscription acceptance codex 1243312c-6517-4386-a39d-3f56cdb1d0ff'), 'Local native subscription acceptance codex')
  assert.equal(displayTitle('codex-d8f3d3f2 artifact delivery'), 'codex artifact delivery')
  assert.equal(displayTitle('c38e7e 官方订阅真实复验：主机'), '官方订阅真实复验：主机')
  assert.equal(displayTitle('a84557：创建并验证纯文本'), '创建并验证纯文本')
  assert.equal(displayTitle('Official codex smoke c3f72167'), 'Official codex smoke')
  assert.equal(withoutMachineIds('Official 1146 codex delivery d8f3d3f2'), 'Official 1146 codex delivery')
})

test('words and versions that look like hex stay', () => {
  assert.equal(displayTitle('decade facade review'), 'decade facade review')
  assert.equal(displayTitle('发布 v1.2.3 到 1146 台设备'), '发布 v1.2.3 到 1146 台设备')
  assert.equal(displayTitle('c3f72167'), 'c3f72167')
})

test('a stamp with its time zone is not shown', () => {
  assert.equal(displayTitle('订阅验收 2026-11-02 21:02 UTC'), '订阅验收')
  assert.equal(displayTitle('云端订阅验收 2026-11-02 22:32 UTC'), '云端订阅验收')
})

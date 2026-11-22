import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSettingsPatch, resolveSettingValue, settingsSchema } from './registry'
import { keyboardShortcutConflicts, normalizeKeyboardShortcut } from '@mikka/protocol/keyboard-shortcuts'

test('inheritance retains explicit zero/empty overrides and falls through null to workspace or default', () => {
  assert.deepEqual(resolveSettingValue('archiveIdleAfterDays', 0, 7), { value: 0, source: 'personal' })
  assert.deepEqual(resolveSettingValue('archiveIdleAfterDays', null, 7), { value: 7, source: 'workspace' })
  assert.deepEqual(resolveSettingValue('archiveIdleAfterDays', null, null), { value: 30, source: 'default' })
  assert.deepEqual(resolveSettingValue('threadTitleInstructions', '', 'team'), { value: '', source: 'personal' })
  assert.deepEqual(resolveSettingValue('subagentMaxConcurrent', 20, null), { value: 6, source: 'default' })
})

test('server guards reject unknown fields, invalid scope, coercion and out-of-range values', () => {
  for (const values of [{ archiveIdleAfterDays: '7' }, { archiveIdleAfterDays: 4 }, { unknown: true }, { toString: 'x' }, { subagentMaxConcurrent: 3 }]) {
    assert.throws(() => parseSettingsPatch('personal', { values }))
  }
  for (const value of [0, 21, 1.5, '6', true]) assert.throws(() => parseSettingsPatch('workspace', { values: { subagentMaxConcurrent: value } }))
  assert.throws(() => parseSettingsPatch('personal', { userId: 'other', values: { archiveIdleAfterDays: 7 } }))
  assert.deepEqual(parseSettingsPatch('personal', { values: { archiveIdleAfterDays: null, threadTitleInstructions: '  own  ' } }),
    { archiveIdleAfterDays: null, threadTitleInstructions: 'own' })
})

test('public schema is serializable metadata with bilingual row search and no server guard', () => {
  const schema = JSON.parse(JSON.stringify(settingsSchema()))
  const row = schema.find((value: { key: string }) => value.key === 'archiveIdleAfterDays')
  assert.equal(row.label['zh-CN'], '归档闲置线程')
  assert.equal(row.page, 'threads')
  assert.ok(row.keywords.includes('archive'))
  assert.equal('guard' in row, false)
  assert.deepEqual(row.writeAccess, { personal: 'owner', workspace: 'admin' })
})

test('Git defaults retain explicit false and empty prefixes; review fields are administrator-only', () => {
  assert.deepEqual(resolveSettingValue('prAutoMerge', false, true), { value: false, source: 'personal' })
  assert.deepEqual(resolveSettingValue('prTitlePrefix', '', '[Team]'), { value: '', source: 'personal' })
  assert.deepEqual(resolveSettingValue('prBranchPrefix', null, 'team/fix'), { value: 'team/fix', source: 'workspace' })
  assert.deepEqual(resolveSettingValue('prBranchPrefix', null, null), { value: 'mikka', source: 'default' })
  for (const values of [{ prBranchPrefix: 'refs/../main' }, { prAutoMerge: 'true' }, { prTitlePrefix: 'text\u0000more' },
    { codeReviewModel: 'model with spaces' }, { codeReviewSeverity: 'all' }, { codeReviewIgnoredPaths: ['../secret'] }, { codeReviewOutput: 'approve' }]) {
    assert.throws(() => parseSettingsPatch('workspace', { values }))
  }
  for (const key of ['codeReviewModel', 'codeReviewSeverity', 'codeReviewIgnoredPaths', 'codeReviewOutput']) assert.throws(() => parseSettingsPatch('personal', { values: { [key]: null } }))
  assert.deepEqual(parseSettingsPatch('workspace', { values: { prBranchPrefix: 'team/fix/', codeReviewIgnoredPaths: ['vendor/**', 'vendor/**'] } }),
    { prBranchPrefix: 'team/fix', codeReviewIgnoredPaths: ['vendor/**'] })
})

test('keyboard bindings normalize aliases and physical keys while preserving navigation and disabling explicitly', () => {
  assert.equal(normalizeKeyboardShortcut(' shift + commandorcontrol + k '), 'Mod+Shift+KeyK')
  assert.equal(normalizeKeyboardShortcut('ctrl+,'), 'Ctrl+Comma')
  assert.equal(normalizeKeyboardShortcut('Command+F12'), 'Meta+F12')
  assert.equal(normalizeKeyboardShortcut(''), '')
  for (const value of ['Mod', 'Mod+Mod+K', 'Mod+Control+K', 'Mod++', 'Hyper+K', 'toString+K', '__proto__', 'constructor', 'Escape', 'Shift+Tab', 'ArrowDown', 'Shift+ArrowLeft', 'F5', 'Shift+F5', 'Mod+KeyR', 'Ctrl+Shift+R', 'Meta+R']) {
    assert.equal(normalizeKeyboardShortcut(value), null, value)
  }
  assert.equal(normalizeKeyboardShortcut('Alt+R'), 'Alt+KeyR')
  assert.deepEqual(parseSettingsPatch('personal', { values: { 'keyboardShortcuts.search.open': 'ctrl+k', 'keyboardShortcuts.theme.toggle': '' } }),
    { 'keyboardShortcuts.search.open': 'Ctrl+KeyK', 'keyboardShortcuts.theme.toggle': '' })
  assert.throws(() => parseSettingsPatch('workspace', { values: { 'keyboardShortcuts.search.open': 'Mod+K' } }))
  assert.throws(() => parseSettingsPatch('personal', { values: { 'keyboardShortcuts.unknown': 'Mod+K' } }))
  assert.throws(() => parseSettingsPatch('personal', { values: { 'keyboardShortcuts.search.open': { binding: 'Mod+K' } } }))
})

test('keyboard conflicts include untouched defaults and platform aliases but allow mutually exclusive surfaces', () => {
  assert.deepEqual(keyboardShortcutConflicts({}), [])
  assert.deepEqual(keyboardShortcutConflicts({ 'task.create': 'Mod+KeyK' }), [{
    actions: ['search.open', 'task.create'], bindings: ['Mod+KeyK', 'Mod+KeyK'], platforms: ['apple', 'other'],
  }])
  assert.deepEqual(keyboardShortcutConflicts({ 'task.create': 'Ctrl+KeyK' })[0].platforms, ['other'])
  assert.deepEqual(keyboardShortcutConflicts({ 'task.create': 'Meta+KeyK' })[0].platforms, ['apple'])
  assert.deepEqual(keyboardShortcutConflicts({ 'search.open': '', 'task.create': 'Mod+KeyK' }), [])
  assert.deepEqual(keyboardShortcutConflicts({ 'board.assistant.toggle': 'Mod+F2', 'details.toggle': 'Mod+F2', 'devices.add': 'Mod+F2' }), [])
  assert.deepEqual(keyboardShortcutConflicts({ 'task.create': 'Mod+F2', 'board.assistant.toggle': 'Mod+F2' })[0].actions, ['task.create', 'board.assistant.toggle'])
})

test('shortcut schema rows carry stable action IDs, bilingual search, context and default source', () => {
  const row = settingsSchema().find(field => field.action === 'devices.add')!
  assert.equal(row.key, 'keyboardShortcuts.devices.add')
  assert.equal(row.page, 'shortcuts'); assert.equal(row.group, 'keyboard_shortcuts')
  assert.equal(row.label['zh-CN'], '添加设备'); assert.ok(row.keywords.includes('computer'))
  assert.deepEqual(row.context, { scope: 'devices', editable: true, modal: true })
  assert.deepEqual(row.scope, ['personal']); assert.deepEqual(row.writeAccess, { personal: 'owner' })
  assert.deepEqual(resolveSettingValue(row.key, null, 'Mod+F3'), { value: 'Mod+KeyN', source: 'default' })
  assert.deepEqual(resolveSettingValue(row.key, '', null), { value: '', source: 'personal' })
})

test('gitAuthorName and gitAuthorEmail inherit across personal, workspace and default with strict guards', () => {
  assert.deepEqual(resolveSettingValue('gitAuthorName', null, null), { value: '', source: 'default' })
  assert.deepEqual(resolveSettingValue('gitAuthorName', null, 'Team Bot'), { value: 'Team Bot', source: 'workspace' })
  assert.deepEqual(resolveSettingValue('gitAuthorName', 'Alice', 'Team Bot'), { value: 'Alice', source: 'personal' })
  assert.deepEqual(resolveSettingValue('gitAuthorName', '', 'Team Bot'), { value: '', source: 'personal' })

  assert.deepEqual(resolveSettingValue('gitAuthorEmail', null, null), { value: '', source: 'default' })
  assert.deepEqual(resolveSettingValue('gitAuthorEmail', null, 'bot@team.example'), { value: 'bot@team.example', source: 'workspace' })
  assert.deepEqual(resolveSettingValue('gitAuthorEmail', 'alice@example.com', 'bot@team.example'), { value: 'alice@example.com', source: 'personal' })
  assert.deepEqual(resolveSettingValue('gitAuthorEmail', '', 'bot@team.example'), { value: '', source: 'personal' })

  assert.deepEqual(parseSettingsPatch('personal', { values: { gitAuthorName: '  Alice  ', gitAuthorEmail: '  alice@example.com  ' } }), {
    gitAuthorName: 'Alice',
    gitAuthorEmail: 'alice@example.com',
  })
  assert.deepEqual(parseSettingsPatch('workspace', { values: { gitAuthorName: '', gitAuthorEmail: '' } }), {
    gitAuthorName: '',
    gitAuthorEmail: '',
  })
  assert.deepEqual(parseSettingsPatch('personal', { values: { gitAuthorName: null, gitAuthorEmail: null } }), {
    gitAuthorName: null,
    gitAuthorEmail: null,
  })

  for (const invalid of [
    { gitAuthorName: '   ' },
    { gitAuthorName: 'x'.repeat(101) },
    { gitAuthorName: 'Alice <bob@example.com>' },
    { gitAuthorName: 'Alice\nBob' },
    { gitAuthorName: 42 },
    { gitAuthorEmail: '   ' },
    { gitAuthorEmail: 'not-an-email' },
    { gitAuthorEmail: 'alice@' },
    { gitAuthorEmail: 42 },
  ]) {
    assert.throws(() => parseSettingsPatch('personal', { values: invalid }))
    assert.throws(() => parseSettingsPatch('workspace', { values: invalid }))
  }

  const schema = settingsSchema()
  const nameEntry = schema.find(entry => entry.key === 'gitAuthorName')
  const emailEntry = schema.find(entry => entry.key === 'gitAuthorEmail')
  assert.ok(nameEntry && emailEntry)
  assert.equal(nameEntry.group, 'git')
  assert.equal(nameEntry.page, 'git')
  assert.equal(emailEntry.group, 'git')
  assert.equal(emailEntry.page, 'git')
  assert.deepEqual(nameEntry.scope, ['personal', 'workspace'])
  assert.deepEqual(emailEntry.scope, ['personal', 'workspace'])
  assert.equal(nameEntry.personalOverride, true)
  assert.equal(emailEntry.personalOverride, true)
  assert.equal(nameEntry.label['zh-CN'], '提交作者')
  assert.equal(emailEntry.label['zh-CN'], '提交邮箱')
})

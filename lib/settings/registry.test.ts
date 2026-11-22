import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSettingsPatch, resolveSettingValue, settingsSchema } from './registry'

test('inheritance retains explicit zero/empty overrides and falls through null to workspace or default', () => {
  assert.deepEqual(resolveSettingValue('archiveIdleAfterDays', 0, 7), { value: 0, source: 'personal' })
  assert.deepEqual(resolveSettingValue('archiveIdleAfterDays', null, 7), { value: 7, source: 'workspace' })
  assert.deepEqual(resolveSettingValue('archiveIdleAfterDays', null, null), { value: 30, source: 'default' })
  assert.deepEqual(resolveSettingValue('threadTitleInstructions', '', 'team'), { value: '', source: 'personal' })
  assert.deepEqual(resolveSettingValue('subagentMaxConcurrent', 20, null), { value: 6, source: 'default' })
  assert.deepEqual(resolveSettingValue('appearanceSync', null, true), { value: true, source: 'default' })
  assert.deepEqual(resolveSettingValue('appearanceSync', false, true), { value: false, source: 'personal' })
  assert.deepEqual(resolveSettingValue('appearanceTheme', null, 'oled'), { value: 'mikka', source: 'default' })
  assert.deepEqual(resolveSettingValue('appearanceTheme', 'oled', null), { value: 'oled', source: 'personal' })
  assert.deepEqual(resolveSettingValue('appearanceAccentColor', '#ff5500', null), { value: '#ff5500', source: 'personal' })
  assert.deepEqual(resolveSettingValue('sidebarPages', [], ['chats']), { value: [], source: 'personal' })
})

test('server guards reject unknown fields, invalid scope, coercion and out-of-range values', () => {
  for (const values of [
    { archiveIdleAfterDays: '7' }, { archiveIdleAfterDays: 4 }, { unknown: true }, { toString: 'x' }, { subagentMaxConcurrent: 3 },
    { appearanceColorScheme: 'sepia' }, { appearanceTheme: 'unknownTheme' }, { appearanceAccentColor: 'red' }, { appearanceAccentColor: '#12345' },
    { appearanceBackgroundEffect: 'blur' }, { codeFontSize: 'xl' }, { diffView: 'inline' }, { diffColors: 'mono' }, { hiddenFiles: 'hide' },
    { sidebarPages: ['invalid'] }, { sidebarLayout: 'tabs' }, { enterAction: 'send' }, { appearanceSync: 'false' },
  ]) {
    assert.throws(() => parseSettingsPatch('personal', { values }))
  }
  for (const key of ['appearanceSync', 'appearanceColorScheme', 'appearanceTheme', 'appearanceAccentColor', 'codeFontSize', 'diffView', 'diffColors', 'hiddenFiles', 'sidebarLayout']) {
    assert.throws(() => parseSettingsPatch('workspace', { values: { [key]: null } }), `${key} is personal-only`)
  }
  for (const value of [0, 21, 1.5, '6', true]) assert.throws(() => parseSettingsPatch('workspace', { values: { subagentMaxConcurrent: value } }))
  assert.throws(() => parseSettingsPatch('personal', { userId: 'other', values: { archiveIdleAfterDays: 7 } }))
  assert.deepEqual(parseSettingsPatch('personal', { values: { archiveIdleAfterDays: null, threadTitleInstructions: '  own  ' } }),
    { archiveIdleAfterDays: null, threadTitleInstructions: 'own' })
  assert.deepEqual(parseSettingsPatch('personal', {
    values: {
      appearanceSync: false, appearanceColorScheme: 'dark', appearanceTheme: 'oled', appearanceAccentColor: '#7aa2ff',
      appearanceBackgroundEffect: 'none', codeFontSize: 'large', diffView: 'split', diffColors: 'blue', hiddenFiles: 'all',
      sidebarPages: ['chats', 'board'], sidebarLayout: 'columns', pinPages: true,
    },
  }), {
    appearanceSync: false, appearanceColorScheme: 'dark', appearanceTheme: 'oled', appearanceAccentColor: '#7aa2ff',
    appearanceBackgroundEffect: 'none', codeFontSize: 'large', diffView: 'split', diffColors: 'blue', hiddenFiles: 'all',
    sidebarPages: ['chats', 'board'], sidebarLayout: 'columns', pinPages: true,
  })
})

test('public schema is serializable metadata with bilingual row search and no server guard', () => {
  const schema = JSON.parse(JSON.stringify(settingsSchema()))
  const row = schema.find((value: { key: string }) => value.key === 'archiveIdleAfterDays')
  assert.equal(row.label['zh-CN'], '归档闲置线程')
  assert.equal(row.page, 'threads')
  assert.ok(row.keywords.includes('archive'))
  assert.equal('guard' in row, false)
  assert.deepEqual(row.writeAccess, { personal: 'owner', workspace: 'admin' })
  const appearance = schema.find((value: { key: string }) => value.key === 'appearanceTheme')
  assert.equal(appearance.page, 'appearance')
  assert.equal(appearance.group, 'appearance')
  assert.equal(appearance.label['zh-CN'], '配色主题')
  assert.deepEqual(appearance.scope, ['personal'])
  assert.deepEqual(appearance.writeAccess, { personal: 'owner' })
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

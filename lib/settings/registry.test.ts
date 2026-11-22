import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSettingsPatch, resolveSettingValue, settingsSchema } from './registry'

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

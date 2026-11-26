import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SETTINGS_ITEM_STATUS,
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_STATUS,
  WIDE_SETTINGS_SECTIONS,
  isSettingsSectionParam,
  resolveSettingsSection,
  settingItemPending,
  settingItemShown,
  settingItemStatus,
  settingSectionStatus,
  settingsHref,
  visibleSettingsSections,
  withPendingSuffix,
} from '../lib/settings-sections.ts'

test('the settings sidebar separates personal, connections and compute, Agent, and workspace settings', () => {
  const sections = visibleSettingsSections({ admin: true, cloudAdmin: true, memory: true })
  const ids = group => sections.filter(section => section.group === group).map(section => section.id)
  assert.equal(new Set(sections.map(section => section.id)).size, sections.length)
  assert.deepEqual(ids('personal'), ['preferences', 'appearance', 'account', 'security', 'notifications', 'shortcuts', 'privacy'])
  assert.deepEqual(ids('compute'), ['models', 'environments', 'computers', 'secrets', 'integrations', 'connections', 'developer'])
  assert.deepEqual(ids('agent'), ['instructions', 'team-skills', 'threads', 'git', 'agent-configs', 'agent-permissions', 'memory'])
  assert.deepEqual(ids('review'), [])
  assert.deepEqual(ids('workspace'), ['general', 'identity', 'issue-states', 'members', 'teams', 'billing', 'usage', 'activity', 'audit', 'cloud'])
})

test('old links keep landing on the page that now holds their content, and deleted bot-permissions is not a legacy alias', () => {
  for (const [old, now] of [['profile', 'account'], ['integrations', 'integrations'], ['permissions', 'agent-permissions'], ['devices', 'computers'], ['workspace', 'general'], ['memory', 'memory'], ['privacy', 'privacy']]) {
    assert.equal(resolveSettingsSection('/settings', old), now, old)
  }
  assert.equal(isSettingsSectionParam('bot-permissions'), false)
  assert.equal(resolveSettingsSection('/settings', 'bot-permissions'), 'preferences')
})

test('routed pages win over the query, and unknown input falls back to preferences', () => {
  assert.equal(resolveSettingsSection('/settings/members', 'security'), 'members')
  assert.equal(resolveSettingsSection('/settings/teams', null), 'teams')
  assert.equal(resolveSettingsSection('/settings', 'nope'), 'preferences')
  assert.equal(resolveSettingsSection('/settings', null), 'preferences')
  assert.equal(resolveSettingsSection('/settings', 'notifications'), 'notifications')
})

test('hrefs keep the workspace, support extra query params, and use the routed paths for members and teams', () => {
  assert.equal(settingsHref('security', 'w1'), '/settings?workspace=w1&section=security')
  assert.equal(settingsHref('members', 'w1'), '/settings/members?workspace=w1')
  assert.equal(settingsHref('preferences'), '/settings?section=preferences')
  assert.equal(settingsHref('teams'), '/settings/teams')
  assert.equal(settingsHref('teams', undefined, { create: '1' }), '/settings/teams?create=1')
  assert.equal(settingsHref('teams', 'w1', { create: '1' }), '/settings/teams?workspace=w1&create=1')
  assert.equal(settingsHref('security', 'w1', { tab: '2fa', empty: undefined }), '/settings?workspace=w1&section=security&tab=2fa')
})

const PENDING_SECTIONS = []
const SKIPPED_SECTIONS = ['review-repositories', 'review-config', 'referrals', 'experiments', 'cloud-credentials']
const SIDEBAR_OFF = ['logins', 'mcp', 'permissions', 'organization']

test('centralized 3-tier status governs section and item presentation', () => {
  for (const id of PENDING_SECTIONS) assert.equal(settingSectionStatus(id), 'pending', id)
  for (const id of SKIPPED_SECTIONS) assert.equal(settingSectionStatus(id), 'skipped', id)
  assert.equal(settingItemStatus('environments.networkAccess'), 'available')
  assert.equal(settingItemShown('environments.networkAccess'), true)
  assert.equal(settingItemStatus('shortcuts.customizeBindings'), 'available')
  assert.equal(settingItemStatus('workspace.newWorkVisibility'), 'available')
  assert.equal(settingItemStatus('workspace.workVisibility'), 'available')
  assert.equal(settingItemStatus('workspace.allowPrivate'), 'available')
  assert.equal(settingItemShown('threads.subagentDepth'), false)
  assert.equal(settingItemShown('appearance.myThemes'), false)
  assert.equal(settingItemShown('appearance.dashboardBackground'), false)
  assert.equal(settingItemPending('threads.subagentMaxConcurrent'), false)
  assert.equal(SETTINGS_ITEM_STATUS['appearance.sync'], 'available')
  assert.equal(withPendingSuffix('嵌套深度', '待接入'), '嵌套深度 · 待接入')
  assert.deepEqual([...WIDE_SETTINGS_SECTIONS], ['shortcuts', 'environments', 'members', 'teams', 'usage', 'activity', 'audit'])
})

test('members do not see admin-only sections; admins see every built one', () => {
  const member = visibleSettingsSections({ admin: false }).map(s => s.id)
  for (const id of ['general', 'members', 'teams', 'computers', 'usage', 'billing', 'environments']) assert.equal(member.includes(id), true, id)
  for (const id of SIDEBAR_OFF) assert.equal(member.includes(id), false, id)
  for (const id of ['agent-permissions', 'identity', 'audit']) assert.equal(member.includes(id), false, id)
  assert.deepEqual(visibleSettingsSections({ admin: true, memory: true }).map(s => s.id), SETTINGS_SECTIONS.filter(s => SETTINGS_SECTION_STATUS[s.id] === 'available' && !SIDEBAR_OFF.includes(s.id) && s.id !== 'cloud').map(s => s.id))
})

test('cloud server settings require the explicit server administrator capability', () => {
  for (const admin of [false, true]) {
    assert.equal(visibleSettingsSections({ admin }).some(s => s.id === 'cloud'), false)
    assert.equal(visibleSettingsSections({ admin, cloudAdmin: false }).some(s => s.id === 'cloud'), false)
    assert.equal(visibleSettingsSections({ admin, cloudAdmin: true }).some(s => s.id === 'cloud'), true)
  }
  assert.deepEqual(visibleSettingsSections({ admin: true, cloudAdmin: true, memory: true }).map(s => s.id), SETTINGS_SECTIONS.filter(s => SETTINGS_SECTION_STATUS[s.id] === 'available' && !SIDEBAR_OFF.includes(s.id)).map(s => s.id))
})

test('identity and access is limited to team admins, and organization remains reachable through its direct link', () => {
  for (const admin of [false, true]) {
    for (const organization of [false, true]) {
      const team = visibleSettingsSections({ admin, organization }).map(s => s.id)
      assert.equal(team.includes('identity'), admin)
      assert.equal(team.includes('organization'), false)
      const personal = visibleSettingsSections({ admin, organization, personal: true }).map(s => s.id)
      for (const teamOnly of ['identity', 'organization', 'members', 'teams', 'permissions', 'audit']) assert.equal(personal.includes(teamOnly), false, teamOnly)
    }
  }
  assert.equal(isSettingsSectionParam('organization'), true)
  assert.equal(resolveSettingsSection('/settings', 'organization'), 'organization')
})

test('pending sections without a page body are hidden until their UI lands, and their links open preferences', () => {
  assert.deepEqual(SETTINGS_SECTIONS.filter(s => s.unbuilt).map(s => s.id), PENDING_SECTIONS)
  for (const admin of [false, true]) for (const id of PENDING_SECTIONS) assert.equal(visibleSettingsSections({ admin }).some(s => s.id === id), false, `${id} admin=${admin}`)
  for (const id of PENDING_SECTIONS) {
    assert.equal(resolveSettingsSection('/settings', id), 'preferences', id)
    assert.equal(isSettingsSectionParam(id), true, `${id} is still a known link`)
  }
})

test('skipped pages (05/06/13 and UI-only 20/21) are not links and never appear', () => {
  assert.deepEqual(SETTINGS_SECTIONS.filter(s => s.withheld).map(s => s.id), SKIPPED_SECTIONS)
  for (const id of SKIPPED_SECTIONS) {
    assert.equal(visibleSettingsSections({ admin: true, cloudAdmin: true, organization: true }).some(s => s.id === id), false, id)
    assert.equal(isSettingsSectionParam(id), false, id)
    assert.equal(resolveSettingsSection('/settings', id), 'preferences', id)
  }
})

test('English search titles distinguish integrations, connectors and MCP, and Agent permissions', () => {
  const title = id => SETTINGS_SECTIONS.find(s => s.id === id).title
  assert.deepEqual(['computers', 'developer', 'environments', 'secrets', 'integrations', 'connections', 'mcp', 'agent-permissions', 'logins'].map(title), ['Devices', 'API', 'Cloud environments', 'Secrets & Credentials', 'Integrations', 'Connectors and MCP', 'Custom MCP', 'Agent permissions', 'Secrets and logins'])
  // `?section=mcp` stays a valid direct URL opening the Connectors and MCP page’s Custom MCP tab.
  assert.equal(isSettingsSectionParam('mcp'), true)
  assert.equal(resolveSettingsSection('/settings', 'mcp'), 'mcp')
})

test('a current id wins over a legacy alias with the same name', () => {
  assert.equal(resolveSettingsSection('/settings', 'account'), 'account')
  assert.equal(resolveSettingsSection('/settings', 'profile'), 'account')
})

test('a personal workspace has every setting of the workspace itself; only what is between people is a team\'s', () => {
  const personal = visibleSettingsSections({ admin: true, personal: true, memory: true }).map(s => s.id)
  const account = SETTINGS_SECTIONS.filter(s => ['personal', 'compute', 'agent'].includes(s.group) && SETTINGS_SECTION_STATUS[s.id] === 'available' && s.sidebar !== false).map(s => s.id)
  assert.deepEqual(personal, [...account, 'general', 'issue-states', 'billing', 'usage', 'activity'])
  const team = visibleSettingsSections({ admin: true }).map(s => s.id)
  for (const id of ['general', 'identity', 'members', 'teams', 'environments', 'secrets', 'agent-permissions', 'audit', 'usage', 'activity', 'billing']) assert.ok(team.includes(id), id)
  assert.equal(team.includes('logins'), false)
})

test('记忆 shows only while the memory PostHog flag is on', () => {
  for (const admin of [false, true]) for (const personal of [false, true]) {
    assert.equal(visibleSettingsSections({ admin, personal }).some(s => s.id === 'memory'), false, `admin=${admin} personal=${personal}`)
    assert.equal(visibleSettingsSections({ admin, personal, memory: false }).some(s => s.id === 'memory'), false)
    assert.equal(visibleSettingsSections({ admin, personal, memory: true }).some(s => s.id === 'memory'), true)
  }
})

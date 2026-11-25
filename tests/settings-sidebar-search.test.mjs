import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { settingsItemVisible } from '../lib/settings-sidebar-search.ts'
import { visibleSettingsSections } from '../lib/settings-sections.ts'

const en = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8')).Settings
const zh = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8')).Settings
const workspaceItem = { groupTitle: 'Workspace', groupLabel: zh.groups.workspace, itemTitle: 'General', label: zh.sections.general.title, section: 'general', routed: false }

test('zh-CN 下中文标题与英文名都能搜到工作区', () => {
  for (const query of [zh.sections.general.title, 'General', 'general', '  GENER ', zh.groups.workspace]) assert.equal(settingsItemVisible({ ...workspaceItem, query }), true, query)
  assert.equal(settingsItemVisible({ ...workspaceItem, query: 'zzz-no-match' }), false)
})

test('团队、成员在每个设置页都列出，搜索不改变该规则', () => {
  for (const [section, itemTitle, label] of [['teams', 'Teams', zh.sections.teams.title], ['members', 'Members', zh.sections.members.title]]) {
    const item = { groupTitle: 'Workspace', groupLabel: zh.groups.workspace, itemTitle, label, section }
    for (const query of ['', label, itemTitle]) {
      assert.equal(settingsItemVisible({ ...item, query, routed: false }), true, `${section} listed: ${query}`)
      assert.equal(settingsItemVisible({ ...item, query, routed: true }), true, `${section} routed: ${query}`)
    }
  }
  const workspace = { groupTitle: 'Workspace', groupLabel: zh.groups.workspace, itemTitle: 'General', label: zh.sections.general.title, section: 'general', query: '' }
  assert.equal(settingsItemVisible({ ...workspace, routed: false }), true)
})

test('模型订阅在集成页：额度、quota、ChatGPT、Claude、Codex、订阅都能搜到', () => {
  const integrations = { groupTitle: 'Workspace', groupLabel: 'x', itemTitle: 'Models', label: zh.sections.models.title, keywords: zh.sections.models.keywords, section: 'models', routed: false }
  for (const query of ['额度', 'quota', 'ChatGPT', 'chatgpt', 'Claude', 'Codex', '订阅', '模型订阅']) assert.equal(settingsItemVisible({ ...integrations, query }), true, query)
  const other = { ...integrations, itemTitle: 'General', label: zh.sections.general.title, keywords: '', section: 'general' }
  for (const query of ['额度', 'quota', 'Claude']) assert.equal(settingsItemVisible({ ...other, query }), false, query)
})

test('MCP Servers / Custom MCP / 自定义 MCP / MCP 服务器 search matches unified Plugins (connections) without a second sidebar entry', () => {
  const visible = visibleSettingsSections({ admin: true })
  assert.equal(visible.some(s => s.id === 'mcp'), false)
  const pluginsSection = visible.find(s => s.id === 'connections')
  assert.ok(pluginsSection)
  const zhPlugins = {
    groupTitle: 'Agent & Compute',
    groupLabel: zh.groups.agent,
    itemTitle: pluginsSection.title,
    label: zh.sections.connections.title,
    keywords: zh.sections.connections.keywords,
    section: 'connections',
  }
  const enPlugins = {
    groupTitle: 'Agent & Compute',
    groupLabel: en.groups.agent,
    itemTitle: pluginsSection.title,
    label: en.sections.connections.title,
    keywords: en.sections.connections.keywords,
    section: 'connections',
  }
  for (const query of ['MCP Servers', 'Custom MCP', 'MCP 服务器', '自定义 MCP', 'Plugins', '插件', 'Integrations', '集成']) {
    assert.equal(settingsItemVisible({ ...zhPlugins, query }), true, `zh: ${query}`)
  }
  for (const query of ['MCP Servers', 'Custom MCP', 'Plugins', 'Integrations', 'mcp']) {
    assert.equal(settingsItemVisible({ ...enPlugins, query }), true, `en: ${query}`)
  }
})

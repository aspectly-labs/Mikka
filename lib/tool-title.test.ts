import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { toolTitle } from './tool-title'

// Alex, 2026-11-22: a tool row names its tool in English, in title form, whatever the UI language; never the raw
// identifier with its underscores, never a Chinese translation that differs from the thread's.
const REAL: [name: string, title: string][] = [
  // Claude Code
  ['Read', 'Read file'], ['Bash', 'Run command'], ['Grep', 'Search'], ['Glob', 'Find files'], ['Edit', 'Edit file'], ['MultiEdit', 'Edit file'],
  ['Write', 'Write file'], ['WebFetch', 'Fetch web page'], ['WebSearch', 'Web search'], ['Task', 'Start subagent'], ['TodoWrite', 'Update todos'],
  ['NotebookEdit', 'Edit notebook'], ['BashOutput', 'Read command output'],
  // Codex
  ['shell', 'Run command'], ['exec_command', 'Run command'], ['apply_patch', 'Edit file'], ['update_plan', 'Update plan'], ['read_file', 'Read file'],
  ['view_image', 'View image'],
  // Mikka's Bot (Coordinator)
  ['get_issue', 'Get issue'], ['dispatch_run', 'Dispatch run'], ['list_runs', 'List runs'], ['send_to_run', 'Send to run'], ['web_search', 'Web search'],
  ['read_webpage', 'Read webpage'], ['search_gmail', 'Search Gmail'], ['send_slack_message', 'Send Slack message'], ['github_tools', 'GitHub tools'],
  // MCP, without a declared title
  ['mcp__github__pull_request_read', 'Pull request read'], ['mcp__linear__create_issue', 'Create issue'], ['mcp__context7__get-library-docs', 'Get library docs'],
]

test('every real tool name reads as English words, without underscores or the mcp__ prefix', () => {
  for (const [name, title] of REAL) {
    const shown = toolTitle(name)
    assert.equal(shown, title, name)
    assert.doesNotMatch(shown, /[_]|mcp/i, name)
    assert.doesNotMatch(shown, /\p{Script=Han}/u, `${name} is not translated`)
  }
})

test('an MCP tool shows the title it declared; a declared name with underscores is spelled out instead', () => {
  assert.equal(toolTitle('mcp__notion__notion-search', 'Search Notion'), 'Search Notion')
  assert.equal(toolTitle('github_call', 'GitHub · Create issue'), 'GitHub · Create issue')
  assert.equal(toolTitle('mcp__x__do_thing', 'do_thing'), 'Do thing')
  // A coding agent's own tool keeps its one name, whatever a catalogue calls it.
  assert.equal(toolTitle('Read', 'Read'), 'Read file')
})

test('no locale translates tool names: the Bot chat and threads share the English title', () => {
  for (const locale of ['en', 'zh-CN']) {
    const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'))
    assert.equal(messages.Coordinator.activity.tools, undefined, `${locale} has no Coordinator.activity.tools`)
  }
  const source = readFileSync(new URL('../components/coordinator/reply-activity.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /`tools\.\$\{/, 'reply-activity does not look tool names up in the messages')
})

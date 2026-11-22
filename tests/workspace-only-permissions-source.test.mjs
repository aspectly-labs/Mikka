import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const ROOTS = ['lib', 'app', 'components', 'workflows']
/** The legacy owner ceiling and the fold helper are the only readers of a head's policy columns. */
const POLICY_COLUMN_ALLOWED = new Set(['lib/operations/write-policy-store.ts', 'lib/coordinator/coordinator-bot.ts'])

function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...sourceFiles(file))
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) out.push(file)
  }
  return out
}

const files = ROOTS.flatMap(sourceFiles)
const source = Object.fromEntries(files.map(file => [file, readFileSync(join(root, file), 'utf8')]))

test('no source still offers a per-Bot or per-worker permission layer', () => {
  for (const [file, text] of Object.entries(source)) {
    assert.doesNotMatch(text, /\bset_write_policy\b/, `${file} still accepts the per-Bot command`)
    assert.doesNotMatch(text, /view=write_policy\b/, `${file} still offers the per-Bot view`)
    assert.doesNotMatch(text, /resolveScopedWritePermission/, `${file} still merges a second layer`)
    if (!POLICY_COLUMN_ALLOWED.has(file) && text.includes('agent_kit_heads')) {
      for (const match of text.matchAll(/agent_kit_heads/g)) {
        const window = text.slice(Math.max(0, match.index - 240), match.index + 240)
        assert.doesNotMatch(window, /external_write_permissions|cli_run_policy/, `${file} still reads or writes a head policy column`)
      }
    }
  }
})

test('the retired 应用与运行权限 settings page and slot are gone', () => {
  for (const retired of [
    'components/settings/bot-permissions.tsx',
    'components/slots/settings-bot-permissions.tsx',
    'components/slots/settings-bot-permissions-contract.ts',
  ]) {
    assert.equal(existsSync(join(root, retired)), false, `${retired} still exists`)
  }
})

test('the browser gate takes the workspace layer only', () => {
  const visual = source['lib/cloud-computer/visual-contract.ts']
  assert.match(visual, /export function browserPermission\(effect: BrowserEffect, computer: 'allow'\|'deny', workspace: unknown\)/)
  const authority = source['lib/cloud-computer/browser-authority.ts']
  assert.doesNotMatch(authority, /agent_kit_heads/)
  assert.match(authority, /browserPermission\(effect,computer,workspace\)/)
})

test('every first-class write path reads the workspace app policy, not only the 允许使用的应用 block', () => {
  const steps = source['workflows/coordinator/steps.ts']
  assert.match(steps, /writeAccountAction\(userId, action, input, accountId, botId \?\? null\)/)
  const store = source['lib/pending-action-store.ts']
  assert.match(store, /botId: string \| null = null/)
  const keys = readFileSync(join(root, 'lib/operations/app-permission-keys.ts'), 'utf8')
  for (const action of ['send_email', 'create_calendar_event', 'update_calendar_event']) {
    assert.match(keys, new RegExp(`^\\s*${action}: '(gmail|googlecalendar)'`, 'm'), `${action} is in the workspace key map`)
  }
  const pending = source['lib/pending-actions.ts']
  assert.match(pending, /approvalPolicyBlock\(userId, row\)/)
  assert.match(pending, /botMayUseApp\(row\.botId, toolkit, userId\)/)
})

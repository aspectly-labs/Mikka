import assert from 'node:assert/strict'
import test from 'node:test'
import { approvalRuleKey, approvedWriteRuleMatch, decisionNote, destructiveAppTool, pendingActionRuleMatch, ruleBotId } from './approval-rules'
import { writeTarget } from './write-contract'

const mail = (to: string[], extra: Record<string, unknown> = {}) => ({ action: 'send_email', input: { to, subject: 'Hi', body: 'One', ...extra }, connectedAccountId: 'ca_mail' })

test('a mail rule covers the same account and the same recipients, whatever the text', () => {
  const rule = pendingActionRuleMatch(mail(['Kim@Acme.dev', 'lee@acme.dev']))
  assert.deepEqual(rule, { action: 'send_email', account: 'ca_mail', recipients: ['kim@acme.dev', 'lee@acme.dev'] })
  // Order, case and a different subject or body do not change what it covers.
  assert.equal(approvalRuleKey(pendingActionRuleMatch({ ...mail(['lee@acme.dev', 'kim@acme.dev']), input: { to: ['lee@acme.dev', 'KIM@acme.dev'], subject: 'Other', body: 'Two' } })!), approvalRuleKey(rule!))
  // Another recipient, an extra cc, or another account is another rule.
  for (const other of [mail(['kim@acme.dev']), mail(['kim@acme.dev', 'lee@acme.dev'], { cc: ['boss@acme.dev'] }), { ...mail(['kim@acme.dev', 'lee@acme.dev']), connectedAccountId: 'ca_other' }]) {
    assert.notEqual(approvalRuleKey(pendingActionRuleMatch(other)!), approvalRuleKey(rule!))
  }
  assert.equal(pendingActionRuleMatch({ ...mail(['kim@acme.dev']), connectedAccountId: null }), null, 'no account, nothing to bind')
  assert.equal(pendingActionRuleMatch(mail([])), null)
})

test('calendar rules bind the account, the attendees and, for a change, the event', () => {
  const create = pendingActionRuleMatch({ action: 'create_calendar_event', input: { summary: 'Sync', start: 'a', end: 'b' }, connectedAccountId: 'ca_cal' })
  assert.deepEqual(create, { action: 'create_calendar_event', account: 'ca_cal', attendees: [] })
  const invite = pendingActionRuleMatch({ action: 'create_calendar_event', input: { summary: 'Sync', attendees: ['x@acme.dev'] }, connectedAccountId: 'ca_cal' })
  assert.notEqual(approvalRuleKey(invite!), approvalRuleKey(create!))
  const update = pendingActionRuleMatch({ action: 'update_calendar_event', input: { event_id: 'e1', summary: 'Moved' }, connectedAccountId: 'ca_cal' })
  assert.deepEqual(update, { action: 'update_calendar_event', account: 'ca_cal', eventId: 'e1', attendees: null })
  assert.notEqual(approvalRuleKey(pendingActionRuleMatch({ action: 'update_calendar_event', input: { event_id: 'e2', summary: 'Moved' }, connectedAccountId: 'ca_cal' })!), approvalRuleKey(update!))
  assert.notEqual(approvalRuleKey(pendingActionRuleMatch({ action: 'update_calendar_event', input: { event_id: 'e1', attendees: ['y@acme.dev'] }, connectedAccountId: 'ca_cal' })!), approvalRuleKey(update!))
})

test('an app tool rule is one tool in one app on one account; destructive tools are never remembered', () => {
  const call = (tool: string, toolkit = 'hubspot') => ({ action: 'app_tool_call', input: { toolkit, tool, name: tool, version: 'v1', arguments: { a: 1 } }, connectedAccountId: 'ca_h' })
  const rule = pendingActionRuleMatch(call('HUBSPOT_CREATE_CONTACT'))
  assert.deepEqual(rule, { action: 'app_tool_call', toolkit: 'hubspot', tool: 'HUBSPOT_CREATE_CONTACT', account: 'ca_h' })
  assert.notEqual(approvalRuleKey(pendingActionRuleMatch(call('HUBSPOT_UPDATE_CONTACT'))!), approvalRuleKey(rule!))
  for (const slug of ['HUBSPOT_DELETE_CONTACT', 'GITHUB_MERGE_A_PULL_REQUEST', 'STRIPE_CREATE_REFUND', 'GOOGLEDRIVE_SHARE_FILE', 'HUBSPOT_BATCH_ARCHIVE']) {
    const toolkit = slug.split('_')[0].toLowerCase()
    assert.equal(pendingActionRuleMatch(call(slug, toolkit)), null, slug)
  }
  assert.equal(pendingActionRuleMatch(call('SLACK_SEND_MESSAGE', 'hubspot')), null, 'a tool outside its app is never remembered')
  assert.equal(destructiveAppTool('HUBSPOT_CREATE_CONTACT', ['destructiveHint']), true)
  assert.equal(destructiveAppTool('SLACK_SEND_MESSAGE'), false)
})

test('high-risk actions are never remembered', () => {
  for (const action of ['browser_operation', 'credential_operation', 'cancel_calendar_event', 'unknown_action']) {
    assert.equal(pendingActionRuleMatch({ action, input: { event_id: 'e1', summary: 's' }, connectedAccountId: 'ca' }), null, action)
  }
  assert.equal(approvedWriteRuleMatch({ action: 'cancel_calendar_event', provider: 'composio', accountId: 'ca', target: writeTarget('cancel_calendar_event', { event_id: 'e1' }) }), null)
})

test('an approved-write rule binds the ledger target: one channel or one page, never another', () => {
  const channel = (id: string) => approvedWriteRuleMatch({ action: 'send_slack_message', provider: 'composio', accountId: 'ca_s', target: writeTarget('send_slack_message', { channel: id, text: 'x' }) })
  assert.ok(channel('C1'))
  assert.equal(approvalRuleKey(channel('C1')!), approvalRuleKey(approvedWriteRuleMatch({ action: 'send_slack_message', provider: 'composio', accountId: 'ca_s', target: writeTarget('send_slack_message', { channel: 'C1', text: 'other text' }) })!))
  assert.notEqual(approvalRuleKey(channel('C2')!), approvalRuleKey(channel('C1')!))
  assert.equal(approvedWriteRuleMatch({ action: 'send_slack_message', provider: 'composio', accountId: 'ca_s', target: 'append_notion_paragraph:abc' }), null, 'a target for another action is refused')
})

test('rules are scoped to a Bot and notes are trimmed and bounded', () => {
  assert.equal(ruleBotId(null), null)
  assert.equal(ruleBotId('not-a-uuid'), null)
  assert.equal(ruleBotId('6F1C2C9E-0000-4000-8000-000000000001'), '6f1c2c9e-0000-4000-8000-000000000001')
  assert.equal(decisionNote('   '), null)
  assert.equal(decisionNote(' use the team page '), 'use the team page')
  assert.equal(decisionNote('x'.repeat(5000))!.length, 2000)
  assert.equal(decisionNote(42), null)
})

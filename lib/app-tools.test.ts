import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callAppTool, listAppTools, type AppTool, type AppToolDeps } from './app-tools'

const tools: Record<string, AppTool> = {
  HUBSPOT_LIST_CONTACTS: { slug: 'HUBSPOT_LIST_CONTACTS', name: 'List contacts', tags: ['readOnlyHint'], version: '20261030_00', toolkit: { slug: 'hubspot' }, inputParameters: { type: 'object' } },
  HUBSPOT_CREATE_CONTACT: { slug: 'HUBSPOT_CREATE_CONTACT', name: 'Create contact', tags: ['openWorldHint'], version: '20261030_00', toolkit: { slug: 'hubspot' } },
  HUBSPOT_DELETE_CONTACT: { slug: 'HUBSPOT_DELETE_CONTACT', name: 'Delete contact', tags: ['destructiveHint'], version: '20261030_00', toolkit: { slug: 'hubspot' } },
  SLACK_SEND_MESSAGE: { slug: 'SLACK_SEND_MESSAGE', name: 'Send', tags: [], version: '1', toolkit: { slug: 'slack' } },
  HUBSPOT_UNPINNED: { slug: 'HUBSPOT_UNPINNED', name: 'Unpinned', tags: ['readOnlyHint'], version: 'latest', toolkit: { slug: 'hubspot' } },
}

function deps(overrides: Partial<AppToolDeps> = {}) {
  const calls: string[] = []
  const value: AppToolDeps = {
    appAllowed: async () => true,
    resolveAccount: async () => ({ accountId: 'ca_own', accounts: [{ id: 'ca_own', alias: null }] }),
    listTools: async () => Object.values(tools),
    getTool: async slug => { const tool = tools[slug]; if (!tool) throw new Error('missing'); return tool },
    execute: async call => { calls.push(`execute:${call.tool}:${call.version}`); return { successful: true, data: { id: 'c1' } } },
    recordStart: async call => { calls.push(`record:${call.tool}`); return 'rec_1' },
    recordEnd: async (_id, outcome) => { calls.push(`end:${outcome.status}`) },
    propose: async call => { calls.push(`card:${call.tool}`); return { status: 'awaiting_approval', actionId: 'card_1' } },
    ...overrides,
  }
  return { deps: value, calls }
}
const call = (tool: string, toolkit = 'hubspot') => ({ toolkit, tool, arguments: { email: 'a@acme.dev' } })

test('native review retains the exact account, tool version and input before dispatch', async () => {
  for (const choice of ['allow', 'ask', 'deny'] as const) {
    const current = deps()
    const result = await callAppTool(current.deps, call('SLACK_SEND_MESSAGE', 'slack'), {
      ownerId: 'owner', botId: null,
      review: async (decision, binding) => {
        assert.equal(decision, 'allow')
        assert.deepEqual(binding, { ownerId: 'owner', botId: null, action: 'app_tool_call', input: { toolkit: 'slack', tool: 'SLACK_SEND_MESSAGE', name: 'Send', version: '1', arguments: { email: 'a@acme.dev' } }, accountId: 'ca_own', version: '1', policy: null })
        return choice
      },
    })
    if (choice === 'allow') assert.equal((result as { status: string }).status, 'done')
    else if (choice === 'ask') assert.deepEqual(result, { status: 'awaiting_approval', actionId: 'card_1' })
    else assert.deepEqual(result, { error: 'integrationActionDenied' })
    assert.equal(current.calls.some(value => value.startsWith('execute:')), choice === 'allow')
  }
})

test('an authorized read runs with the pinned version and no write record', async () => {
  const { deps: d, calls } = deps()
  assert.deepEqual(await callAppTool(d, call('HUBSPOT_LIST_CONTACTS')), { data: { id: 'c1' } })
  assert.deepEqual(calls, ['execute:HUBSPOT_LIST_CONTACTS:20261030_00'])
})

test('authorized writes run directly and leave a record, including destructive tools', async () => {
  for (const slug of ['HUBSPOT_CREATE_CONTACT', 'HUBSPOT_DELETE_CONTACT']) {
    const current = deps()
    const result = await callAppTool(current.deps, call(slug))
    assert.equal((result as { status: string }).status, 'done')
    assert.deepEqual(current.calls, [`record:${slug}`, `execute:${slug}:20261030_00`, 'end:done'])
  }
})

test('an uncertain write stays running and is not resent', async () => {
  const { deps: d, calls } = deps({ execute: async () => { throw new Error('timeout') } })
  assert.deepEqual(await callAppTool(d, call('HUBSPOT_CREATE_CONTACT')), { error: 'operationUncertain', actionId: 'rec_1' })
  assert.deepEqual(calls, ['record:HUBSPOT_CREATE_CONTACT', 'end:running'])
})

test('the call stays inside the person\'s own connected app', async () => {
  assert.deepEqual(await callAppTool(deps({ appAllowed: async () => false }).deps, call('HUBSPOT_LIST_CONTACTS')), { error: 'integrationBlockedByWorkspace' })
  assert.deepEqual(await callAppTool(deps({ resolveAccount: async () => ({ accountId: null, accounts: [] }) }).deps, call('HUBSPOT_LIST_CONTACTS')), { error: 'integrationNotConnected' })
  const two = [{ id: 'a', alias: null }, { id: 'b', alias: null }]
  assert.deepEqual(await callAppTool(deps({ resolveAccount: async () => ({ accountId: null, accounts: two }) }).deps, call('HUBSPOT_LIST_CONTACTS')), { error: 'integrationAccountSelectionRequired', accounts: two })
  // A tool from another app cannot be called through this one's connection.
  assert.deepEqual(await callAppTool(deps().deps, call('SLACK_SEND_MESSAGE')), { error: 'integrationToolNotFound' })
  assert.deepEqual(await callAppTool(deps().deps, call('HUBSPOT_NOPE')), { error: 'integrationToolNotFound' })
  assert.deepEqual(await callAppTool(deps().deps, call('HUBSPOT_UNPINNED')), { error: 'integrationActionVersionUnavailable' })
  // Mikka's own GitHub, Linear and Telegram are not Composio apps here.
  assert.deepEqual(await callAppTool(deps().deps, call('GITHUB_LIST_REPOS', 'github')), { error: 'integrationActionNotAllowed' })
  assert.deepEqual(await callAppTool(deps().deps, { toolkit: 'hubspot', tool: 'bad slug', arguments: {} }), { error: 'invalidIntegrationInput' })
})

test('listing shows only the app\'s own tools and which ones only read', async () => {
  const result = await listAppTools(deps().deps, { toolkit: 'hubspot', query: 'contacts' }) as { tools: { slug: string; readOnly: boolean; input?: unknown }[] }
  assert.deepEqual(result.tools.map(tool => [tool.slug, tool.readOnly]), [['HUBSPOT_LIST_CONTACTS', true], ['HUBSPOT_CREATE_CONTACT', false], ['HUBSPOT_DELETE_CONTACT', false], ['HUBSPOT_UNPINNED', true]])
  assert.deepEqual(result.tools[0].input, { type: 'object' })
  assert.deepEqual(await listAppTools(deps({ resolveAccount: async () => ({ accountId: null, accounts: [] }) }).deps, { toolkit: 'hubspot' }), { error: 'integrationNotConnected' })
})

test('an app that needs no connection runs on the person alone; any other app still needs its account', async () => {
  const hn: AppTool = { slug: 'HACKERNEWS_GET_TOP_STORIES', name: 'Top stories', tags: ['readOnlyHint'], version: '20261030_00', toolkit: { slug: 'hackernews' } }
  const accounts: (string | null)[] = []
  const { deps: d } = deps({
    noAuth: async toolkit => toolkit === 'hackernews',
    resolveAccount: async () => ({ accountId: null, accounts: [] }),
    getTool: async slug => slug === hn.slug ? hn : tools[slug],
    execute: async (_call, accountId) => { accounts.push(accountId); return { successful: true, data: { stories: [] } } },
  })
  assert.deepEqual(await callAppTool(d, { toolkit: 'hackernews', tool: hn.slug, arguments: {} }), { data: { stories: [] } })
  assert.deepEqual(accounts, [null])
  assert.deepEqual(await callAppTool(d, call('HUBSPOT_LIST_CONTACTS')), { error: 'integrationNotConnected' })
  // Still gated by the Bot's app policy.
  assert.deepEqual(await callAppTool({ ...d, appAllowed: async () => false }, { toolkit: 'hackernews', tool: hn.slug, arguments: {} }), { error: 'integrationBlockedByWorkspace' })
})

test('a remembered approval answers an ask for its own tool only; a deny or a destructive tool still stops', async () => {
  const review = (choice: 'ask' | 'deny') => ({ ownerId: 'owner', botId: 'bot', review: async () => choice })
  const asked: string[] = []
  const remembered = async (c: { tool: string }, accountId: string | null) => { asked.push(`${c.tool}@${accountId}`); return c.tool === 'HUBSPOT_CREATE_CONTACT' || c.tool === 'HUBSPOT_DELETE_CONTACT' }
  const ran = deps({ remembered })
  assert.equal((await callAppTool(ran.deps, call('HUBSPOT_CREATE_CONTACT'), review('ask')) as { status: string }).status, 'done')
  assert.deepEqual(ran.calls, ['record:HUBSPOT_CREATE_CONTACT', 'execute:HUBSPOT_CREATE_CONTACT:20261030_00', 'end:done'])
  assert.deepEqual(asked, ['HUBSPOT_CREATE_CONTACT@ca_own'])
  // A different tool in the same app has no rule: it asks.
  const other = deps({ remembered })
  assert.deepEqual(await callAppTool(other.deps, call('SLACK_SEND_MESSAGE', 'slack'), review('ask')), { status: 'awaiting_approval', actionId: 'card_1' })
  // The provider tags it destructive: never answered by a rule, even a stored one.
  const destructive = deps({ remembered })
  assert.deepEqual(await callAppTool(destructive.deps, call('HUBSPOT_DELETE_CONTACT'), review('ask')), { status: 'awaiting_approval', actionId: 'card_1' })
  // A deny is never turned into an allow, and the rule is not consulted.
  asked.length = 0
  const denied = deps({ remembered })
  assert.deepEqual(await callAppTool(denied.deps, call('HUBSPOT_CREATE_CONTACT'), review('deny')), { error: 'integrationActionDenied' })
  assert.deepEqual(asked, [])
})

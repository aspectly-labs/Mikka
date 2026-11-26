import assert from 'node:assert/strict'
import { test } from 'node:test'
import { channelMentionAt, mentionAt, referenceMarker } from './thread-references'
import { expandStructuredMentions, resolveStructuredMentions } from './thread-references-server'
import { normalizeThreadFolder } from './thread-lifecycle-owner'

test('mentionAt recognizes device, subagent, and plugin typed triggers', () => {
  assert.deepEqual(mentionAt('check @device:mac', 'check @device:mac'.length), {
    from: 6,
    end: 17,
    kind: 'device',
    query: 'mac',
  })
  assert.deepEqual(mentionAt('inspect @subagent:rev', 'inspect @subagent:rev'.length), {
    from: 8,
    end: 21,
    kind: 'subagent',
    query: 'rev',
  })
  assert.deepEqual(mentionAt('use @plugin:linear', 'use @plugin:linear'.length), {
    from: 4,
    end: 18,
    kind: 'plugin',
    query: 'linear',
  })
  assert.equal(mentionAt('open @file:src/app.ts', 'open @file:src/app.ts'.length), null)
})

test('channelMentionAt triggers on # at start of line or after whitespace', () => {
  assert.deepEqual(channelMentionAt('#eng', 4), { from: 0, end: 4, query: 'eng' })
  assert.deepEqual(channelMentionAt('post in #alerts-prod', 'post in #alerts-prod'.length), {
    from: 8,
    end: 20,
    query: 'alerts-prod',
  })
  assert.equal(channelMentionAt('foo#bar', 7), null)
})

test('referenceMarker encodes device, subagent, plugin, and slack_channel tokens', () => {
  assert.equal(referenceMarker({ kind: 'device', id: 'dev-1', title: 'Mac Studio' }), '[[device:dev-1]]')
  assert.equal(referenceMarker({ kind: 'subagent', id: 'run-2', title: 'Code review' }), '[[subagent:run-2]]')
  assert.equal(referenceMarker({ kind: 'plugin', id: 'plg-3', title: 'Linear' }), '[[plugin:plg-3]]')
  assert.equal(referenceMarker({ kind: 'slack_channel', id: 'C123', title: '#engineering' }), '#engineering')
  assert.equal(referenceMarker({ kind: 'slack_channel', id: 'C123', title: 'engineering' }), '#engineering')
})

test('resolveStructuredMentions resolves workspace-scoped entities, deduplicates, and fails closed on missing rows', async () => {
  const queries: string[] = []
  const db = {
    async query(sql: string, params?: unknown[]) {
      queries.push(sql)
      if (sql.includes('FROM devices')) {
        return {
          rows: params?.[0] === 'dev-1' && params?.[1] === 'user-1'
            ? [{ name: 'MacBook Pro', kind: 'macos' }]
            : [],
        }
      }
      if (sql.includes('FROM agent_runs')) {
        return {
          rows: params?.[0] === 'sub-1' && params?.[1] === 'user-1'
            ? [{ name: 'Verifier', title: null, status: 'completed' }]
            : [],
        }
      }
      if (sql.includes('FROM personal_skills')) {
        return {
          rows: params?.[0] === 'user-1' && params?.[1] === 'linear-sync'
            ? [{ name: 'Linear Sync', slug: 'linear-sync', source: 'plugin' }]
            : [],
        }
      }
      return { rows: [] }
    },
  }

  const resolved = await resolveStructuredMentions(
    db as never,
    'user-1',
    'ws-1',
    [
      { kind: 'device', id: 'dev-1', label: 'MacBook Pro', start: 0, end: 12 },
      { kind: 'device', id: 'dev-1', label: 'MacBook Pro', start: 13, end: 25 },
      { kind: 'device', id: 'dev-other', label: 'Foreign', start: 26, end: 34 },
      { kind: 'subagent', id: 'sub-1', label: 'Verifier', start: 35, end: 44 },
      { kind: 'plugin', id: 'linear-sync', label: 'Linear Sync', start: 45, end: 57 },
      { kind: 'plugin', id: 'spoofed-plugin', label: 'Spoofed Label', start: 58, end: 70 },
      { kind: 'slack_channel', id: 'C01', label: 'spoofed-client-name', start: 71, end: 80 },
      { kind: 'slack_channel', id: 'C99', label: 'secret-channel', start: 81, end: 90 },
      { kind: 'file', id: 'src/index.ts', label: 'src/index.ts', start: 91, end: 103 },
      { kind: 'file', id: '../secret', label: '../secret', start: 104, end: 113 },
      { kind: 'folder', id: 'apps/api', label: 'apps/api', start: 114, end: 122 },
      { kind: 'folder', id: '../etc', label: '../etc', start: 123, end: 129 },
    ],
    { slackChannels: [{ id: 'C01', name: 'alerts' }] },
  )

  assert.equal(resolved.length, 11, 'duplicate device mention is deduplicated')
  assert.deepEqual(resolved[0], { kind: 'device', id: 'dev-1', state: 'ok', title: 'MacBook Pro', detail: 'macos' })
  assert.deepEqual(resolved[1], { kind: 'device', id: 'dev-other', state: 'broken', title: 'Foreign', detail: null })
  assert.deepEqual(resolved[2], { kind: 'subagent', id: 'sub-1', state: 'ok', title: 'Verifier', detail: 'completed' })
  assert.deepEqual(resolved[3], { kind: 'plugin', id: 'linear-sync', state: 'ok', title: 'Linear Sync', detail: 'linear-sync' })
  assert.deepEqual(resolved[4], { kind: 'plugin', id: 'spoofed-plugin', state: 'broken', title: 'Spoofed Label', detail: null })
  assert.deepEqual(resolved[5], { kind: 'slack_channel', id: 'C01', state: 'ok', title: '#alerts', detail: 'channel C01' })
  assert.deepEqual(resolved[6], { kind: 'slack_channel', id: 'C99', state: 'broken', title: 'secret-channel', detail: null })
  assert.deepEqual(resolved[7], { kind: 'file', id: 'src/index.ts', state: 'ok', title: 'src/index.ts', detail: 'file' })
  assert.deepEqual(resolved[8], { kind: 'file', id: '../secret', state: 'broken', title: '../secret', detail: null })
  assert.deepEqual(resolved[9], { kind: 'folder', id: 'apps/api', state: 'ok', title: 'apps/api', detail: 'folder' })
  assert.deepEqual(resolved[10], { kind: 'folder', id: '../etc', state: 'broken', title: '../etc', detail: null })

  // Disconnected Slack fails closed for slack_channel mentions.
  const disconnected = await resolveStructuredMentions(
    db as never,
    'user-1',
    'ws-1',
    [{ kind: 'slack_channel', id: 'C01', label: 'alerts', start: 0, end: 7 }],
    { slackChannels: null },
  )
  assert.equal(disconnected[0]?.state, 'broken')

  const expanded = expandStructuredMentions(resolved)
  assert.match(expanded, /<mentions>/)
  assert.match(expanded, /- \[device\] MacBook Pro \(macos\)/)
  assert.match(expanded, /- \[device\] <unavailable>/)
  assert.match(expanded, /- \[plugin\] <unavailable>/)
  assert.match(expanded, /- \[slack_channel\] #alerts \(channel C01\)/)
  assert.match(expanded, /- \[slack_channel\] <unavailable>/)
  assert.match(expanded, /- \[file\] src\/index\.ts \(file\)/)
  assert.match(expanded, /- \[file\] <unavailable>/)
  assert.match(expanded, /- \[folder\] <unavailable>/)
})

test('stripMachineContextBlocks removes machine-only <mentions> prefix and skill trailer while preserving user text', async () => {
  const { stripMachineContextBlocks, personReferenceParts } = await import('./thread-references')
  const raw = '<mentions>\n- [device] MacBook Pro (macos)\n</mentions>\n\nCheck deploy status\n\n[Mikka skill request: use skill "deploy-check" ($deploy-check)]'
  assert.equal(stripMachineContextBlocks(raw), 'Check deploy status')
  const parts = personReferenceParts(raw)
  assert.deepEqual(parts, [{ kind: 'text', text: 'Check deploy status' }])
})

test('normalizeThreadFolder trims whitespace, collapses blank to null, and enforces length', () => {
  assert.equal(normalizeThreadFolder(undefined), undefined)
  assert.equal(normalizeThreadFolder(null), null)
  assert.equal(normalizeThreadFolder('   '), null)
  assert.equal(normalizeThreadFolder('  Backend   / Auth  '), 'Backend / Auth')
  assert.equal(normalizeThreadFolder('a'.repeat(60)), 'a'.repeat(60))
  assert.equal(normalizeThreadFolder('a'.repeat(61)), undefined)
})

test('threadItems renders host-emitted systemEvent on run_messages as system_event without touching run_chunks', async () => {
  const { threadItems } = await import('./issue-run-conversation')
  const items = await threadItems(
    [],
    [
      {
        id: 'evt-1',
        text: '',
        author: 'Owner',
        mine: true,
        at: '2026-11-26T00:00:00.000Z',
        systemEvent: {
          kind: 'command_blocked',
          command: '/login',
          originalText: '/login',
          validCommands: ['compact', 'review'],
          reason: 'dangerous_passthrough',
        },
      },
    ],
  )
  assert.equal(items.length, 1)
  assert.equal(items[0]?.kind, 'system_event')
  if (items[0]?.kind === 'system_event') {
    assert.equal(items[0].event.kind, 'command_blocked')
    assert.equal(items[0].event.command, '/login')
  }
})

test('projectIssueThreads redacts private tags and folder for viewers without thread read access', async () => {
  const { projectIssueThreads } = await import('./issue-threads')
  const row = {
    id: 'run-1',
    userId: 'owner-1',
    issueId: 'issue-1',
    kind: 'implement',
    status: 'succeeded',
    outcome: null,
    prompt: 'Secret prompt',
    title: 'Secret title',
    tags: ['confidential-tag'],
    folder: 'Secret Folder',
    createdAt: new Date('2026-11-26T00:00:00.000Z'),
    startedAt: null,
    finishedAt: new Date('2026-11-26T00:01:00.000Z'),
    stopRequestedAt: null,
    error: null,
    report: null,
    agentId: 'agent-1',
    agentName: 'Claude',
    harness: 'claude_code',
    deviceId: 'dev-1',
    deviceName: 'Mac',
    deviceKind: 'local',
    botId: null,
    botName: null,
    botAvatar: null,
    continuesRunId: null,
    retryOf: null,
  }
  const [ownerView] = projectIssueThreads([row], 'issue-1', 'owner-1', new Set(['owner-1', 'other-2']))
  assert.deepEqual(ownerView?.tags, ['confidential-tag'])
  assert.equal(ownerView?.folder, 'Secret Folder')

  const [strangerView] = projectIssueThreads([row], 'issue-1', 'other-2', new Set(['owner-1', 'other-2']))
  assert.equal(strangerView?.tags, undefined)
  assert.equal(strangerView?.folder, undefined)
})

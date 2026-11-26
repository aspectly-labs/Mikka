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
        return { rows: [{ name: 'Linear Sync', slug: 'linear-sync', source: 'plugin' }] }
      }
      return { rows: [] }
    },
  }

  const resolved = await resolveStructuredMentions(db as never, 'user-1', 'ws-1', [
    { kind: 'device', id: 'dev-1', label: 'MacBook Pro', start: 0, end: 12 },
    { kind: 'device', id: 'dev-1', label: 'MacBook Pro', start: 13, end: 25 },
    { kind: 'device', id: 'dev-other', label: 'Foreign', start: 26, end: 34 },
    { kind: 'subagent', id: 'sub-1', label: 'Verifier', start: 35, end: 44 },
    { kind: 'plugin', id: 'linear-sync', label: 'Linear Sync', start: 45, end: 57 },
    { kind: 'slack_channel', id: 'C01', label: 'alerts', start: 58, end: 65 },
    { kind: 'file', id: 'src/index.ts', label: 'src/index.ts', start: 66, end: 78 },
    { kind: 'file', id: '../secret', label: '../secret', start: 79, end: 88 },
    { kind: 'folder', id: 'apps/api', label: 'apps/api', start: 89, end: 97 },
  ])

  assert.equal(resolved.length, 8, 'duplicate device mention is deduplicated')
  assert.deepEqual(resolved[0], { kind: 'device', id: 'dev-1', state: 'ok', title: 'MacBook Pro', detail: 'macos' })
  assert.deepEqual(resolved[1], { kind: 'device', id: 'dev-other', state: 'broken', title: 'Foreign', detail: null })
  assert.deepEqual(resolved[2], { kind: 'subagent', id: 'sub-1', state: 'ok', title: 'Verifier', detail: 'completed' })
  assert.deepEqual(resolved[3], { kind: 'plugin', id: 'linear-sync', state: 'ok', title: 'Linear Sync', detail: 'linear-sync' })
  assert.deepEqual(resolved[4], { kind: 'slack_channel', id: 'C01', state: 'ok', title: '#alerts', detail: 'channel C01' })
  assert.deepEqual(resolved[5], { kind: 'file', id: 'src/index.ts', state: 'ok', title: 'src/index.ts', detail: 'file' })
  assert.deepEqual(resolved[6], { kind: 'file', id: '../secret', state: 'broken', title: '../secret', detail: null })
  assert.deepEqual(resolved[7], { kind: 'folder', id: 'apps/api', state: 'ok', title: 'apps/api', detail: 'folder' })

  const expanded = expandStructuredMentions(resolved)
  assert.match(expanded, /<mentions>/)
  assert.match(expanded, /- \[device\] MacBook Pro \(macos\)/)
  assert.match(expanded, /- \[device\] <unavailable>/)
  assert.match(expanded, /- \[slack_channel\] #alerts \(channel C01\)/)
  assert.match(expanded, /- \[file\] src\/index\.ts \(file\)/)
  assert.match(expanded, /- \[file\] <unavailable>/)
})

test('normalizeThreadFolder trims whitespace, collapses blank to null, and enforces length', () => {
  assert.equal(normalizeThreadFolder(undefined), undefined)
  assert.equal(normalizeThreadFolder(null), null)
  assert.equal(normalizeThreadFolder('   '), null)
  assert.equal(normalizeThreadFolder('  Backend   / Auth  '), 'Backend / Auth')
  assert.equal(normalizeThreadFolder('a'.repeat(60)), 'a'.repeat(60))
  assert.equal(normalizeThreadFolder('a'.repeat(61)), undefined)
})

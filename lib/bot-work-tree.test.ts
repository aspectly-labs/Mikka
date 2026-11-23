import assert from 'node:assert/strict'
import test from 'node:test'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { taskPresentation, type TaskPresentation } from '@/lib/task-presentation'
import { botWorkTree } from './bot-work-tree'

type Issue = Parameters<typeof botWorkTree>[3][number]
type Thread = Parameters<typeof botWorkTree>[2][number]
const issue = (id: string, status = 'doing'): Issue => ({
  id, status, stateId: null, identifier: `MIK-${id}`, issuedIdentifier: `MIK-${id}`, title: `Task ${id}`,
  ownerId: 'owner', ownerName: 'Owner', ownerImage: null, teamId: null,
  workspaceId: 'workspace', projectId: null,
  scope: 'personal', priority: 'normal', revision: 1,
  createdAt: new Date('2026-11-10T00:00:00Z'), updatedAt: new Date('2026-11-10T00:00:00Z'),
  metadata: readIssueMetadata({ type: 'doc', content: [] }),
  checklist: { total: 0, checked: 0, percentage: 0 },
})
const run = (id: string, issueId: string | null, botId: string | null = 'bot', status: Thread['status'] = 'running', createdAt = id, source: Thread['source'] = null): Thread => ({
  id, botId, issueId, status, createdAt, updatedAt: createdAt, source, outcome: null,
  agentName: 'Codex', harness: 'codex', prompt: 'Standalone work\nPrivate detail', lastReply: null, lastReplyAt: null,
})
const present = (row: Issue, botIds: string[], projection?: Partial<TaskPresentation>): TaskPresentation => ({
  ...taskPresentation({ status: 'todo', metadata: row.metadata }, undefined, null, () => false),
  botDispatches: botIds.map(botId => ({ botId, runId: botId === 'bot' ? '2' : 'historical', harness: 'codex', name: botId })),
  ...projection,
})

test('botWorkTree builds authorized task and standalone thread rows', () => {
  const a = issue('a'), unused = issue('unused')
  const projected = present(a, ['previous', 'bot'], { state: 'waiting', reason: 'pr_review', group: 'pending' })
  const tree = botWorkTree('workspace', ['previous', 'bot', 'unrelated'], [
    run('1', 'a'), run('2', 'a'), run('private', 'a', 'unrelated'), run('mcp', 'a', 'bot', 'running', 'z', 'mcp'),
    { ...run('standalone', null), pullState: 'open' },
  ], [a, unused], { a: projected, unused: present(unused, []) })

  assert.equal(tree.has('unrelated'), false)
  assert.equal(tree.get('bot')?.[0].name, 'MIK-a Task a')
  assert.deepEqual(tree.get('bot')?.[0].runs.map(item => item.id), ['2', '1'])
  assert.equal(tree.get('bot')?.[1].issueId, null)
  assert.equal(tree.get('bot')?.[1].name, 'Standalone work')
  assert.equal(tree.get('bot')?.[1].pullState, 'open')
})

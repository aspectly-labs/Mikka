import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupPresentedTasks, waitingTasks, type CollectionIssue } from './task-collection'
import type { Thread } from '@/app/actions/task-runs'
import type { TaskPresentation } from './task-presentation'

const issue = (id: string) => ({ id, title: 'Task ' + id } as unknown as CollectionIssue)
const thread = (id: string, issueId: string | null, createdAt: string) =>
  ({ id, issueId, createdAt } as unknown as Thread)
const presentation = (group: TaskPresentation['group'], state: TaskPresentation['state']) =>
  ({ group, state } as unknown as TaskPresentation)

test('groupPresentedTasks buckets issues by presentation, counts attempts, and picks the newest thread', () => {
  const issues = [issue('i1'), issue('i2'), issue('i3'), issue('i4')]
  const threads = [
    thread('t1', 'i1', '2026-11-20T10:00:00Z'),
    thread('t2', 'i1', '2026-11-20T11:00:00Z'),
    thread('t3', 'i1', '2026-11-20T11:00:00Z'),
    thread('t4', null, '2026-11-20T12:00:00Z'),
  ]
  const presentations: Record<string, TaskPresentation> = {
    i1: presentation('pending', 'waiting'),
    i2: presentation('running', 'running'),
    i3: presentation('todo', 'todo'),
  }

  const workspace = groupPresentedTasks(issues, threads, presentations, 'workspace')
  assert.equal(workspace.pending.length, 1)
  assert.equal(workspace.pending[0].current?.id, 't3')
  assert.equal(workspace.pending[0].attempts, 3)
  assert.equal(workspace.running.length, 1)
  assert.equal(workspace.running[0].current, null)
  assert.equal(workspace.todo.length, 1)
  assert.equal(workspace.done.length, 0)

  const dispatched = groupPresentedTasks(issues, threads, presentations, 'dispatched')
  assert.deepEqual(dispatched.pending.map(row => row.issue.id), ['i1'])
  assert.deepEqual(dispatched.running, [])
  assert.deepEqual(dispatched.todo, [])
})

test('waitingTasks returns pending waiting rows without an active question', () => {
  const groups = groupPresentedTasks(
    [issue('i1'), issue('i2'), issue('i3')],
    [],
    {
      i1: presentation('pending', 'waiting'),
      i2: presentation('pending', 'waiting'),
      i3: presentation('pending', 'blocked'),
    },
    'workspace',
  )
  assert.deepEqual(waitingTasks(groups, [{ issueId: 'i1' }, { issueId: null }]).map(row => row.issue.id), ['i2'])
})

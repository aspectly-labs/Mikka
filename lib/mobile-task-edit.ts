import 'server-only'
import { and, eq } from 'drizzle-orm'
import * as Y from 'yjs'
import { db } from '@/lib/db'
import { issueDocuments, issues } from '@/lib/db/schema'
import { actAs } from '@/lib/acting-user'
import type { ActionErrorCode, ActionResult } from '@/lib/action-result'
import { ISSUE_PRIORITY_CODES } from '@/lib/issue-meta'
import type { IssueReader } from '@/lib/issue-visibility'
import { resourceAccessPredicate } from '@/lib/resource-access/predicate'
import { addThread, THREADS_FIELD } from '@/lib/rich-text/comments-model'
import { mobileTask, mobileTaskReader } from '@/lib/mobile-tasks'
import type { MobileTaskComment, MobileTaskEdit } from '@/lib/mobile-task-edit-contract'

type Reader = Exclude<IssueReader, string>
type Detail = NonNullable<Awaited<ReturnType<typeof mobileTask>>>

/** The task's `canSteer` right in its tenant: what every web edit and comment checks. */
async function mayEdit(userId: string, workspaceId: string, id: string) {
  const [row] = await db.select({ allowed: resourceAccessPredicate(userId, workspaceId, 'task', id, 'canSteer') }).from(issues)
    .where(and(eq(issues.id, id), eq(issues.workspaceId, workspaceId))).limit(1)
  return row?.allowed === true
}

type Failure = { error: ActionErrorCode }
const failed = (result: ActionResult<unknown>): result is Failure => result.error !== undefined

/**
 * Applies each requested change through the web's own server actions, acting
 * as the phone's user: they hold the task ACL (`canSteer`), the workspace
 * membership, revision fence, history, live and Linear effects. Changes apply
 * in order (status, priority, assignee); each takes the revision the previous
 * one wrote, so only the phone's own revision can be stale.
 */
export async function editMobileTask(user: Reader, id: string, input: MobileTaskEdit, explicitWorkspaceId?: string): Promise<Failure | { detail: Detail }> {
  const located = await mobileTaskReader(user, id, explicitWorkspaceId)
  if (!located) return { error: 'issueNotFound' }
  const outcome = await actAs(located.reader, async (): Promise<Failure | null> => {
    const { moveIssue, changeIssuePriority } = await import('@/app/actions/issues')
    const { updateIssueMetadata } = await import('@/app/actions/issue-metadata')
    let revision = input.revision
    if (input.status !== undefined) {
      const result = await moveIssue({ id, status: input.status, ...(input.stateId ? { stateId: input.stateId } : {}), revision })
      if (failed(result)) return result
      revision = result.issue.revision
    }
    if (input.priority !== undefined) {
      const result = await changeIssuePriority({ id, priority: input.priority, revision })
      if (failed(result)) return result
      revision = result.issue.revision
    }
    if (input.assigneeId !== undefined) {
      const result = await updateIssueMetadata({ id, revision, patch: { assignee: input.assigneeId === null ? null : { kind: 'member', id: input.assigneeId } } })
      // The action holds the assignee's membership inside the task's own access
      // check, so a person who is not an active member reads as a missing task.
      // While this caller may still steer the task, it was the assignee.
      if (failed(result) && result.error === 'issueNotFound' && input.assigneeId !== null && await mayEdit(user.id, located.workspaceId, id)) return { error: 'memberNotJoined' }
      if (failed(result)) return { error: result.error }
    }
    return null
  })
  if (outcome) return outcome
  const detail = await mobileTask(user, id, explicitWorkspaceId)
  return detail ? { detail } : { error: 'issueNotFound' }
}

/**
 * The pickers' choices for one task: the workspace's states (as the web's
 * status picker reads them), the priorities, and the active members who may be
 * assigned. `canEdit` is the task's `canSteer` right, which every edit checks.
 */
export async function mobileTaskOptions(user: Reader, id: string, explicitWorkspaceId?: string) {
  const located = await mobileTaskReader(user, id, explicitWorkspaceId)
  if (!located) return null
  const { workspaceId, reader } = located
  return actAs(reader, async () => {
    const { getIssueStates } = await import('@/app/actions/issue-states')
    const { getIssuePropertyOptions } = await import('@/app/actions/issue-metadata')
    const [states, properties, canEdit] = await Promise.all([
      getIssueStates(workspaceId),
      getIssuePropertyOptions(id),
      mayEdit(user.id, workspaceId, id),
    ])
    if (failed(states)) return null
    return {
      canEdit,
      states: states.states.map(({ taskCount: _taskCount, ...state }) => state),
      priorities: [...ISSUE_PRIORITY_CODES],
      members: properties.members.map(member => ({ id: member.id, name: member.name, image: member.image ?? null })),
    }
  })
}

/**
 * Adds a task-level discussion (an unanchored comment thread, as a Linear
 * comment arrives) through the web editor's document exchange, acting as the
 * phone's user. That write checks `canSteer`, binds the author to the signed-in
 * account whatever the update says, wakes a Bot the comment concerns and
 * schedules Linear sync. The change is a new key in the document's thread map,
 * so it merges with any concurrent edit.
 */
export async function postMobileTaskComment(user: Reader, id: string, input: MobileTaskComment, explicitWorkspaceId?: string): Promise<Failure | { detail: Detail; comment: Detail['timeline'][number] | null }> {
  const located = await mobileTaskReader(user, id, explicitWorkspaceId)
  if (!located) return { error: 'issueNotFound' }
  const threadId = `discussion-${input.clientId ?? crypto.randomUUID()}`
  const written = await actAs(located.reader, async (): Promise<Failure | null> => {
    const [row] = await db.select({ content: issues.content, state: issueDocuments.state }).from(issues)
      .leftJoin(issueDocuments, and(eq(issueDocuments.issueId, issues.id), eq(issueDocuments.userId, issues.userId)))
      .where(and(eq(issues.id, id), eq(issues.workspaceId, located.workspaceId))).limit(1)
    if (!row) return { error: 'issueNotFound' }
    const { loadIssueDocument } = await import('@/lib/linear-sync/document')
    const doc = loadIssueDocument(row.state, row.content)
    try {
      const existing = doc.getMap<Y.Map<unknown>>(THREADS_FIELD).get(threadId)
      // A retry of a post that already landed: nothing to write.
      if (existing) return existing.get('authorUserId') === user.id ? null : { error: 'validationGeneric' }
      const seed = row.state ? undefined : Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
      const before = Y.encodeStateVector(doc)
      const at = new Date().toISOString()
      // The exchange replaces both names with the signed-in account's.
      addThread(doc, { id: threadId, author: '', authorUserId: user.id, createdAt: at, messages: [{ author: '', authorUserId: user.id, body: input.body, at }] }, 'mobile-comment')
      const update = Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString('base64')
      const { exchangeDocument } = await import('@/app/actions/collaboration')
      await exchangeDocument({ id, update, ...(seed ? { seed } : {}) })
      return null
    } finally { doc.destroy() }
  })
  if (written) return written
  const detail = await mobileTask(user, id, explicitWorkspaceId)
  if (!detail) return { error: 'issueNotFound' }
  return { detail, comment: detail.timeline.find(row => row.kind === 'comment' && row.threadId === threadId) ?? null }
}

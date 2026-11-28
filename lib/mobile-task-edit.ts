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
import { issueDocumentSeed } from '@/lib/issue-document-seed'
import { serverIssueSchema } from '@/lib/issue-editor-schema-snapshot'
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
 * Applies one change through the web's own server action, acting as the
 * phone's user: it holds the task ACL (`canSteer`), the workspace membership,
 * revision fence, history, live and Linear effects. One request carries one
 * change, so a refused change never leaves another one saved.
 */
export async function editMobileTask(user: Reader, id: string, input: MobileTaskEdit, explicitWorkspaceId?: string): Promise<Failure | { detail: Detail }> {
  const located = await mobileTaskReader(user, id, explicitWorkspaceId)
  if (!located) return { error: 'issueNotFound' }
  const outcome = await actAs(located.reader, async (): Promise<Failure | null> => {
    const { revision } = input
    if (input.status !== undefined) {
      const { moveIssue } = await import('@/app/actions/issues')
      const result = await moveIssue({ id, status: input.status, ...(input.stateId ? { stateId: input.stateId } : {}), revision })
      return failed(result) ? result : null
    }
    if (input.priority !== undefined) {
      const { changeIssuePriority } = await import('@/app/actions/issues')
      const result = await changeIssuePriority({ id, priority: input.priority, revision })
      return failed(result) ? result : null
    }
    if (input.assigneeId === undefined) return { error: 'validationGeneric' }
    const { updateIssueMetadata } = await import('@/app/actions/issue-metadata')
    const result = await updateIssueMetadata({ id, revision, patch: { assignee: input.assigneeId === null ? null : { kind: 'member', id: input.assigneeId } } })
    // The action holds the assignee's membership inside the task's own access
    // check, so a person who is not an active member reads as a missing task.
    // While this caller may still steer the task, it was the assignee.
    if (failed(result) && result.error === 'issueNotFound' && input.assigneeId !== null && await mayEdit(user.id, located.workspaceId, id)) return { error: 'memberNotJoined' }
    return failed(result) ? { error: result.error } : null
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

/** What one phone comment sends through the document exchange: the thread as
 * a Yjs update written by a client of its own, which depends on no earlier
 * document state, and, for a task whose document was never opened, the
 * canonical editor seed (the web editor's schema, mentions and tables
 * included). If another writer initializes the document first, the exchange
 * keeps that document and the comment still integrates into it. Null when the
 * description fails the editor schema: the web opens such a task read-only. */
export function mobileCommentExchange(input: { id: string; content: unknown; initialized: boolean; threadId: string; authorUserId: string; body: string; at: string }) {
  let seed: string | undefined
  if (!input.initialized) {
    const state = issueDocumentSeed(serverIssueSchema(), input.content, input.id)
    if (!state) return null
    seed = Buffer.from(state).toString('base64')
  }
  const doc = new Y.Doc()
  try {
    // The exchange replaces both names with the signed-in account's.
    addThread(doc, { id: input.threadId, author: '', authorUserId: input.authorUserId, createdAt: input.at,
      messages: [{ author: '', authorUserId: input.authorUserId, body: input.body, at: input.at }] }, 'mobile-comment')
    return { id: input.id, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), ...(seed ? { seed } : {}) }
  } finally { doc.destroy() }
}

/**
 * Adds a task-level discussion (an unanchored comment thread, as a Linear
 * comment arrives) through the web editor's document exchange, acting as the
 * phone's user. That write checks `canSteer`, binds the author to the signed-in
 * account whatever the update says (so another account cannot replace this
 * thread), wakes a Bot the comment concerns and schedules Linear sync. Success
 * is answered only once the saved document holds the comment; otherwise the
 * phone gets `issueStale` and may retry with the same `clientId`.
 */
export async function postMobileTaskComment(user: Reader, id: string, input: MobileTaskComment, explicitWorkspaceId?: string): Promise<Failure | { detail: Detail; comment: Detail['timeline'][number] }> {
  const located = await mobileTaskReader(user, id, explicitWorkspaceId)
  if (!located) return { error: 'issueNotFound' }
  const threadId = `discussion-${input.clientId ?? crypto.randomUUID()}`
  const written = await actAs(located.reader, async (): Promise<Failure | null> => {
    const [row] = await db.select({ content: issues.content, state: issueDocuments.state }).from(issues)
      .leftJoin(issueDocuments, and(eq(issueDocuments.issueId, issues.id), eq(issueDocuments.userId, issues.userId)))
      .where(and(eq(issues.id, id), eq(issues.workspaceId, located.workspaceId))).limit(1)
    if (!row) return { error: 'issueNotFound' }
    if (row.state) {
      const doc = new Y.Doc()
      try {
        Y.applyUpdate(doc, Buffer.from(row.state, 'base64'))
        const existing = doc.getMap<Y.Map<unknown>>(THREADS_FIELD).get(threadId)
        // A retry of a post that already landed: nothing to write.
        if (existing) return existing.get('authorUserId') === user.id ? null : { error: 'validationGeneric' }
      } finally { doc.destroy() }
    }
    const exchange = mobileCommentExchange({ id, content: row.content, initialized: Boolean(row.state), threadId, authorUserId: user.id, body: input.body, at: new Date().toISOString() })
    if (!exchange) return { error: 'validationDocument' }
    const { exchangeDocument } = await import('@/app/actions/collaboration')
    await exchangeDocument(exchange)
    return null
  })
  if (written) return written
  const detail = await mobileTask(user, id, explicitWorkspaceId)
  if (!detail) return { error: 'issueNotFound' }
  const comment = detail.timeline.find(row => row.kind === 'comment' && row.threadId === threadId)
  return comment ? { detail, comment } : { error: 'issueStale' }
}

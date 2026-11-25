import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import type { JSONContent } from '@tiptap/core'
import { ActionFailureError } from '@/lib/action-error'
import type { ActionErrorCode } from '@/lib/action-result'
import { recordAudit } from '@/lib/audit/write'
import { db } from '@/lib/db'
import { issueDocuments, issues, linearIssueLinks } from '@/lib/db/schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { requireIssueAccessWithoutBody } from '@/lib/issue-access'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { requireCurrentIssueWorkspace, requireLockedIssueScope, withIssueWorkspace } from '@/lib/issue-scope-authorization'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { dispatchLinearIssueSync } from '@/lib/linear-sync/dispatch'
import { issueListChanged } from '@/lib/live/lists'
import { documentChanged, taskCommentsChanged } from '@/lib/live/panels'
import { resourceActionAllowed } from '@/lib/resource-access/store'
import { forgetCommentReactions, syncTaskInlineFileReferences } from './save-effects'
import { readDocumentThreads } from '@/lib/task-activity-wake'
import { workspaceDb } from '@/lib/workspace-db'
import {
  editTaskCommentInput, isDeletedMessage, setTaskCommentReactionInput, taskCommentRefSchema, TASK_COMMENT_FEATURES,
  TASK_COMMENT_QUICK_REACTIONS, TASK_COMMENT_REACTIONS_MAX,
  type EditTaskCommentInput, type SetTaskCommentReactionInput, type TaskCommentReaction, type TaskCommentRef, type TaskCommentState,
} from './contract'
import { deleteThreadMessage, editThreadMessage, findThreadMessage, referencedTaskFileIds } from './document'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Refusal = { error: ActionErrorCode }
type User = Awaited<ReturnType<typeof requireIssueAccessWithoutBody>>['user']
type Locked = { id: string; userId: string; workspaceId: string | null; scopeVersion: number; content: unknown; issuedIdentifier: string | null; linearSyncPolicy: string; linearSyncBlocked: boolean }

/** A workspace admin (lib/resource-access/store.ts reads the same row) may delete anyone's comment. */
async function workspaceAdmin(userId: string, workspaceId: string) {
  const [row] = await workspaceDb.select({ role: workspaceMembers.role }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active'), eq(workspaceMembers.role, 'admin'))).limit(1)
  return Boolean(row)
}

const mayWrite = (tx: Transaction, user: User, task: { id: string; workspaceId: string }) =>
  resourceActionAllowed(tx, user.id, { kind: 'task', id: task.id, workspaceId: task.workspaceId }, 'canSteer')

type Discussion = { tx: Transaction; user: User; task: Locked & { workspaceId: string }; doc: Y.Doc; at: string }

/**
 * Opens a task's discussion document under the task's row lock, with the
 * task's read ACL held for the transaction (each caller checks `canSteer` or
 * the admin role on top), and saves the document when `work` changed it.
 */
async function withDiscussion<T>(taskId: string, lock: 'update' | 'share', work: (discussion: Discussion) => Promise<T | Refusal>): Promise<T | Refusal> {
  const { issue, user } = await requireIssueAccessWithoutBody(taskId)
  let syncEligible = false
  const result = await withIssueWorkspace(user, issue.workspaceId, { issueId: issue.id, action: 'canReadContent' }, async (_workspace, tx) => {
    const [locked] = await tx.select({ id: issues.id, userId: issues.userId, workspaceId: issues.workspaceId, scopeVersion: issues.scopeVersion, content: issueAttrsContent,
      issuedIdentifier: issues.issuedIdentifier, linearSyncPolicy: issues.linearSyncPolicy, linearSyncBlocked: issues.linearSyncBlocked })
      .from(issues).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId))).for(lock)
    requireLockedIssueScope(locked, user.id, issue.scopeVersion, issue.workspaceId)
    if (readIssueMetadata(locked.content as Parameters<typeof readIssueMetadata>[0]).deletedAt) throw new ActionFailureError('issueNotFound')
    const [stored] = await tx.select({ state: issueDocuments.state }).from(issueDocuments)
      .where(and(eq(issueDocuments.issueId, issue.id), eq(issueDocuments.userId, issue.userId))).limit(1)
    // Comments live in the document; a task whose document was never opened has none.
    if (!stored) return { error: 'taskCommentNotFound' as const }
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, Buffer.from(stored.state, 'base64'))
      const task = { ...locked, workspaceId: locked.workspaceId! }
      let changed = false
      doc.on('update', () => { changed = true })
      const outcome = await work({ tx, user, task, doc, at: new Date().toISOString() })
      if (!changed) return outcome
      if (lock !== 'update') throw new Error('A discussion change needs the task row lock')
      const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
      if (state.length > 1_400_000) throw new Error('document exceeds 1 MB')
      await tx.update(issueDocuments).set({ state, updatedAt: new Date() }).where(and(eq(issueDocuments.issueId, issue.id), eq(issueDocuments.userId, issue.userId)))
      await tx.update(issues).set({ updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId)))
      // The description is unchanged; the comments' files may not be.
      const description = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default')) as JSONContent
      await syncTaskInlineFileReferences(tx, issue.id, referencedTaskFileIds(description, readDocumentThreads(doc)))
      await documentChanged(tx, issue.id)
      await issueListChanged(tx, issue.id)
      if (locked.linearSyncPolicy === 'explicit' && !locked.linearSyncBlocked) {
        const [link] = await tx.select({ id: linearIssueLinks.id }).from(linearIssueLinks)
          .where(and(eq(linearIssueLinks.issueId, issue.id), eq(linearIssueLinks.ownerId, issue.userId), eq(linearIssueLinks.externalTargetVerified, true))).limit(1)
        syncEligible = Boolean(link)
      }
      return outcome
    } finally { doc.destroy() }
  })
  if (syncEligible) dispatchLinearIssueSync(issue.id)
  return result
}

/** Edits a comment's body (and optionally its files). Only its author, while they may still write on the task. */
export async function editTaskComment(input: EditTaskCommentInput) {
  const parsed = editTaskCommentInput.safeParse(input)
  if (!parsed.success) return { error: 'taskCommentInvalid' as const }
  const { taskId, threadId, messageId, body, attachments } = parsed.data
  return withDiscussion(taskId, 'update', async ({ tx, user, task, doc, at }) => {
    const located = findThreadMessage(doc, threadId, messageId)
    if (!located) return { error: 'taskCommentNotFound' as const }
    if (isDeletedMessage(located.message)) return { error: 'taskCommentDeleted' as const }
    if (!located.message.authorUserId || located.message.authorUserId !== user.id || !await mayWrite(tx, user, task)) return { error: 'taskCommentAuthorOnly' as const }
    const saved = editThreadMessage(doc, located, { body, attachments }, at)
    return { comment: { taskId, threadId, messageId, body: saved.body, editedAt: saved.editedAt ?? null, attachments: saved.attachments ?? [] } }
  })
}

/**
 * Deletes a comment: its author (while they may write on the task) or a
 * workspace admin. With replies left in its thread it stays as a tombstone
 * (「评论已删除」); otherwise its thread goes. Its reactions go with it. An
 * admin deleting someone else's comment is written to the audit log.
 */
export async function deleteTaskComment(input: TaskCommentRef) {
  const parsed = taskCommentRefSchema.safeParse(input)
  if (!parsed.success) return { error: 'taskCommentInvalid' as const }
  const { taskId, threadId, messageId } = parsed.data
  return withDiscussion(taskId, 'update', async ({ tx, user, task, doc, at }) => {
    const located = findThreadMessage(doc, threadId, messageId)
    if (!located || isDeletedMessage(located.message)) return { error: 'taskCommentNotFound' as const }
    const author = Boolean(located.message.authorUserId) && located.message.authorUserId === user.id
    const allowed = author ? await mayWrite(tx, user, task) : await workspaceAdmin(user.id, task.workspaceId)
    if (!allowed) return { error: 'taskCommentDeleteForbidden' as const }
    const deleted = deleteThreadMessage(doc, threadId, located, user.id, at)
    await forgetCommentReactions(tx, taskId, deleted.messageIds)
    if (!author) await recordAudit(tx, { workspaceId: task.workspaceId, actor: { type: 'user', id: user.id, name: user.name || user.email },
      action: 'task.comment_deleted', target: { type: 'task', id: taskId, label: task.issuedIdentifier } })
    return { deleted: deleted.result, threadRemoved: deleted.threadRemoved }
  })
}

type ReactionRow = { messageId: string; emoji: string; count: number; reacted: boolean; users: TaskCommentReaction['users'] }

/** Reactions on a task's comments (or these messages), grouped by emoji in the order each was first given. */
async function readReactions(executor: Pick<Transaction, 'execute'>, taskId: string, viewerId: string, messageIds?: readonly string[]) {
  const { rows } = await executor.execute<ReactionRow>(sql`SELECT r."messageId", r.emoji, count(*)::int AS count, bool_or(r."userId"=${viewerId}) AS reacted,
      json_agg(json_build_object('id', u.id, 'name', u.name, 'image', u.image) ORDER BY r."createdAt", u.id) AS users
    FROM task_comment_reactions r JOIN "user" u ON u.id=r."userId"
    WHERE r."taskId"=${taskId} ${messageIds ? sql`AND r."messageId" = ANY(${sql.param([...messageIds])}::text[])` : sql``}
    GROUP BY r."messageId", r.emoji ORDER BY r."messageId", min(r."createdAt"), r.emoji`)
  const result: Record<string, TaskCommentReaction[]> = {}
  for (const row of rows) (result[row.messageId] ??= []).push({ emoji: row.emoji, count: row.count, reacted: row.reacted, users: row.users })
  return result
}

/**
 * Gives or takes back the viewer's one reaction of this emoji on a comment
 * (anyone who may write on the task). Giving it twice is one reaction.
 */
export async function setTaskCommentReaction(input: SetTaskCommentReactionInput) {
  const parsed = setTaskCommentReactionInput.safeParse(input)
  if (!parsed.success) return { error: 'taskCommentReactionInvalid' as const }
  const { taskId, threadId, messageId, emoji, reacted } = parsed.data
  const result = await withDiscussion(taskId, 'share', async ({ tx, user, task, doc }) => {
    const located = findThreadMessage(doc, threadId, messageId)
    if (!located || isDeletedMessage(located.message)) return { error: 'taskCommentNotFound' as const }
    if (!await mayWrite(tx, user, task)) return { error: 'taskCommentReadOnly' as const }
    // One writer per comment at a time keeps its distinct-emoji cap exact.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`task-comment-reactions:${taskId}:${messageId}`}, 0))`)
    let changed: number | null = 0
    if (reacted) {
      const { rows: [present] } = await tx.execute<{ distinct: number; mine: boolean }>(sql`SELECT count(DISTINCT emoji)::int AS distinct, bool_or(emoji=${emoji}) AS mine
        FROM task_comment_reactions WHERE "taskId"=${taskId} AND "messageId"=${messageId}`)
      if (!present?.mine && (present?.distinct ?? 0) >= TASK_COMMENT_REACTIONS_MAX) return { error: 'taskCommentReactionLimit' as const }
      changed = (await tx.execute(sql`INSERT INTO task_comment_reactions ("taskId","threadId","messageId","userId",emoji) VALUES (${taskId},${threadId},${messageId},${user.id},${emoji})
        ON CONFLICT DO NOTHING`)).rowCount
    } else {
      changed = (await tx.execute(sql`DELETE FROM task_comment_reactions WHERE "taskId"=${taskId} AND "messageId"=${messageId} AND "userId"=${user.id} AND emoji=${emoji}`)).rowCount
    }
    if (changed) await taskCommentsChanged(tx, taskId)
    return { reactions: (await readReactions(tx, taskId, user.id, [messageId]))[messageId] ?? [] }
  })
  return result
}

/** What the task page needs beside the discussion itself: who may do what, and every comment's reactions. */
export async function readTaskCommentState(taskId: string): Promise<TaskCommentState | Refusal> {
  if (!taskCommentRefSchema.shape.taskId.safeParse(taskId).success) return { error: 'issueNotFound' }
  const { issue, user } = await requireIssueAccessWithoutBody(taskId)
  return db.transaction(async tx => {
    const [locked] = await tx.select({ workspaceId: issues.workspaceId, scopeVersion: issues.scopeVersion, content: issueAttrsContent }).from(issues).where(eq(issues.id, issue.id)).for('share')
    requireLockedIssueScope(locked, user.id, issue.scopeVersion, issue.workspaceId)
    await requireCurrentIssueWorkspace(user, issue.workspaceId, issue.id)
    if (readIssueMetadata(locked.content as Parameters<typeof readIssueMetadata>[0]).deletedAt) throw new ActionFailureError('issueNotFound')
    const workspaceId = locked.workspaceId!
    const [canComment, canModerate, reactions] = [
      await mayWrite(tx, user, { id: issue.id, workspaceId }),
      await workspaceAdmin(user.id, workspaceId),
      await readReactions(tx, issue.id, user.id),
    ]
    return { viewerId: user.id, features: TASK_COMMENT_FEATURES, canComment, canModerate, quickReactions: TASK_COMMENT_QUICK_REACTIONS, reactions }
  })
}

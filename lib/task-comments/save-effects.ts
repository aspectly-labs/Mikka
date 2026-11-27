import { sql } from 'drizzle-orm'
import type { JSONContent } from '@tiptap/core'
import { armDueTimerAfterCommit } from '@/lib/due-timer'
import { isDeletedMessage } from './contract'
import type { ThreadRecord } from '@/lib/task-discussion'
import { referencedTaskFileIds } from './document'

// What saving a task document changes beside the document itself: reactions of
// comments that are gone, and which inline files are still referenced. Called in
// the save's transaction (app/actions/collaboration.ts, lib/task-comments/store.ts).
// No server-only imports: the document exchange's unit tests load this module.

type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[]; rowCount?: number | null }> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Removes the reactions of these comments (deleted, or taken out of the document). */
export async function forgetCommentReactions(tx: Executor, taskId: string, threadId: string, messageIds: readonly string[]) {
  if (!messageIds.length) return
  await tx.execute(sql`DELETE FROM task_comment_reactions WHERE "taskId"=${taskId} AND "threadId"=${threadId} AND "messageId" = ANY(${sql.param([...messageIds])}::text[])`)
}

/**
 * Marks which of the task's inline files a saved description and its live
 * comments still name (referencedTaskFileIds). A file no longer named keeps its
 * bytes for TASK_INLINE_FILE_RETAIN_DAYS (a restored version finds it); then
 * cleanupTaskInlineFiles removes it and the retirement queue its object.
 * `onlyAdd`: a writer that sees only part of what references files (the
 * description alone) marks files referenced and never unreferences one.
 */
export async function syncTaskInlineFileReferences(tx: Executor, taskId: string, referenced: readonly string[], options: { onlyAdd?: boolean } = {}) {
  const list = [...new Set(referenced.filter(id => UUID.test(id)).map(id => id.toLowerCase()))]
  if (options.onlyAdd && !list.length) return 0
  const ids = sql.param(list)
  const scope = options.onlyAdd ? sql`AND id = ANY(${ids}::uuid[])` : sql``
  const { rows } = await tx.execute(sql`UPDATE task_attachments SET
      "unreferencedAt" = CASE WHEN id = ANY(${ids}::uuid[]) THEN NULL ELSE coalesce("unreferencedAt", now()) END,
      "referencedAt" = CASE WHEN id = ANY(${ids}::uuid[]) THEN coalesce("referencedAt", now()) ELSE "referencedAt" END
    WHERE "taskId"=${taskId} AND placement='inline' ${scope}
      AND CASE WHEN id = ANY(${ids}::uuid[]) THEN "unreferencedAt" IS NOT NULL OR "referencedAt" IS NULL ELSE "unreferencedAt" IS NULL END
    RETURNING id = ANY(${ids}::uuid[]) AS referenced`)
  // A file that lost its last reference is now due for cleanup.
  if ((rows as { referenced: boolean }[]).some(row => !row.referenced)) armDueTimerAfterCommit(tx, 'account-deletions')
  return rows.length
}

/** A document save's effects on reactions and inline files, from what it held before and after. */
export async function discussionSaveEffects(tx: Executor, taskId: string,
  before: { content: JSONContent | null; threads: readonly ThreadRecord[] }, after: { content: JSONContent | null; threads: readonly ThreadRecord[] }) {
  const surviving = new Map(after.threads.map(thread => [thread.id, new Set(thread.messages.filter(message => !isDeletedMessage(message)).map(message => message.id))]))
  for (const thread of before.threads) {
    const live = surviving.get(thread.id)
    const removed = thread.messages.filter(message => !isDeletedMessage(message) && !live?.has(message.id))
    await forgetCommentReactions(tx, taskId, thread.id, removed.map(message => message.id))
  }
  const filesBefore = referencedTaskFileIds(before.content, before.threads)
  const filesAfter = referencedTaskFileIds(after.content, after.threads)
  if (filesBefore.length !== filesAfter.length || filesAfter.some(id => !filesBefore.includes(id))) await syncTaskInlineFileReferences(tx, taskId, filesAfter)
}

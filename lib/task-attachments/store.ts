import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import type { JSONContent } from '@tiptap/core'
import { eq, sql } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { artifactStorage, getArtifactObjectStream, putArtifactObject } from '@/lib/artifacts/storage'
import { db, pool } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { armDueTimerAfterCommit } from '@/lib/due-timer'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { withIssueWorkspace } from '@/lib/issue-scope-authorization'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import type { IssueReader } from '@/lib/issue-visibility'
import { resourceActionAllowed } from '@/lib/resource-access/store'
import { readDocumentThreads } from '@/lib/task-activity-wake'
import type { ThreadRecord } from '@/lib/task-discussion'
import { referencedTaskFileIds } from '@/lib/task-comments/document'
import { syncTaskInlineFileReferences } from '@/lib/task-comments/save-effects'
import { TASK_INLINE_FILE_EXPIRY_SQL } from '@/lib/account-deletions-due'
import {
  sniffTaskFileMediaType, TASK_FILE_MAX_COUNT, TASK_INLINE_FILE_MAX_COUNT,
  type SavedTaskFile, type TaskFile, type TaskFileImageType, type TaskFileList, type TaskFilePlacement,
} from './contract'

type Actor = { user: Exclude<IssueReader, string>; workspaceId: string; taskId: string }
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export class TaskFileError extends Error {
  constructor(readonly code: 'tooMany' | 'conflict' | 'notFound' | 'storage', options?: { cause?: unknown }) { super(code, options) }
}

/** Always acquire the membership and resource ACL leases before the task lock.
 * The task lock serializes the count/replay checks and fences soft deletion. */
function withFiles<T>(actor: Actor, write: boolean, work: (tx: Transaction, ownerId: string) => Promise<T>) {
  const { user, taskId, workspaceId } = actor
  return withIssueWorkspace(user, workspaceId, { issueId: taskId, action: write ? 'canSteer' : 'canReadContent' }, async (_, tx) => {
    // An explicit steer-only grant does not open the task detail or its files.
    if (write && !await resourceActionAllowed(tx, user.id, { kind: 'task', id: taskId, workspaceId }, 'canReadContent'))
      throw new ActionFailureError('issueNotFound')
    const [task] = await tx.select({ userId: issues.userId, workspaceId: issues.workspaceId, state: issues.ownershipState, content: issueAttrsContent })
      .from(issues).where(eq(issues.id, taskId)).for(write ? 'update' : 'share')
    if (!task || task.workspaceId !== workspaceId || task.state !== 'bound' || readIssueMetadata(task.content).deletedAt)
      throw new ActionFailureError('issueNotFound')
    return work(tx, task.userId)
  })
}

export function listTaskFiles(actor: Actor): Promise<TaskFileList> {
  return withFiles(actor, false, async tx => {
    // Inline files belong to the description or a comment, not the task's file list.
    const { rows } = await tx.execute<TaskFile>(sql`SELECT id,name,size,"mediaType" FROM task_attachments WHERE "taskId"=${actor.taskId} AND placement='task' ORDER BY "createdAt",id`)
    const canEdit = await resourceActionAllowed(tx, actor.user.id, { kind: 'task', id: actor.taskId, workspaceId: actor.workspaceId }, 'canSteer')
    return { files: rows, canEdit }
  })
}

export function requireTaskFileDownload(actor: Actor, fileId: string) {
  return withFiles(actor, false, async tx => {
    const { rowCount } = await tx.execute(sql`SELECT 1 FROM task_attachments WHERE "taskId"=${actor.taskId} AND id=${fileId}`)
    if (!rowCount) throw new TaskFileError('notFound')
  })
}

export function readTaskFile(actor: Actor, id: string, signal: AbortSignal) {
  return withFiles(actor, false, async tx => {
    const { rows: [file] } = await tx.execute<{ name: string; size: number; mediaType: TaskFileImageType | null; storageKey: string | null; inlineData: Buffer | null }>(
      sql`SELECT name,size,"mediaType","storageKey","inlineData" FROM task_attachments WHERE "taskId"=${actor.taskId} AND id=${id}`)
    if (!file) throw new TaskFileError('notFound')
    const body = file.storageKey
      ? await getArtifactObjectStream(file.storageKey, signal).catch(cause => { throw new TaskFileError('storage', { cause }) })
      : new Uint8Array(file.inlineData!)
    return { name: file.name, size: file.size, mediaType: file.mediaType, body }
  })
}

/**
 * Stores one file of the task. `inline` files are the description's and the
 * comments' (TASK_INLINE_FILE_MAX_COUNT of them, outside the task's file
 * list); one starts unreferenced and expires unless a saved description or
 * comment names it (syncTaskInlineFileReferences).
 */
export async function saveTaskFile(actor: Actor, file: TaskFile, bytes: Uint8Array<ArrayBuffer>, placement: TaskFilePlacement = 'task'): Promise<SavedTaskFile> {
  const digest = createHash('sha256').update(bytes).digest('hex')
  const mediaType = sniffTaskFileMediaType(bytes)
  const saved: SavedTaskFile = { id: file.id, name: file.name, size: file.size, mediaType, placement }
  const checkCapacity = async (tx: Transaction) => {
    const { rows: [prior] } = await tx.execute<{ name: string; sha256: string; placement: TaskFilePlacement }>(
      sql`SELECT name,sha256,placement FROM task_attachments WHERE "taskId"=${actor.taskId} AND id=${file.id}`)
    if (prior) {
      if (prior.sha256 !== digest || prior.name !== file.name || prior.placement !== placement) throw new TaskFileError('conflict')
      return 'replay'
    }
    const { rows: [count] } = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM task_attachments WHERE "taskId"=${actor.taskId} AND placement=${placement}`)
    if (count!.n >= (placement === 'inline' ? TASK_INLINE_FILE_MAX_COUNT : TASK_FILE_MAX_COUNT)) throw new TaskFileError('tooMany')
    return 'available'
  }
  const key = artifactStorage() === 'r2' ? `task-files/${actor.taskId}/${randomUUID()}` : null
  // Register a distinct object per attempt before its PUT. If authorization is
  // revoked, the process exits, or the final transaction rolls back, the normal
  // retirement worker collects the object. A replay cannot retire a winner.
  if (key) {
    const replay = await withFiles(actor, true, async tx => {
      if (await checkCapacity(tx) === 'replay') return true
      await tx.execute(sql`INSERT INTO chat_attachment_retirements("storageKey","taskId","notBefore") VALUES(${key},${actor.taskId},now()+interval '1 day')`)
      armDueTimerAfterCommit(tx, 'account-deletions')
      return false
    })
    if (replay) return saved
  }
  return withFiles(actor, true, async (tx, ownerId) => {
    await tx.execute(sql`SELECT mikka_account_assert_writable(${actor.user.id})`)
    if (await checkCapacity(tx) === 'replay') {
      if (key) await tx.execute(sql`DELETE FROM chat_attachment_retirements WHERE "storageKey"=${key}`)
      return saved
    }
    if (key) {
      // A configured-but-unreachable object store must not surface as a bare
      // TypeError: callers get a retryable 'storage' failure instead of a 500.
      await putArtifactObject(key, bytes, 'application/octet-stream').catch(cause => { throw new TaskFileError('storage', { cause }) })
      await tx.execute(sql`DELETE FROM chat_attachment_retirements WHERE "storageKey"=${key}`)
    }
    await tx.execute(sql`INSERT INTO task_attachments("taskId",id,name,size,sha256,"storageKey","inlineData","userId",placement,"mediaType","unreferencedAt")
      VALUES(${actor.taskId},${file.id},${file.name},${file.size},${digest},${key},${key ? null : Buffer.from(bytes)},${ownerId},${placement},${mediaType},${placement === 'inline' ? sql`now()` : null})`)
    // An unreferenced inline upload is due for cleanup a day from now.
    if (placement === 'inline') armDueTimerAfterCommit(tx, 'account-deletions')
    return saved
  })
}

export function removeTaskFile(actor: Actor, id: string) {
  return withFiles(actor, true, async tx => {
    const removed = await tx.execute(sql`DELETE FROM task_attachments WHERE "taskId"=${actor.taskId} AND id=${id}`)
    if (!removed.rowCount) throw new TaskFileError('notFound')
    armDueTimerAfterCommit(tx, 'account-deletions')
  })
}

/**
 * Bounded removal of expired inline files; the delete trigger queues each
 * stored object for retirement. Each candidate task's description and comments
 * are read again under its row lock first: an upload whose reference was saved
 * before the upload committed is kept (and marked referenced), never deleted.
 */
export async function cleanupTaskInlineFiles(limit = 100) {
  const { rows } = await pool.query<{ taskId: string; id: string }>(`SELECT "taskId",id FROM task_attachments
    WHERE placement='inline' AND "unreferencedAt" IS NOT NULL AND ${TASK_INLINE_FILE_EXPIRY_SQL} <= now() ORDER BY "unreferencedAt" LIMIT $1`, [limit])
  const byTask = new Map<string, string[]>()
  for (const row of rows) byTask.set(row.taskId, [...byTask.get(row.taskId) ?? [], row.id])
  let removed = 0
  for (const [taskId, candidates] of byTask) {
    removed += await db.transaction(async tx => {
      const [task] = await tx.select({ content: issues.content }).from(issues).where(eq(issues.id, taskId)).for('update')
      if (!task) return 0
      const { rows: [stored] } = await tx.execute<{ state: string }>(sql`SELECT state FROM issue_documents WHERE "issueId"=${taskId}`)
      const referenced = referencedTaskFileIds(task.content as JSONContent, stored ? documentThreads(stored.state) : [])
      await syncTaskInlineFileReferences(tx, taskId, referenced)
      const expired = candidates.filter(id => !referenced.includes(id.toLowerCase()))
      if (!expired.length) return 0
      const { rowCount } = await tx.execute(sql`DELETE FROM task_attachments WHERE "taskId"=${taskId} AND id = ANY(${sql.param(expired)}::uuid[])
        AND placement='inline' AND "unreferencedAt" IS NOT NULL AND ${sql.raw(TASK_INLINE_FILE_EXPIRY_SQL)} <= now()`)
      return rowCount ?? 0
    })
  }
  return removed
}

function documentThreads(state: string): ThreadRecord[] {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, Buffer.from(state, 'base64'))
    return readDocumentThreads(doc)
  } finally { doc.destroy() }
}

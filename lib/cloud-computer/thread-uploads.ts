import 'server-only'
import type { Pool } from 'pg'
import { ComputerError } from '@/lib/computer/store'
import { chatFileDownloadUrl, type FileRow } from '@/lib/chat-attachments/store'
import type { Actor } from './subagents'

/** The Files tab's 「Uploads」 view: every chat attachment recorded against this
 * thread, each with a short-lived signed download URL (#2940). Rows are read,
 * never fabricated; an attachment without R2 storage keeps its metadata and a
 * null download URL. */
export async function readThreadUploads(pool: Pool, actor: Actor, runId: string) {
  const run = (await pool.query(
    `SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3`,
    [runId, actor.userId, actor.workspaceId],
  )).rows[0]
  if (!run) throw new ComputerError(404, 'Thread unavailable')

  const rows = (await pool.query<FileRow>(
    `SELECT id,"userId","botId","conversationId","runId",name,"mediaType",size,state,sha256,"storageKey","uploadKey","inlineData","textContent","usedAt","uploadExpiresAt","removedAt"
     FROM chat_attachments WHERE "runId"=$1 AND "userId"=$2 AND state='ready' AND "removedAt" IS NULL ORDER BY "usedAt" DESC NULLS LAST, id`,
    [runId, actor.userId],
  )).rows

  const uploads = await Promise.all(rows.map(async file => ({
    id: file.id,
    name: file.name,
    mediaType: file.mediaType,
    size: file.size,
    usedAt: file.usedAt ? new Date(file.usedAt).toISOString() : null,
    downloadUrl: await chatFileDownloadUrl(file).catch(() => null),
  })))
  return { uploads }
}

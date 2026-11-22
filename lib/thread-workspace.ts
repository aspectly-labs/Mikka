import 'server-only'
import type { Pool } from 'pg'
import { chatFileDownloadUrl } from '@/lib/chat-attachments/store'
import { threadMachineAction } from '@/lib/cloud-computer/thread-machines'

/** #2940 item 2: the files uploaded against this thread's chain. Each row is
 * the person's own chat attachment; the read is scoped by ownerId, never by
 * file id alone. */
export type ThreadUpload = { id: string; runId: string; name: string; mediaType: string; size: number; createdAt: string }

export async function listThreadUploads(database: Pick<Pool, 'query'>, ownerId: string, runIds: readonly string[]): Promise<ThreadUpload[]> {
  if (!runIds.length) return []
  const { rows } = await database.query<{ id: string; runId: string; name: string; mediaType: string; size: number; createdAt: string }>(
    `SELECT id,"runId",name,"mediaType",size,"createdAt" FROM chat_attachments
      WHERE "runId"=ANY($1::uuid[]) AND "userId"=$2 AND state='ready' AND "removedAt" IS NULL
      ORDER BY "createdAt" DESC LIMIT 200`, [[...runIds], ownerId])
  return rows
}

/** A fresh short-lived signed download URL for one of the thread's uploads —
 * the file must belong to the owner and this chain, same denial as the list. */
export async function threadUploadDownloadUrl(database: Pick<Pool, 'query'>, ownerId: string, runIds: readonly string[], fileId: string): Promise<{ downloadUrl: string | null } | null> {
  const { rows: [row] } = await database.query<{ name: string; mediaType: string; storageKey: string | null }>(
    `SELECT name,"mediaType","storageKey" FROM chat_attachments
      WHERE id=$1 AND "userId"=$2 AND "runId"=ANY($3::uuid[]) AND state='ready' AND "removedAt" IS NULL`,
    [fileId, ownerId, [...runIds]])
  if (!row) return null
  return { downloadUrl: await chatFileDownloadUrl(row as never) }
}

/** #2940 item 2: the projection of files this thread changed — the latest
 * coding-workspace diff snapshot per run, read straight from the workspace
 * database (the same store the review board pages from). */
export type ThreadChangedFile = { runId: string; path: string; file: unknown }

export async function listThreadChangedFiles(membership: Pick<Pool, 'query'>, ownerId: string, workspaceId: string | null, runIds: readonly string[]): Promise<ThreadChangedFile[]> {
  if (!runIds.length || !workspaceId) return []
  const { rows } = await membership.query<{ runId: string; path: string; file: unknown }>(
    `WITH latest AS (
       SELECT "runId", max("createdAt") AS at FROM coding_workspace_snapshots
        WHERE "runId"=ANY($1::uuid[]) AND "ownerId"=$2 AND "workspaceId"=$3 GROUP BY "runId")
     SELECT s."runId", f.path, coalesce(f.patch->'file', f.metadata) AS file
       FROM coding_workspace_snapshot_files f
       JOIN coding_workspace_snapshots s ON s.id=f."snapshotId"
       JOIN latest ON latest."runId"=s."runId" AND latest.at=s."createdAt"
      ORDER BY s."runId", f.position`, [[...runIds], ownerId, workspaceId])
  return rows
}

/** #2940 item 3: the thread's machine — spec identity (sandbox, snapshot,
 * device, repo) and its liveness metrics. Null when the run never got one. */
export type ThreadMachineDetail = {
  state: 'starting' | 'running' | 'paused' | 'ended' | 'error'
  spec: { sandboxId: string | null; snapshotId: string; filesystemSnapshotId: string | null; deviceId: string | null; repoId: string | null; targetId: string | null }
  metrics: { epoch: number; lastActiveAt: string; createdAt: string; endedAt: string | null; workerLeaseUntil: string | null }
}

export async function getThreadMachineDetail(database: Pick<Pool, 'query'>, ownerId: string, workspaceId: string | null, runId: string): Promise<ThreadMachineDetail | null> {
  const { rows: [row] } = await database.query(
    `SELECT state,"sandboxId","snapshotId","filesystemSnapshotId","deviceId","repoId","targetId",epoch,"lastActiveAt","createdAt","endedAt","workerLeaseUntil"
       FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3`, [runId, ownerId, workspaceId])
  if (!row) return null
  const r = row as Record<string, unknown>
  return {
    state: r.state as ThreadMachineDetail['state'],
    spec: { sandboxId: r.sandboxId as string | null, snapshotId: r.snapshotId as string, filesystemSnapshotId: r.filesystemSnapshotId as string | null, deviceId: r.deviceId as string | null, repoId: r.repoId as string | null, targetId: r.targetId as string | null },
    metrics: { epoch: r.epoch as number, lastActiveAt: (r.lastActiveAt as Date).toISOString(), createdAt: (r.createdAt as Date).toISOString(), endedAt: r.endedAt ? (r.endedAt as Date).toISOString() : null, workerLeaseUntil: r.workerLeaseUntil ? (r.workerLeaseUntil as Date).toISOString() : null },
  }
}

/** #2940 item 3: setup/maintenance re-run on the thread's machine — the same
 * refresh_runtime the machine route serves, through threadMachineAction. */
export async function rerunThreadMachineSetup(database: Pool, ownerId: string, workspaceId: string | null, runId: string) {
  return threadMachineAction(database, { userId: ownerId, workspaceId: workspaceId ?? '' } as never, runId, 'refresh_runtime')
}

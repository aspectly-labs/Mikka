import 'server-only'
import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { repositoryBindingMatches } from '@mikka/protocol/repository'
import { deleteArtifactObject, getArtifactObjectStream, putArtifactObjectStream } from '@/lib/artifacts/storage'
import { projectRepositoryKey } from '@/lib/project-resources/contracts'
import { TASK_WORKSPACE_PREFIX, TASK_WORKSPACE_SUFFIX } from '../../packages/protocol/src/task-workspace-storage.mjs'

const contentType = 'application/zstd'
const uuid = z.uuid().refine(value => value === value.toLowerCase())
const scopeSchema = z.object({ ownerId: z.string().min(1), workspaceId: uuid, issueId: uuid, repositoryKey: z.string() })
  .refine(value => projectRepositoryKey.safeParse(value.repositoryKey).data === value.repositoryKey)
const manifestSchema = z.object({ id: uuid, size: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  headSha: z.string().regex(/^[a-f0-9]{40}$/) })
const fenceSchema = z.object({ runId: uuid, epoch: z.number().int().positive().max(2147483647), operationId: uuid, sandboxId: z.string().min(1) })

export type TaskWorkspaceArchiveScope = z.infer<typeof scopeSchema>
export type TaskWorkspaceArchiveManifest = z.infer<typeof manifestSchema>
export type TaskWorkspaceArchiveFence = z.infer<typeof fenceSchema>
type Reader = Pick<PoolClient, 'query'>

function scopeParts(scope: TaskWorkspaceArchiveScope) {
  const { ownerId, workspaceId, issueId, repositoryKey } = scopeSchema.parse(scope)
  return [ownerId, workspaceId, issueId, repositoryKey] as const
}

function digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function scopeHash(scope: TaskWorkspaceArchiveScope) {
  return createHash('sha256').update(JSON.stringify(scopeParts(scope))).digest('hex')
}

export function taskWorkspaceArchiveKey(scope: TaskWorkspaceArchiveScope, archiveId: string): string {
  return objectKey(scopeHash(scope), uuid.parse(archiveId))
}

function objectKey(scope: string, id: string) {
  return `${TASK_WORKSPACE_PREFIX}${scope}/${id}${TASK_WORKSPACE_SUFFIX}`
}

const preparedArchive = Symbol('preparedTaskWorkspaceArchive')
type PreparedTaskWorkspaceArchive = Readonly<{ [preparedArchive]: string; manifest: Readonly<TaskWorkspaceArchiveManifest> }>

function verifiedArchive(source: ReadableStream<Uint8Array>, manifest: TaskWorkspaceArchiveManifest) {
  const hash = createHash('sha256')
  let offset = 0
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array<ArrayBuffer>>({
    transform(value, controller) {
      if (value.byteLength > manifest.size - offset) throw new Error('Task workspace archive size mismatch')
      const bytes = Uint8Array.from(value)
      hash.update(bytes)
      offset += bytes.byteLength
      controller.enqueue(bytes)
    },
    flush() {
      if (offset !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('Task workspace archive integrity mismatch')
    },
  }))
}

async function verifyStoredArchive(key: string, manifest: TaskWorkspaceArchiveManifest, signal: AbortSignal) {
  const reader = verifiedArchive(await getArtifactObjectStream(key, signal, 'task-workspaces'), manifest).getReader()
  try {
    while (!(await reader.read()).done) { /* Drain through the digest verifier. */ }
  } finally {
    reader.releaseLock()
  }
}

/** Reserve and verify the immutable object before borrowing a park transaction. */
export async function prepareTaskWorkspaceArchive(
  pool: Pool, scope: TaskWorkspaceArchiveScope, rawManifest: TaskWorkspaceArchiveManifest,
  input: Uint8Array | ReadableStream<Uint8Array>, signal: AbortSignal = new AbortController().signal,
): Promise<PreparedTaskWorkspaceArchive> {
  // Keep network activity inside the independently committed reservation lease.
  signal = AbortSignal.any([signal, AbortSignal.timeout(12 * 60 * 60 * 1000)])
  const hash = scopeHash(scope)
  const manifest = Object.freeze(manifestSchema.parse(rawManifest))
  if (input instanceof Uint8Array) {
    if (input.byteLength !== manifest.size) throw new Error('Task workspace archive size mismatch')
    if (digest(input) !== manifest.sha256) throw new Error('Task workspace archive integrity mismatch')
  }
  signal.throwIfAborted()
  const { rowCount } = await pool.query(`INSERT INTO task_workspace_archive_objects AS object ("scopeHash", id, size, sha256, "headSha")
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT ("scopeHash", id) DO UPDATE SET "expiresAt"=now()+interval '1 day'
    WHERE object.size=excluded.size AND object.sha256=excluded.sha256
      AND object."headSha"=excluded."headSha" AND object."deletedAt" IS NULL`,
  [hash, manifest.id, manifest.size, manifest.sha256, manifest.headSha])
  if (!rowCount) throw new Error('Task workspace archive reservation conflicts with an existing or retired ID')
  signal.throwIfAborted()
  const key = objectKey(hash, manifest.id)
  const stream = input instanceof Uint8Array ? new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(input); controller.close() },
  }) : input
  await putArtifactObjectStream(key, verifiedArchive(stream, manifest), contentType, manifest.size, manifest.sha256, signal, 'task-workspaces')
  // An existing immutable key is accepted only after verifying its exact bytes.
  await verifyStoredArchive(key, manifest, signal)
  signal.throwIfAborted()
  return Object.freeze({ [preparedArchive]: hash, manifest })
}

/** The caller owns the transaction and the park locks on this exact run and machine. */
export async function publishTaskWorkspaceArchive(
  client: PoolClient, scope: TaskWorkspaceArchiveScope, rawFence: TaskWorkspaceArchiveFence, prepared: PreparedTaskWorkspaceArchive,
): Promise<boolean> {
  const parts = scopeParts(scope)
  const hash = scopeHash(scope)
  if (prepared[preparedArchive] !== hash) return false
  const fence = fenceSchema.parse(rawFence)
  const { manifest } = prepared

  const { rows: [machine] } = await client.query<{ runCreatedAt: string; remoteUrl: string | null }>(`
    SELECT run."createdAt"::text AS "runCreatedAt", repo."remoteUrl"
    FROM thread_machines machine
    JOIN agent_runs run ON run.id=machine."runId" AND run."userId"=machine."ownerId" AND run."issueId"=machine."issueId"
    JOIN device_repos repo ON repo.id=machine."repoId" AND repo."deviceId"=machine."deviceId" AND repo."userId"=machine."ownerId"
    JOIN issues task ON task.id=machine."issueId" AND task."workspaceId"=machine."workspaceId" AND task."ownershipState"='bound'
    WHERE machine."ownerId"=$1 AND machine."workspaceId"=$2 AND machine."issueId"=$3 AND repo."repoPath"=$4
      AND machine."runId"=$5 AND machine.epoch=$6 AND machine."operationId"=$7 AND machine."sandboxId"=$8
      AND machine.state NOT IN ('ended', 'error')
    FOR UPDATE OF machine`, [...parts, fence.runId, fence.epoch, fence.operationId, fence.sandboxId])
  if (!machine?.remoteUrl || !repositoryBindingMatches(parts[3], machine.remoteUrl)) return false

  // Different runs may park the same task concurrently. Serialize only archive
  // writers, using a separate lock from the machine-adoption lock order.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`task-workspace-archive:${hash}`])
  const order = [...parts, machine.runCreatedAt, fence.runId, fence.epoch, fence.operationId]
  const { rows: [current] } = await client.query<{ id: string; newer: boolean; sameFence: boolean; size: string; sha256: string; headSha: string }>(`
    SELECT "archiveId" AS id, size, sha256, "headSha",
      ("sourceRunCreatedAt", "sourceRunId", "sourceEpoch") >= ($5::timestamptz, $6::uuid, $7::int) AS newer,
      ("sourceRunId", "sourceEpoch", "sourceOperationId") = ($6::uuid, $7::int, $8::uuid) AS "sameFence"
    FROM task_workspace_archives
    WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "issueId"=$3 AND "repositoryKey"=$4`, order)
  if (current?.sameFence) return Number(current.size) === manifest.size && current.sha256 === manifest.sha256 && current.headSha === manifest.headSha
  if (current?.newer) return false

  const { rowCount: reserved } = await client.query(`SELECT id FROM task_workspace_archive_objects
    WHERE "scopeHash"=$1 AND id=$2 AND size=$3 AND sha256=$4 AND "headSha"=$5 AND "deletedAt" IS NULL FOR UPDATE`,
  [hash, manifest.id, manifest.size, manifest.sha256, manifest.headSha])
  if (!reserved) return false
  const { rowCount } = await client.query(`
    INSERT INTO task_workspace_archives ("ownerId", "workspaceId", "issueId", "repositoryKey",
      "sourceRunCreatedAt", "sourceRunId", "sourceEpoch", "sourceOperationId", "archiveId", size, sha256, "scopeHash", "headSha")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT ("ownerId", "workspaceId", "issueId", "repositoryKey") DO UPDATE SET
      "sourceRunCreatedAt"=excluded."sourceRunCreatedAt", "sourceRunId"=excluded."sourceRunId",
      "sourceEpoch"=excluded."sourceEpoch", "sourceOperationId"=excluded."sourceOperationId",
      "archiveId"=excluded."archiveId", size=excluded.size, sha256=excluded.sha256, "headSha"=excluded."headSha"
    WHERE (task_workspace_archives."sourceRunCreatedAt", task_workspace_archives."sourceRunId", task_workspace_archives."sourceEpoch")
        < (excluded."sourceRunCreatedAt", excluded."sourceRunId", excluded."sourceEpoch")`,
  [...order, manifest.id, manifest.size, manifest.sha256, hash, manifest.headSha])
  if (rowCount && current && current.id !== manifest.id) {
    await client.query(`UPDATE task_workspace_archive_objects SET "expiresAt"=now()+interval '1 day'
      WHERE "scopeHash"=$1 AND id=$2`, [hash, current.id])
  }
  return rowCount === 1
}

/** Delete at most one expired unreachable object per call. Old IDs stay retired. */
export async function pruneTaskWorkspaceArchives(pool: Pool, signal: AbortSignal = AbortSignal.timeout(15_000)): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [object] } = await client.query<{ scopeHash: string; id: string }>(`
      SELECT o."scopeHash", o.id FROM task_workspace_archive_objects o
      WHERE o."deletedAt" IS NULL AND o."expiresAt" <= now()
        AND NOT EXISTS (SELECT 1 FROM task_workspace_archives a WHERE a."scopeHash"=o."scopeHash" AND a."archiveId"=o.id)
      ORDER BY o."expiresAt", o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`)
    let deleted = false
    if (object) {
      const parts = [object.scopeHash, object.id]
      // Recheck after acquiring the reservation lock. Publishers also hold it.
      const { rowCount: reachable } = await client.query(`SELECT 1 FROM task_workspace_archives
        WHERE "scopeHash"=$1 AND "archiveId"=$2`, parts)
      if (!reachable) {
        await deleteArtifactObject(objectKey(object.scopeHash, object.id), signal, 'task-workspaces')
        await client.query(`UPDATE task_workspace_archive_objects SET "deletedAt"=now() WHERE "scopeHash"=$1 AND id=$2`, parts)
        deleted = true
      }
    }
    await client.query('COMMIT')
    return deleted
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function loadTaskWorkspaceArchive(reader: Reader, scope: TaskWorkspaceArchiveScope,
  signal: AbortSignal = new AbortController().signal) {
  const { rows: [row] } = await reader.query<Omit<TaskWorkspaceArchiveManifest, 'size'> & { size: string; consistent: boolean; runId: string; epoch: number; operationId: string }>(`
    SELECT archive."archiveId" AS id, archive.size, archive.sha256, archive."headSha",
      archive."sourceRunId" AS "runId", archive."sourceEpoch" AS epoch, archive."sourceOperationId" AS "operationId",
      COALESCE(archive.size=object.size AND archive.sha256=object.sha256 AND archive."headSha"=object."headSha", false) AS consistent
    FROM task_workspace_archives archive
    LEFT JOIN task_workspace_archive_objects object ON object."scopeHash"=archive."scopeHash" AND object.id=archive."archiveId" AND object."deletedAt" IS NULL
    JOIN issues task ON task.id=archive."issueId" AND task."workspaceId"=archive."workspaceId" AND task."ownershipState"='bound'
    WHERE archive."ownerId"=$1 AND archive."workspaceId"=$2 AND archive."issueId"=$3 AND archive."repositoryKey"=$4`, [...scopeParts(scope)])
  if (!row) return null
  if (!row.consistent) throw new Error('Task workspace archive metadata mismatch')
  const manifest = manifestSchema.parse({ ...row, size: Number(row.size) })
  const source = await getArtifactObjectStream(taskWorkspaceArchiveKey(scope, manifest.id), signal, 'task-workspaces')
  // The reader publishes its staged restore only after this stream finishes.
  return { manifest, source: { runId: row.runId, epoch: row.epoch, operationId: row.operationId }, stream: verifiedArchive(source, manifest) }
}

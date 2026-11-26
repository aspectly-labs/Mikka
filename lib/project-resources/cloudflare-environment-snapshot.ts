import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { workspacePool } from '@/lib/workspace-db'
import { ComputerError } from '@/lib/computer/store'
import { cloudflareTaskMachineSource } from '@/lib/cloud-computer/task-compute-provider'
import { environmentConfiguration } from './contracts'

export const CLOUDFLARE_ENVIRONMENT_SCOPE = 'cloudflare:managed'
export const CLOUDFLARE_ENVIRONMENT_TEMPLATE = 'cloudflare-task-v1'

type Build = { workspaceId: string; environmentId: string; revision: number; kind: 'claude' | 'codex'; recipe: unknown }

async function cloudflareEnvironmentBuild(pool: Pick<Pool, 'query'>, actor: { userId: string; workspaceId: string },
  runId: string, tokenId?: string | null, requireRunning = false,
) {
  return (await pool.query<Build>(`
    SELECT r."workspaceId",r."agentDefinition"#>>'{projectExecution,environment,id}' AS "environmentId",
      (r."agentDefinition"#>>'{projectExecution,environment,revision}')::int AS revision,
      CASE COALESCE(r."agentDefinition"->>'harness', a.harness) WHEN 'claude_code' THEN 'claude' ELSE 'codex' END AS kind,
      (r."agentDefinition"#>'{projectExecution,environment}')-ARRAY['id','revision','name','chosen','defaultMachineSize','scope','repositories']::text[] AS recipe
    FROM agent_runs r JOIN agents a ON a.id=r."agentId" AND a."userId"=r."userId"
    JOIN thread_machines m ON m."runId"=r.id AND m."ownerId"=r."userId" AND m."workspaceId"=r."workspaceId"
    WHERE r.id=$1 AND r."userId"=$2 AND r."workspaceId"=$3
      AND m."snapshotId"=$4 AND COALESCE(r."agentDefinition"->>'harness', a.harness) IN ('claude_code','codex')
      AND r."agentDefinition"#>>'{taskCompute,provider}'='cloudflare'
      AND r."agentDefinition"#>>'{projectExecution,environment,id}' IS NOT NULL
      AND ($5::uuid IS NULL OR (r."deviceTokenId"=$5 AND r."deviceId"=m."deviceId"))
      AND (NOT $6::boolean OR (r.status='running' AND r."worktreePath" IS NOT NULL AND m."sandboxId" IS NOT NULL))
  `, [runId, actor.userId, actor.workspaceId, cloudflareTaskMachineSource, tokenId ?? null, requireRunning])).rows[0]
}

/** A Cloudflare build prepares the approved recipe on the released task
 * runtime. Its receipt describes preparation, rather than a reusable image. */
export async function beginCloudflareEnvironmentBuild(pool: Pick<Pool,'query'>, actor: { userId: string; workspaceId: string }, runId: string) {
  const build = await cloudflareEnvironmentBuild(pool, actor, runId)
  if (!build) return
  const checked = environmentConfiguration.safeParse(build.recipe)
  if (!checked.success || checked.data.runtime === 'local')
    throw new ComputerError(409, 'Environment base image is unavailable on Cloudflare')
  const workerSha = process.env.MIKKA_CLOUD_WORKER_SHA
  if (!workerSha || !/^[a-f0-9]{40}$/.test(workerSha)) return
  await workspacePool.query(`
    INSERT INTO environment_snapshots (id,"workspaceId","environmentId",revision,"providerScope","templateKind","templateId","workerSha",
      state,"buildRunId","requestedBy","expiresAt")
    SELECT $1::uuid,e."workspaceId",e.id,e.revision,$5,$6,$7,$8,'building',$9::uuid,$10,now()+interval '20 minutes'
    FROM workspace_environments e WHERE e."workspaceId"=$2 AND e.id=$3 AND e.revision=$4 AND e."archivedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM environment_snapshots b WHERE b."workspaceId"=e."workspaceId" AND b."environmentId"=e.id
        AND b.revision=e.revision AND b."providerScope"=$5 AND b."templateKind"=$6 AND b."templateId"=$7 AND b."workerSha"=$8
        AND b.state='ready' AND b."expiresAt">now())
    ON CONFLICT ("workspaceId","environmentId",revision,"providerScope","templateKind","templateId","workerSha") WHERE state='building'
    DO UPDATE SET "buildRunId"=EXCLUDED."buildRunId","requestedBy"=EXCLUDED."requestedBy","expiresAt"=EXCLUDED."expiresAt"
      WHERE environment_snapshots."expiresAt"<=now()`,
  [randomUUID(), build.workspaceId, build.environmentId, build.revision, CLOUDFLARE_ENVIRONMENT_SCOPE, build.kind,
    CLOUDFLARE_ENVIRONMENT_TEMPLATE, workerSha, runId, actor.userId])
}

export async function finishCloudflareEnvironmentBuild(pool: Pick<Pool,'query'>, actor: { userId: string; workspaceId: string },
  runId: string, tokenId: string, state: 'ready' | 'failed',
) {
  const build = await cloudflareEnvironmentBuild(pool, actor, runId, tokenId, state === 'ready')
  if (!build) return
  await workspacePool.query(`
    UPDATE environment_snapshots b SET state=$6, "expiresAt"=now()+interval '7 days'
    FROM workspace_environments e
    WHERE e.id=b."environmentId" AND e."workspaceId"=b."workspaceId" AND e.revision=b.revision AND e."archivedAt" IS NULL
      AND b."providerScope"=$1 AND b."workspaceId"=$2 AND b."environmentId"=$3 AND b.revision=$4 AND b."buildRunId"=$5 AND b.state='building'
  `, [CLOUDFLARE_ENVIRONMENT_SCOPE, build.workspaceId, build.environmentId, build.revision, runId, state])
}

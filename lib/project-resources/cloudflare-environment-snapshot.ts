import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { workspacePool } from '@/lib/workspace-db'
import { ComputerError } from '@/lib/computer/store'
import { cloudflareTaskMachineSource } from '@/lib/cloud-computer/task-compute-provider'
import { environmentConfiguration } from './contracts'

export const CLOUDFLARE_ENVIRONMENT_SCOPE = 'cloudflare:managed'
export const CLOUDFLARE_ENVIRONMENT_TEMPLATE = 'cloudflare-task-v1'
export const E2B_ENVIRONMENT_RUNTIME_SCOPE = 'e2b:task-runtime'
export const E2B_ENVIRONMENT_RUNTIME_TEMPLATE = 'e2b-task-runtime-v1'

type Provider = 'cloudflare' | 'e2b'
type Actor = { userId: string; workspaceId: string }
const preparation = {
  cloudflare: { scope: CLOUDFLARE_ENVIRONMENT_SCOPE, template: CLOUDFLARE_ENVIRONMENT_TEMPLATE },
  e2b: { scope: E2B_ENVIRONMENT_RUNTIME_SCOPE, template: E2B_ENVIRONMENT_RUNTIME_TEMPLATE },
}

type Build = { workspaceId: string; environmentId: string; revision: number; kind: 'claude' | 'codex'; recipe: unknown; provider: Provider }

async function admittedEnvironmentPreparation(pool: Pick<Pool, 'query'>, actor: Actor,
  runId: string, provider?: Provider, tokenId?: string | null, requireRunning = false,
) {
  return (await pool.query<Build>(`
    SELECT r."workspaceId",r."agentDefinition"#>>'{taskCompute,provider}' AS provider,r."agentDefinition"#>>'{projectExecution,environment,id}' AS "environmentId",
      (r."agentDefinition"#>>'{projectExecution,environment,revision}')::int AS revision,
      CASE COALESCE(r."agentDefinition"->>'harness', a.harness) WHEN 'claude_code' THEN 'claude' ELSE 'codex' END AS kind,
      (r."agentDefinition"#>'{projectExecution,environment}')-ARRAY['id','revision','name','chosen','defaultMachineSize','scope','repositories']::text[] AS recipe
    FROM agent_runs r JOIN agents a ON a.id=r."agentId" AND a."userId"=r."userId"
    JOIN thread_machines m ON m."runId"=r.id AND m."ownerId"=r."userId" AND m."workspaceId"=r."workspaceId"
    WHERE r.id=$1 AND r."userId"=$2 AND r."workspaceId"=$3
      AND (m."snapshotId"=$4)=(r."agentDefinition"#>>'{taskCompute,provider}'='cloudflare')
      AND COALESCE(r."agentDefinition"->>'harness', a.harness) IN ('claude_code','codex')
      AND r."agentDefinition"#>>'{taskCompute,provider}' IN ('cloudflare','e2b')
      AND ($7::text IS NULL OR r."agentDefinition"#>>'{taskCompute,provider}'=$7)
      AND r."agentDefinition"#>>'{projectExecution,environment,id}' IS NOT NULL
      AND ($5::uuid IS NULL OR (r."deviceTokenId"=$5 AND r."deviceId"=m."deviceId"))
      AND (NOT $6::boolean OR (r.status='running' AND r."worktreePath" IS NOT NULL AND m."sandboxId" IS NOT NULL))
  `, [runId, actor.userId, actor.workspaceId, cloudflareTaskMachineSource, tokenId ?? null, requireRunning, provider ?? null])).rows[0]
}

/** Record preparation on the released task runtime, independent of paid image builds. */
export async function beginTaskEnvironmentPreparation(pool: Pick<Pool,'query'>, actor: Actor, runId: string, provider: Provider) {
  const build = await admittedEnvironmentPreparation(pool, actor, runId, provider)
  if (!build) return false
  const checked = environmentConfiguration.safeParse(build.recipe)
  if (!checked.success || checked.data.runtime === 'local')
    throw new ComputerError(409, `Environment base image is unavailable on ${provider === 'cloudflare' ? 'Cloudflare' : 'E2B'}`)
  const workerSha = process.env.MIKKA_CLOUD_WORKER_SHA
  if (!workerSha || !/^[a-f0-9]{40}$/.test(workerSha)) return false
  const { scope, template } = preparation[provider]
  const reserved = await workspacePool.query(`
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
  [randomUUID(), build.workspaceId, build.environmentId, build.revision, scope, build.kind, template, workerSha, runId, actor.userId])
  return Boolean(reserved.rowCount)
}

export const beginCloudflareEnvironmentBuild = (pool: Pick<Pool, 'query'>, actor: Actor, runId: string) =>
  beginTaskEnvironmentPreparation(pool, actor, runId, 'cloudflare')

export async function finishTaskEnvironmentPreparation(pool: Pick<Pool,'query'>, actor: Actor,
  runId: string, tokenId: string, state: 'ready' | 'failed',
) {
  const build = await admittedEnvironmentPreparation(pool, actor, runId, undefined, tokenId, state === 'ready')
  if (!build) return
  await workspacePool.query(`
    UPDATE environment_snapshots b SET state=$6, "expiresAt"=now()+interval '7 days'
    FROM workspace_environments e
    WHERE e.id=b."environmentId" AND e."workspaceId"=b."workspaceId" AND e.revision=b.revision AND e."archivedAt" IS NULL
      AND b."providerScope"=$1 AND b."workspaceId"=$2 AND b."environmentId"=$3 AND b.revision=$4 AND b."buildRunId"=$5 AND b.state='building'
  `, [preparation[build.provider].scope, build.workspaceId, build.environmentId, build.revision, runId, state])
}

/** A provisioning failure can happen before the guest authenticates. Once the
 * owning machine operation has failed, allow the next run to retry immediately. */
export async function failCloudflareEnvironmentBuild(actor: Actor, runId: string, operationId: string) {
  await workspacePool.query(`
    UPDATE environment_snapshots b SET state='failed', "expiresAt"=now()+interval '7 days'
    FROM thread_machines m
    WHERE b."providerScope"=$1 AND b."workspaceId"=$2 AND b."buildRunId"=$3 AND b.state='building'
      AND m."workspaceId"=b."workspaceId" AND m."ownerId"=$4 AND m."runId"=b."buildRunId"
      AND m."operationId"=$5 AND m.state='error'
  `, [CLOUDFLARE_ENVIRONMENT_SCOPE, actor.workspaceId, runId, actor.userId, operationId])
}

/** The E2B caller still holds the failed startup lease until normal cleanup. */
export async function failE2BEnvironmentPreparation(actor: Actor, runId: string, leaseId: string) {
  await workspacePool.query(`
    UPDATE environment_snapshots b SET state='failed', "expiresAt"=now()+interval '7 days'
    FROM thread_machines m
    WHERE b."providerScope"=$1 AND b."workspaceId"=$2 AND b."buildRunId"=$3 AND b.state='building'
      AND m."workspaceId"=b."workspaceId" AND m."ownerId"=$4 AND m."runId"=b."buildRunId"
      AND m."workerLeaseId"=$5 AND m.state='starting'
  `, [E2B_ENVIRONMENT_RUNTIME_SCOPE, actor.workspaceId, runId, actor.userId, leaseId])
}

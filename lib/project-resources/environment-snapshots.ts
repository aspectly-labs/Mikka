import 'server-only'
import { isCloudEdition } from '@/lib/edition'
import { readEnv } from '@/lib/env/server'
import { randomUUID } from 'node:crypto'
import { start } from 'workflow/api'
import { environmentSnapshotWorkflow } from '@/workflows/environment-snapshot/workflow'
import { ActionFailureError } from '@/lib/action-error'
import { workspacePool } from '@/lib/workspace-db'
import { gatedFeatures } from '@/lib/feature-flags'
import { serverFlagEnabled } from '@/lib/posthog-server'
import { cloudTemplateOrigin } from '@/lib/cloud-template-models'
import { sizedTaskTemplate, environmentSnapshotApiKey, environmentSnapshotScope } from '@/lib/secrets/e2b-runtime'
import { E2BKeyError } from '@/lib/secrets/flag'
import { pool as appPool } from '@/lib/db'
import { cliPolicyLayerSchema, mergeCliPolicyValues } from '@/lib/agent-tool-approval/policy-store'
import { resolveTrustedRunPolicy } from '@/lib/agent-tool-approval/policy-snapshot'
import { githubRepositoryReadCredential } from '@/lib/github/user-access'
import type { EnvironmentConfiguration } from './contracts'
import { listProjectResources } from './store'
import { CLOUDFLARE_ENVIRONMENT_SCOPE, CLOUDFLARE_ENVIRONMENT_TEMPLATE, E2B_ENVIRONMENT_RUNTIME_SCOPE, E2B_ENVIRONMENT_RUNTIME_TEMPLATE } from './cloudflare-environment-snapshot'
import {
  snapshotInput,
  eligibleConfiguration,
  type SnapshotInput,
  type SnapshotSeed,
  type SnapshotView,
} from './environment-snapshot-contract'

type Reader = Parameters<typeof listProjectResources>[0]
const userOf = (reader: Reader) => (typeof reader === 'string' ? reader : reader.id)
const enabled = (reader: Reader) => serverFlagEnabled(gatedFeatures.environmentSnapshots.key, userOf(reader))

function configuredProvider() {
  try {
    return Boolean(environmentSnapshotApiKey())
  } catch {
    return false
  }
}

export async function snapshotConfiguration(reader: Reader, input: SnapshotInput) {
  const resources = await listProjectResources(reader, input.workspaceId)
  const environment = resources.environments.find((row) => row.id === input.environmentId && !row.archivedAt)
  if (!environment) throw new ActionFailureError('projectEnvironmentUnavailable')
  const config = environment.configuration
  const harness = input.templateKind === 'claude' ? 'claude_code' : input.templateKind
  const {
    rows: [policyRow],
  } = await appPool.query<{ policy: unknown }>(
    'SELECT cli_run_policy AS policy FROM workspace_computer_policies WHERE "workspaceId"=$1',
    [input.workspaceId],
  )
  const layer = cliPolicyLayerSchema.parse(policyRow ? policyRow.policy : {})
  const configured = mergeCliPolicyValues(layer.defaults ?? {}, layer)
  const policy = resolveTrustedRunPolicy({
    workspace: {
      permissions: configured.permissions,
      networkAllow: configured.networkAllow,
    },
    personalApprovalMode: configured.approvalMode,
    environment: 'cloud',
  })
  const eligible =
    !policy.readOnly &&
    policy.permissions.network === 'allow' &&
    configured.networkAllow === undefined &&
    (!config.setup?.approved || !config.setup.command || policy.permissions.install_dependency === 'allow') &&
    (config.harness === 'any' || config.harness === harness) &&
    eligibleConfiguration(config, environment.repositories, resources.policy)
  return { eligible, environment }
}

async function hasRepositoryAccess(
  owner: string,
  repositories: { clone: string; key: string }[],
  ids?: Record<string, string>,
) {
  const keys = repositories.filter((repo) => repo.clone === 'start').map((repo) => repo.key)
  if (ids && (keys.length !== Object.keys(ids).length || keys.some((key) => !Object.hasOwn(ids, key)))) return false
  // Bound parallel GitHub requests when an environment contains many startup repos.
  for (let index = 0; index < keys.length; index += 4) {
    const allowed = await Promise.all(
      keys.slice(index, index + 4).map(async (key) => {
        const access = await githubRepositoryReadCredential(owner, key).catch(() => null)
        return access !== null && (!ids || access.repository.id === ids[key])
      }),
    )
    if (allowed.includes(false)) return false
  }
  return true
}

export function environmentSnapshotTemplate(
  kind: SnapshotInput['templateKind'],
  configuration: EnvironmentConfiguration,
): string | null {
  try {
    return sizedTaskTemplate(kind === 'claude' ? 'claude_code' : 'codex', configuration.e2bMachineSize ?? undefined)
  } catch (error) {
    if (error instanceof E2BKeyError && error.code === 'e2b_template_unavailable') return null
    throw error
  }
}

export async function readEnvironmentSnapshot(
  reader: Reader,
  raw: SnapshotInput,
): Promise<{ enabled: boolean; snapshot: SnapshotView | null }> {
  const input = snapshotInput.parse(raw)
  const cloudflare = input.provider === 'cloudflare'
  const paid = !cloudflare && await enabled(reader)
  if (!paid && !input.provider) return { enabled: false, snapshot: null }
  const { environment, eligible } = await snapshotConfiguration(reader, input)
  const latest = async (scope: string, templateId: string | null, current: boolean) =>
    (await workspacePool.query<SnapshotView & { repositoryIds: Record<string, string> }>(
      `SELECT id,revision,"templateKind",
      CASE WHEN revision<>$5 OR "expiresAt"<=now() OR "templateId"<>$6 OR "workerSha" IS DISTINCT FROM $7 OR NOT $8 THEN 'outdated' ELSE state END AS state,
      "logTail","expiresAt","repositoryIds" FROM environment_snapshots
      WHERE "workspaceId"=$1 AND "environmentId"=$2 AND "providerScope"=$3 AND "templateKind"=$4
      ORDER BY "createdAt" DESC LIMIT 1`,
      [input.workspaceId, input.environmentId, scope, input.templateKind, environment.revision,
        templateId, readEnv('MIKKA_CLOUD_WORKER_SHA') ?? null, current],
    )).rows[0]
  const template = paid ? environmentSnapshotTemplate(input.templateKind, environment.configuration) : null
  const image = paid ? await latest(environmentSnapshotScope(), template, eligible && Boolean(template) && configuredProvider()) : undefined
  const runtime = input.provider && image?.state !== 'building' && image?.state !== 'ready'
    ? await latest(cloudflare ? CLOUDFLARE_ENVIRONMENT_SCOPE : E2B_ENVIRONMENT_RUNTIME_SCOPE,
      cloudflare ? CLOUDFLARE_ENVIRONMENT_TEMPLATE : E2B_ENVIRONMENT_RUNTIME_TEMPLATE, environment.configuration.runtime !== 'local')
    : undefined
  const row = runtime ?? image
  if (!row) return { enabled: cloudflare || paid, snapshot: null }
  const { repositoryIds, ...snapshot } = row
  if (
    snapshot.state === 'ready' &&
    !(await hasRepositoryAccess(userOf(reader), environment.repositories, runtime ? undefined : repositoryIds))
  )
    snapshot.state = 'outdated'
  return {
    enabled: true,
    snapshot: { ...snapshot, expiresAt: new Date(row.expiresAt).toISOString() },
  }
}

// Reserve only after resolving actor, current environment policy and repository grants.
export async function reserveEnvironmentBuild(seed: SnapshotSeed, trigger: 'save' | 'manual') {
  const { workspaceId, environmentId, revision, userId, templateKind, templateId, workerSha } = seed
  const scope = environmentSnapshotScope()
  const client = await workspacePool.connect()
  type Claim = { id: string; enqueue: boolean }
  try {
    await client.query('BEGIN')
    const key = JSON.stringify(['environment-build-request', workspaceId, environmentId, revision, scope, templateKind, templateId, workerSha])
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key])
    const params = [workspaceId, environmentId, revision, scope, templateKind, templateId, workerSha]
    const result = await client.query<Claim>(`SELECT id, (state='building' AND "enqueuedAt" IS NULL) AS enqueue
      FROM environment_snapshots WHERE "workspaceId"=$1 AND "environmentId"=$2 AND revision=$3
        AND "providerScope"=$4 AND "templateKind"=$5 AND "templateId"=$6 AND "workerSha"=$7
        AND state IN ('building','ready') AND "expiresAt">now() ORDER BY "createdAt" DESC LIMIT 1`, params)
    let claim = result.rows[0]
    if (!claim) {
      claim = { id: randomUUID(), enqueue: true }
      // Abandon an expired in-flight claim without erasing its provider cleanup receipt.
      await client.query(`UPDATE environment_snapshots SET state='outdated' WHERE "workspaceId"=$1 AND "environmentId"=$2
        AND revision=$3 AND "providerScope"=$4 AND "templateKind"=$5 AND "templateId"=$6
        AND "workerSha"=$7 AND state='building' AND "expiresAt"<=now()`, params)
      await client.query(`INSERT INTO environment_snapshots
        ("workspaceId","environmentId",revision,"providerScope","templateKind","templateId","workerSha",id,"requestedBy",state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'building')`, [...params,claim.id,userId])
      await client.query(`INSERT INTO workspace_resource_events (id,"workspaceId","actorId",kind,"resourceId",detail)
        VALUES($1,$2,$3,'environment.snapshot_build_requested',$4,$5::jsonb)`,
        [randomUUID(),workspaceId,userId,environmentId,JSON.stringify({ buildId:claim.id,revision,templateKind,trigger,
          funding:isCloudEdition() ? 'mikka_platform' : 'self_hosted_installation' })])
    }
    await client.query('COMMIT')
    return claim
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}

export async function enqueueEnvironmentBuild(
  id: string,
  launch = (buildId: string): Promise<unknown> => start(environmentSnapshotWorkflow, [buildId]),
) {
  // Lock dispatch separately from the reservation. A lost acknowledgement
  // may retry delivery, and both deliveries share the provider operation ID.
  const client = await workspacePool.connect()
  try {
    await client.query('BEGIN')
    const pending = await client.query(
      `SELECT id FROM environment_snapshots WHERE id=$1 AND state='building' AND "enqueuedAt" IS NULL FOR UPDATE`,
      [id],
    )
    if (pending.rowCount) {
      await launch(id)
      await client.query('UPDATE environment_snapshots SET "enqueuedAt"=now() WHERE id=$1', [id])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function requestEnvironmentSnapshot(reader: Reader, raw: SnapshotInput, trigger: 'save' | 'manual' = 'manual') {
  const input = snapshotInput.parse(raw)
  if (input.provider === 'cloudflare' || !(await enabled(reader)) || !configuredProvider()) throw new ActionFailureError('projectEnvironmentUnavailable')
  const { environment, eligible } = await snapshotConfiguration(reader, input)
  if (!eligible || !environment.repositories.some((repo) => repo.clone === 'start'))
    throw new ActionFailureError('projectEnvironmentUnavailable')
  const templateId = environmentSnapshotTemplate(input.templateKind, environment.configuration)
  if (!templateId) throw new ActionFailureError('projectEnvironmentUnavailable')
  const workerSha = readEnv('MIKKA_CLOUD_WORKER_SHA')
  if (!workerSha || !/^[a-f0-9]{40}$/.test(workerSha)) throw new ActionFailureError('projectEnvironmentUnavailable')
  if (!(await hasRepositoryAccess(userOf(reader), environment.repositories))) throw new ActionFailureError('projectEnvironmentUnavailable')
  const claim = await reserveEnvironmentBuild({ ...input, revision:environment.revision, userId:userOf(reader),templateId,workerSha },trigger)
  if (claim.enqueue) await enqueueEnvironmentBuild(claim.id)
  return { id: claim.id, revision: environment.revision }
}

/** A provider cache miss never destroys or modifies the Environment definition. */
export async function rebuildMissingEnvironmentSnapshot(userId: string, input: SnapshotInput, id: string, revision: number) {
  const checked = snapshotInput.parse(input)
  const { rowCount } = await workspacePool.query(`UPDATE environment_snapshots SET state='outdated'
      WHERE id=$1 AND "workspaceId"=$2 AND "environmentId"=$3 AND "templateKind"=$4 AND revision=$5
        AND "providerScope"=$6 AND state='ready'`,
  [id, checked.workspaceId, checked.environmentId, checked.templateKind, revision, environmentSnapshotScope()])
  if (rowCount) await requestEnvironmentSnapshot(userId, checked, 'save')
}

export async function buildSnapshotsOnSave(reader: Reader, workspaceId: string, environmentId: string) {
  if (!(await enabled(reader)) || !configuredProvider()) return
  const { environments } = await listProjectResources(reader, workspaceId)
  const row = environments.find((item) => item.id === environmentId && !item.archivedAt)
  if (!row || !row.repositories.some((repo) => repo.clone === 'start')) return
  const kinds: SnapshotInput['templateKind'][] =
    row.configuration.harness === 'any'
      ? ['claude', 'codex']
      : row.configuration.harness === 'claude_code'
        ? ['claude']
        : row.configuration.harness === 'codex'
          ? ['codex']
          : []
  for (const templateKind of kinds) {
    const input = { workspaceId, environmentId, templateKind }
    if ((await snapshotConfiguration(reader, input)).eligible) await requestEnvironmentSnapshot(reader, input, 'save')
  }
}

export async function readyEnvironmentSnapshot(input: Omit<SnapshotSeed, 'templateKind' | 'workerSha'>) {
  if (!(await enabled(input.userId)) || !configuredProvider()) return null
  const kind = cloudTemplateOrigin(input.templateId)?.kind
  if (!kind || kind === 'desktop' || !readEnv('MIKKA_CLOUD_WORKER_SHA')) return null
  const { eligible, environment } = await snapshotConfiguration(input.userId, {
    ...input,
    templateKind: kind,
  })
  if (!eligible || environment.revision !== input.revision ||
      environmentSnapshotTemplate(kind, environment.configuration) !== input.templateId) return null
  const { rows } = await workspacePool.query<{
    id: string
    providerId: string
    repositoryIds: Record<string, string>
  }>(
    `SELECT id,"providerId","repositoryIds"
    FROM environment_snapshots WHERE "workspaceId"=$1 AND "environmentId"=$2 AND revision=$3
    AND "providerScope"=$4 AND "templateId"=$5 AND "workerSha"=$6 AND state='ready'
    AND "providerId" IS NOT NULL AND "expiresAt">now() ORDER BY "createdAt" DESC LIMIT 1`,
    [
      input.workspaceId,
      input.environmentId,
      input.revision,
      environmentSnapshotScope(),
      input.templateId,
      readEnv('MIKKA_CLOUD_WORKER_SHA'),
    ],
  )
  const row = rows[0]
  if (!row) {
    // A provider rollback or first placement on this provider can miss
    // without an outdated row. The authorized recipe still provisions the
    // task while the same bounded build reservation warms the provider cache.
    if (environment.repositories.some(repo => repo.clone === 'start')) {
      const cacheInput = { workspaceId: input.workspaceId, environmentId: input.environmentId, templateKind: kind }
      await requestEnvironmentSnapshot(input.userId, cacheInput, 'save').catch(() => undefined)
    }
    return null
  }
  // Every startup clone is present in this image, including repositories the
  // current task does not use. Re-check the entire set and its immutable IDs.
  if (!(await hasRepositoryAccess(input.userId, environment.repositories, row.repositoryIds))) return null
  return { id: row.id, providerId: row.providerId }
}

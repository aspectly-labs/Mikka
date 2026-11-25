import 'server-only'
import { randomUUID } from 'node:crypto'
import { start } from 'workflow/api'
import { environmentSnapshotWorkflow } from '@/workflows/environment-snapshot/workflow'
import { ActionFailureError } from '@/lib/action-error'
import { workspacePool } from '@/lib/workspace-db'
import { gatedFeatures } from '@/lib/feature-flags'
import { serverFlagEnabled } from '@/lib/posthog-server'
import { cloudTemplateOrigin } from '@/lib/cloud-template-models'
import { taskTemplate } from '@/lib/secrets/e2b-runtime'
import { pool as appPool } from '@/lib/db'
import { cliPolicyLayerSchema, mergeCliPolicyValues } from '@/lib/agent-tool-approval/policy-store'
import { resolveTrustedRunPolicy } from '@/lib/agent-tool-approval/policy-snapshot'
import { githubRepositoryReadCredential } from '@/lib/github/user-access'
import { listProjectResources } from './store'
import {
  snapshotInput,
  eligibleConfiguration,
  type SnapshotInput,
  type SnapshotSeed,
  type SnapshotView,
} from './environment-snapshot-contract'

type Reader = Parameters<typeof listProjectResources>[0]
const userOf = (reader: Reader) => (typeof reader === 'string' ? reader : reader.id)
const enabled = (reader: Reader) => serverFlagEnabled(gatedFeatures.environmentSnapshots, userOf(reader))

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
  ids: Record<string, string>,
) {
  const keys = repositories.filter((repo) => repo.clone === 'start').map((repo) => repo.key)
  if (keys.length !== Object.keys(ids).length || keys.some((key) => !Object.hasOwn(ids, key))) return false
  // Bound parallel GitHub requests when an environment contains many startup repos.
  for (let index = 0; index < keys.length; index += 4) {
    const allowed = await Promise.all(
      keys.slice(index, index + 4).map(async (key) => {
        const access = await githubRepositoryReadCredential(owner, key).catch(() => null)
        return access !== null && access.repository.id === ids[key]
      }),
    )
    if (allowed.includes(false)) return false
  }
  return true
}

export async function readEnvironmentSnapshot(
  reader: Reader,
  raw: SnapshotInput,
): Promise<{ enabled: boolean; snapshot: SnapshotView | null }> {
  const input = snapshotInput.parse(raw)
  if (!(await enabled(reader))) return { enabled: false, snapshot: null }
  const { environment, eligible } = await snapshotConfiguration(reader, input)
  const templateId = taskTemplate(input.templateKind === 'claude' ? 'claude_code' : 'codex')
  const result = await workspacePool.query<SnapshotView & { repositoryIds: Record<string, string> }>(
    `SELECT id,revision,"templateKind",
    CASE WHEN revision<>$5 OR "expiresAt"<=now() OR "templateId"<>$6 OR "workerSha" IS DISTINCT FROM $7 OR NOT $8 THEN 'outdated' ELSE state END AS state,
    "logTail","expiresAt","repositoryIds" FROM environment_snapshots
    WHERE "workspaceId"=$1 AND "environmentId"=$2 AND "userId"=$3 AND "templateKind"=$4
    ORDER BY "createdAt" DESC LIMIT 1`,
    [
      input.workspaceId,
      input.environmentId,
      userOf(reader),
      input.templateKind,
      environment.revision,
      templateId,
      process.env.MIKKA_CLOUD_WORKER_SHA ?? null,
      eligible,
    ],
  )
  const row = result.rows[0]
  if (!row) return { enabled: true, snapshot: null }
  const { repositoryIds, ...snapshot } = row
  if (
    snapshot.state === 'ready' &&
    !(await hasRepositoryAccess(userOf(reader), environment.repositories, repositoryIds))
  )
    snapshot.state = 'outdated'
  return {
    enabled: true,
    snapshot: { ...snapshot, expiresAt: new Date(row.expiresAt).toISOString() },
  }
}

export async function requestEnvironmentSnapshot(reader: Reader, raw: SnapshotInput) {
  const input = snapshotInput.parse(raw)
  if (!(await enabled(reader))) throw new ActionFailureError('projectEnvironmentUnavailable')
  const { environment, eligible } = await snapshotConfiguration(reader, input)
  if (!eligible || !environment.repositories.some((repo) => repo.clone === 'start'))
    throw new ActionFailureError('projectEnvironmentUnavailable')
  const templateId = taskTemplate(input.templateKind === 'claude' ? 'claude_code' : 'codex')
  const workerSha = process.env.MIKKA_CLOUD_WORKER_SHA
  if (!workerSha || !/^[a-f0-9]{40}$/.test(workerSha)) throw new ActionFailureError('projectEnvironmentUnavailable')
  const id = randomUUID()
  const claim = await workspacePool.query<{ id: string }>(
    `INSERT INTO environment_snapshots
    (id,"workspaceId","environmentId",revision,"userId","templateKind","templateId","workerSha",state)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'building')
    ON CONFLICT ("workspaceId","environmentId",revision,"userId","templateKind","templateId","workerSha") WHERE state='building'
    DO UPDATE SET revision=excluded.revision RETURNING id`,
    [
      id,
      input.workspaceId,
      input.environmentId,
      environment.revision,
      userOf(reader),
      input.templateKind,
      templateId,
      workerSha,
    ],
  )
  // Re-enqueue on repeats: a process can stop after the insert, before the workflow starts.
  await start(environmentSnapshotWorkflow, [claim.rows[0].id])
  return { id: claim.rows[0].id, revision: environment.revision }
}

export async function buildSnapshotsOnSave(reader: Reader, workspaceId: string, environmentId: string) {
  if (!(await enabled(reader))) return
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
    if ((await snapshotConfiguration(reader, input)).eligible) await requestEnvironmentSnapshot(reader, input)
  }
}

export async function readyEnvironmentSnapshot(input: Omit<SnapshotSeed, 'templateKind' | 'workerSha'>) {
  if (!(await enabled(input.userId))) return null
  const kind = cloudTemplateOrigin(input.templateId)?.kind
  if (!kind || kind === 'desktop' || !process.env.MIKKA_CLOUD_WORKER_SHA) return null
  const { eligible, environment } = await snapshotConfiguration(input.userId, {
    ...input,
    templateKind: kind,
  })
  if (!eligible || environment.revision !== input.revision) return null
  const { rows } = await workspacePool.query<{
    id: string
    providerId: string
    repositoryIds: Record<string, string>
  }>(
    `SELECT id,"providerId","repositoryIds"
    FROM environment_snapshots WHERE "workspaceId"=$1 AND "environmentId"=$2 AND revision=$3
    AND "userId"=$4 AND "templateId"=$5 AND "workerSha"=$6 AND state='ready'
    AND "providerId" IS NOT NULL AND "expiresAt">now() ORDER BY "createdAt" DESC LIMIT 1`,
    [
      input.workspaceId,
      input.environmentId,
      input.revision,
      input.userId,
      input.templateId,
      process.env.MIKKA_CLOUD_WORKER_SHA,
    ],
  )
  const row = rows[0]
  if (!row) return null
  // Every startup clone is present in this image, including repositories the
  // current task does not use. Re-check the entire set and its immutable IDs.
  if (!(await hasRepositoryAccess(input.userId, environment.repositories, row.repositoryIds))) return null
  return { id: row.id, providerId: row.providerId }
}

import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { JSONContent } from '@tiptap/core'
import { z } from 'zod'
import { defaultRunPolicy, readOnlyRunPolicy, legacyApprovalModeSchema, networkAllowSchema, runPolicySchema, storedPermissionsSchema, type PermissionDecision, type RunPolicy } from '@mikka/protocol/agent-policy'
import { runGitIdentitySchema, type RunGitIdentity } from '@mikka/protocol/device'
import { resolveSettingValue } from '@/lib/settings/registry'
import { intersectRunPolicy } from '../run-assignment-policy'
import type { MailboxTransactionLease, MailboxTransactionGuard } from '@/lib/mailbox-transaction-guard'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { borrowTaskWorkspaceMembership, requireTaskWorkspace } from '@/lib/task-workspace'
import { ActionFailureError } from '@/lib/action-error'

/** Derived from the stored task and its trusted workspace relation, never a tool argument. */
export interface CliTaskScope { issueId: string; scopeVersion: number; workspaceId: string | null; hierarchy?: CliHierarchy }
interface CliTaskRow { workspaceId: string | null; ownershipState: string; scopeVersion: number; content: JSONContent }
const hierarchySchema = z.strictObject({ workspaceId: z.uuid(), teamId: z.uuid().nullable(), projectId: z.uuid().nullable() })
export type CliHierarchy = z.infer<typeof hierarchySchema>

/** Resolve stored team/shared-project UUIDs, never a mutable project label. */
async function cliHierarchy(task: CliTaskScope, frozenHierarchy: unknown): Promise<CliHierarchy | undefined> {
  if (!task.workspaceId) return undefined
  const { workspacePool } = await import('@/lib/workspace-db')
  // Both relationships belong to WS. Resolve them in one statement snapshot;
  // an APP task row never becomes a cross-database authorization join.
  const { rows: [relations] } = await workspacePool.query<{ teamId: string | null; projectIds: string[] }>(`SELECT
    (SELECT l."teamId" FROM mikka_team_issues l JOIN mikka_teams t ON t.id=l."teamId" AND t."workspaceId"=l."workspaceId"
      WHERE l."issueId"=$1 AND l."workspaceId"=$2) AS "teamId",
    ARRAY(SELECT p.id FROM workspace_project_tasks t JOIN workspace_projects p ON p.id=t."projectId" AND p."workspaceId"=t."workspaceId"
      WHERE t."issueId"=$1 AND t."workspaceId"=$2) AS "projectIds"`,[task.issueId,task.workspaceId])
  if (!relations || relations.projectIds.length > 1) throw new Error('agentPolicyUnavailable')
  if (!relations.teamId && !relations.projectIds.length) {
    if (frozenHierarchy != null) throw new Error('agentPolicyChanged')
    return undefined
  }
  const hierarchy = hierarchySchema.parse({ workspaceId: task.workspaceId, teamId: relations.teamId, projectId: relations.projectIds[0] ?? null })
  if (frozenHierarchy != null) {
    const frozen = hierarchySchema.parse(frozenHierarchy)
    // Membership in a stricter team/project may change without issue.scopeVersion.
    // Never keep authorizing with an older, wider admitted hierarchy.
    if (frozen.workspaceId !== hierarchy.workspaceId || frozen.teamId !== hierarchy.teamId || frozen.projectId !== hierarchy.projectId) throw new Error('agentPolicyChanged')
    return frozen
  }
  return hierarchy
}
export async function lockCliTaskScope(tx: PoolClient, userId: string, issueId: string): Promise<CliTaskScope> {
  // Authority needs the complete metadata schema, never the document body.
  // Preserve non-object roots so malformed/null content keeps its old behavior.
  const { rows: [task] } = await tx.query<CliTaskRow>(`SELECT "workspaceId","ownershipState","scopeVersion",
    CASE WHEN jsonb_typeof(content)='object' THEN jsonb_build_object('attrs',content->'attrs') ELSE content END AS content
    FROM issues WHERE id=$1`, [issueId])
  return validateCliTaskScope(userId, issueId, task, tx)
}

async function validateCliTaskScope(userId: string, issueId: string, task: CliTaskRow | undefined, appExecutor: Pick<PoolClient, 'query'>): Promise<CliTaskScope> {
  if (!task || task.ownershipState !== 'bound' || !task.workspaceId || readIssueMetadata(task.content).deletedAt) throw new Error('agentPolicyUnavailable')
  await requirePolicyWorkspace(userId, task.workspaceId, appExecutor)
  return { issueId, scopeVersion: task.scopeVersion, workspaceId: task.workspaceId }
}

async function requirePolicyWorkspace(userId: string, workspaceId: string, appExecutor: Pick<PoolClient, 'query'>) {
  try { await requireTaskWorkspace(userId, workspaceId, appExecutor) }
  catch (error) {
    if (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied') throw new Error('agentPolicyUnavailable', { cause: error })
    throw error
  }
}

export type CliMembershipGuard = (workspaceId: string, userId: string, signal: AbortSignal) => Promise<MailboxTransactionLease>
export const realCliMembershipGuard: CliMembershipGuard = async (workspaceId, userId, signal) => {
  const borrowed = borrowTaskWorkspaceMembership(userId, workspaceId)
  if (borrowed) return { ...borrowed, signal }
  const [{ workspacePool }, { acquireWorkspaceMembership }] = await Promise.all([import('@/lib/workspace-db'), import('@/lib/workspace-membership-guard')])
  return acquireWorkspaceMembership(workspacePool, { workspaceId, userId }, signal)
}

/** A CLI policy layer an older build stored (`cli_run_policy` on workspaces,
 * teams and projects). It restricts nothing (ADR 2026-11-27-1615); the
 * schema remains for code that still moves legacy rows. */
export const cliPolicyValuesSchema = z.strictObject({ permissions: storedPermissionsSchema.omit({ computer_use: true }).optional(), networkAllow: networkAllowSchema.optional(), approvalMode: legacyApprovalModeSchema.optional() })
export const cliPolicyLayerSchema = cliPolicyValuesSchema.extend({ defaults: cliPolicyValuesSchema.optional() })
type CliPolicyValues = z.infer<typeof cliPolicyValuesSchema>
// Defaults replace scalar/list fields; permission choices inherit per action.
export const mergeCliPolicyValues = (base: CliPolicyValues, next: CliPolicyValues): CliPolicyValues => ({ ...base, ...next, ...(next.permissions ? { permissions: { ...base.permissions, ...next.permissions } } : {}) })

/** What every run gets: full access (ADR 2026-11-27-1615). The daemon's own
 * push is the claim's publication decision; the computer grant is attached
 * at claim from its own policy. */
function fullAccessRunPolicy(): RunPolicy {
  const policy = defaultRunPolicy()
  return { ...policy, permissions: { ...policy.permissions, git_push: 'allow' } }
}
/** Caller identity is authenticated by the host. Workspace membership is
 * separately pinned by the caller's membership guard through transaction commit. */
export async function lockCliAgentPolicy(tx: PoolClient, userId: string, agentId: string, botId: string | null, task?: CliTaskScope, runWorkspaceId?: string) {
  let workspaceId: string | null = null
  if (botId) {
    const bot = await tx.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2 FOR SHARE', [botId,userId])
    if (!bot.rows[0]) throw new Error('agentPolicyUnavailable')
    workspaceId = bot.rows[0].workspaceId
  }
  const scope = { botId, workspaceId, agentId }
  const workspaceIds = [...new Set([workspaceId, task?.workspaceId, runWorkspaceId].filter((id): id is string => !!id))].sort()
  if (workspaceIds.length > 1) throw new Error('agentPolicyUnavailable')
  const primaryWorkspaceId = runWorkspaceId ?? workspaceId ?? task?.workspaceId ?? null
  const key = scope.botId ?? 'coordinator'
  // One statement, the same locks in the same order: the Bot and worker keys are
  // execution identity, then each workspace in UUID order (a function scan
  // returns unnest's rows in order).
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended(k,0)) FROM unnest($1::text[]) AS k',
    [[`agent-cli-policy:${userId}:${key}`, `worker-cli-policy:${scope.agentId}`, ...workspaceIds.map(id => `workspace-cli-policy:${id}`)]])
  // Materialize empty defaults under the same locks, so legacy runs have a
  // stable generation. No existing computer or external-write choice changes.
  await tx.query(`WITH head AS (INSERT INTO agent_kit_heads (owner_id,bot_key,bot_id,workspace_id) VALUES ($1,$2,$3,$4) ON CONFLICT (owner_id,bot_key) DO NOTHING)
    INSERT INTO workspace_computer_policies ("workspaceId",permission) SELECT w,'allow' FROM unnest($5::uuid[]) AS w ON CONFLICT ("workspaceId") DO NOTHING`, [userId,key,scope.botId,scope.workspaceId,workspaceIds])
  // The head is identity only: it binds the run to its Bot and workspace.
  // Its policy columns are not read; no Bot layer exists.
  const agentRow = await tx.query<{ workspace: string | null }>(`SELECT workspace_id AS workspace FROM agent_kit_heads WHERE owner_id=$1 AND bot_key=$2 FOR SHARE`, [userId,key])
  if (!agentRow.rows[0] || agentRow.rows[0].workspace !== scope.workspaceId) throw new Error('agentPolicyUnavailable')
  // The worker row is identity and device only; its policy columns are retired.
  const workerRow = await tx.query<{ deviceId: string | null }>(`SELECT "deviceId" FROM agents WHERE id=$1 AND "userId"=$2 FOR SHARE`, [scope.agentId,userId])
  if (!workerRow.rows[0]) throw new Error('agentPolicyUnavailable')
  // A new owned worker can be configured before its first device assignment.
  // Absence gets the bounded local default, never cloud authority. A bound
  // device must still belong to the same owner and remain locked through commit.
  let deviceKind = 'local'
  if (workerRow.rows[0].deviceId) {
    const device = await tx.query<{kind:string}>(`SELECT kind FROM devices WHERE id=$1 AND "ownerId"=$2 FOR SHARE`,[workerRow.rows[0].deviceId,userId])
    if (!device.rows[0]) throw new Error('agentPolicyUnavailable')
    deviceKind = device.rows[0].kind
  }
  // Stored CLI layers (workspace, team and project permissions, network lists
  // and read_only) restrict nothing any more (ADR 2026-11-27-1615). Their
  // rows are still locked and versioned in the same order: the revision keeps
  // fencing admitted runs, and the hierarchy stays bound to its workspace.
  const workspaceVersions: string[][] = []
  for (const id of workspaceIds) {
    const row = await tx.query<{ version: string; generation: string }>(`SELECT cli_run_policy_version AS version,cli_run_policy_generation AS generation FROM workspace_computer_policies WHERE "workspaceId"=$1 FOR SHARE`, [id])
    if (!row.rows[0]) throw new Error('agentPolicyUnavailable')
    const version = String(row.rows[0].version)
    if (!/^\d+$/.test(version)) throw new Error('agentPolicyUnavailable')
    workspaceVersions.push([id, row.rows[0].generation, version])
  }
  const scopeVersions: string[][] = []
  const hierarchy = task?.hierarchy
  for (const kind of ['team','project'] as const) {
    const id = hierarchy?.[kind === 'team' ? 'teamId' : 'projectId']
    if (!id || !hierarchy) continue
    await tx.query(`INSERT INTO cli_scope_policies(kind,scope_id,workspace_id) VALUES($1,$2,$3) ON CONFLICT(kind,scope_id) DO NOTHING`, [kind,id,hierarchy.workspaceId])
    const { rows: [row] } = await tx.query<{ workspaceId: string; version: string; generation: string }>(`SELECT workspace_id AS "workspaceId",cli_run_policy_version AS version,cli_run_policy_generation AS generation FROM cli_scope_policies WHERE kind=$1 AND scope_id=$2 FOR SHARE`,[kind,id])
    if (!row || row.workspaceId !== hierarchy.workspaceId || !/^\d+$/.test(String(row.version))) throw new Error('agentPolicyUnavailable')
    scopeVersions.push([kind,id,row.generation,String(row.version)])
  }
  const policy = fullAccessRunPolicy()
  const revision = createHash('sha256').update(JSON.stringify(['sandbox-task-policy-v3',deviceKind,userId,scope.botId,scope.workspaceId,scope.agentId,workspaceVersions,scopeVersions,task ? { issueId: task.issueId, workspaceId: task.workspaceId, hierarchy: task.hierarchy } : null])).digest('hex')
  // No stored layer changes the policy, so none requires a signed snapshot.
  return { policy, revision, workspaceId: primaryWorkspaceId, workspaceIds, hierarchy, policySnapshotRequired: false }
}

/** Resolve personal/workspace Git identity under the held APP transaction when typed settings exist. */
async function readRunGitIdentity(tx: PoolClient, userId: string, workspaceId: string): Promise<RunGitIdentity | undefined> {
  const { rows: [present] } = await tx.query<{ ok: boolean }>(
    `SELECT to_regclass('public.personal_setting_values') IS NOT NULL AND to_regclass('public.workspace_setting_values') IS NOT NULL AS ok`,
  )
  if (!present?.ok) return undefined
  const { rows } = await tx.query<{ scope: 'personal' | 'workspace'; key: string; textValue: string | null }>(
    `SELECT 'personal'::text AS scope, key, "textValue" FROM personal_setting_values
       WHERE "userId" = $1 AND "workspaceId" = $2 AND key IN ('gitAuthorName', 'gitAuthorEmail')
     UNION ALL
     SELECT 'workspace'::text AS scope, key, "textValue" FROM workspace_setting_values
       WHERE "workspaceId" = $2 AND key IN ('gitAuthorName', 'gitAuthorEmail')`,
    [userId, workspaceId],
  )
  const personalName = rows.find(row => row.scope === 'personal' && row.key === 'gitAuthorName')?.textValue
  const workspaceName = rows.find(row => row.scope === 'workspace' && row.key === 'gitAuthorName')?.textValue
  const personalEmail = rows.find(row => row.scope === 'personal' && row.key === 'gitAuthorEmail')?.textValue
  const workspaceEmail = rows.find(row => row.scope === 'workspace' && row.key === 'gitAuthorEmail')?.textValue
  const name = resolveSettingValue('gitAuthorName', personalName, workspaceName).value as string
  const email = resolveSettingValue('gitAuthorEmail', personalEmail, workspaceEmail).value as string
  if (!name && !email) return undefined
  return runGitIdentitySchema.parse({
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
  })
}

/** Resolve a run's exact owner, Bot and worker; then read the workspace policy. */
export async function lockCliRunPolicy(
  tx: PoolClient,
  runId: string,
  userId: string,
  options: { freezeHierarchy?: boolean; includeGitIdentity?: boolean } = {},
) {
  // Policy must precede Factory/task/run locks. Read the task with the run,
  // then freeze any new hierarchy only after acquiring the policy locks.
  const result = await tx.query<CliTaskRow & { botId: string | null; agentId: string; issueId: string | null; runWorkspaceId: string | null; policyCeiling: unknown; hierarchy: unknown }>(`SELECT "botId","agentId","issueId",r."agentDefinition"->'policyCeiling' AS "policyCeiling",
    r.cli_policy_hierarchy AS hierarchy,r."workspaceId" AS "runWorkspaceId",i."workspaceId",i."ownershipState",i."scopeVersion",
    CASE WHEN jsonb_typeof(i.content)='object' THEN jsonb_build_object('attrs',i.content->'attrs') ELSE i.content END AS content
    FROM agent_runs r LEFT JOIN issues i ON i.id=r."issueId" WHERE r.id=$1 AND r."userId"=$2`, [runId,userId])
  const run = result.rows[0]
  if (!run?.runWorkspaceId) throw new Error('agentPolicyUnavailable')
  const task = run.issueId ? await validateCliTaskScope(userId,run.issueId,run,tx) : undefined
  if (task && task.workspaceId !== run.runWorkspaceId) throw new Error('agentPolicyUnavailable')
  if (!task && run.hierarchy != null) throw new Error('agentPolicyUnavailable')
  if (!task) await requirePolicyWorkspace(userId, run.runWorkspaceId, tx)
  if (task) { const hierarchy = await cliHierarchy(task,run.hierarchy); if (hierarchy) task.hierarchy = hierarchy }
  const current = await lockCliAgentPolicy(tx,userId,run.agentId,run.botId,task,run.runWorkspaceId)
  if (options.freezeHierarchy !== false && task?.hierarchy && run.hierarchy == null) {
    // Concurrent first readers may agree on the snapshot, but one may never
    // overwrite a different admitted hierarchy after waiting on the row lock.
    const frozen = await tx.query(`UPDATE agent_runs SET cli_policy_hierarchy=$3 WHERE id=$1 AND "userId"=$2
      AND (cli_policy_hierarchy IS NULL OR cli_policy_hierarchy=$3::jsonb) RETURNING id`, [runId,userId,task.hierarchy])
    if (!frozen.rowCount) throw new Error('agentPolicyChanged')
  }
  const gitIdentity = options.includeGitIdentity ? await readRunGitIdentity(tx, userId, run.runWorkspaceId) : undefined
  const resolved: typeof current & { gitIdentity?: RunGitIdentity } = gitIdentity ? { ...current, gitIdentity } : current
  if (run.policyCeiling == null) return resolved
  const ceiling = runPolicySchema.safeParse(run.policyCeiling)
  if (!ceiling.success) throw new Error('agentPolicyUnavailable')
  return { ...resolved, policy: intersectRunPolicy(current.policy, ceiling.data),
    revision: createHash('sha256').update(JSON.stringify(['provider-policy-ceiling-v1', current.revision, ceiling.data])).digest('hex') }
}

/** A host prelocks policy before its Factory/issue/run locks. It verifies an
 * existing hierarchy without taking a run lock; admission freezes it later. */
export function prelockCliRunPolicy(tx: PoolClient, runId: string, userId: string) {
  return lockCliRunPolicy(tx, runId, userId, { freezeHierarchy: false })
}

/** Capture the source's effective policy while the caller holds policy locks
 * before Factory/issue/run locks. New credentials and harnesses do not inherit
 * a broader worker default, including after later target settings edits. */
export async function providerContinuationPolicy(tx: PoolClient, userId: string, sourceRunId: string): Promise<RunPolicy> {
  const { rows: [source] } = await tx.query<{ readOnly: boolean | null; computerUse: PermissionDecision | null }>(`SELECT "agentDefinition"->>'readOnly'='true' AS "readOnly",
    "agentDefinition"#>>'{policyCeiling,permissions,computer_use}' AS "computerUse"
    FROM agent_runs WHERE id=$1 AND "userId"=$2`, [sourceRunId, userId])
  if (!source) throw new Error('agentPolicyUnavailable')
  const current = await lockCliRunPolicy(tx, sourceRunId, userId)
  let policy = structuredClone(current.policy)
  // The generic CLI default is not an independent computer grant. The broker
  // reauthorizes it, but an existing host ceiling (especially deny) survives.
  if (source.computerUse) policy.permissions.computer_use = source.computerUse
  else delete policy.permissions.computer_use
  if (source.readOnly || policy.readOnly) policy = readOnlyRunPolicy(policy)
  const { rows: assignments } = await tx.query<{ stage: string; policy: unknown }>(`SELECT a.stage,a.output->'check'->'policy' AS policy
    FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" AND t."attemptId"=a.id
    JOIN agent_runs r ON r.id=a."runId" AND r."issueId"=t."issueId" AND r."userId"=t."userId"
    WHERE r.id=$1 AND r."userId"=$2 AND a.stage IN ('review','verify','monitor')`, [sourceRunId, userId])
  for (const assignment of assignments) {
    if (assignment.stage !== 'monitor') policy = intersectRunPolicy(policy, runPolicySchema.parse(assignment.policy))
    policy = readOnlyRunPolicy(policy)
  }
  return policy
}

export async function policyMemberships(current: Awaited<ReturnType<typeof lockCliAgentPolicy>>, userId: string, signal: AbortSignal, membership: CliMembershipGuard): Promise<MailboxTransactionLease> {
  const leases: MailboxTransactionLease[] = []
  try {
    for (const id of current.workspaceIds) leases.push(await membership(id,userId,signal))
    return {
      workspaceClient: leases[current.workspaceIds.indexOf(current.workspaceId ?? '')]?.workspaceClient,
      signal: AbortSignal.any([signal, ...leases.flatMap(lease => lease.signal ? [lease.signal] : [])]),
      async check(appExecutor) { for (const lease of leases) await lease.check(appExecutor) },
      async close() { await Promise.all(leases.map(lease => lease.close())) },
    }
  } catch (error) { await Promise.all(leases.map(lease => lease.close())); throw error }
}

/** Hold the workspace membership lease through the application transaction. */
export function cliPolicyGuard(runId: string, userId: string, membership: CliMembershipGuard): MailboxTransactionGuard {
  return async (tx, signal) => {
    const current = await lockCliRunPolicy(tx, runId, userId)
    return policyMemberships(current,userId,signal,membership)
  }
}

/** Read an authenticated run's policy under the same locks used by decisions. */
export async function readCliRunPolicy(
  pool: Pick<Pool, 'connect'>,
  runId: string,
  userId: string,
  guard: CliMembershipGuard = realCliMembershipGuard,
  options?: { includeGitIdentity?: boolean },
) {
  // The work resolved the policy in this transaction and still holds its locks
  // (advisory, FOR SHARE) through COMMIT, so the membership lease is taken for
  // that same result instead of resolving it a second time (12 statements).
  let current: Awaited<ReturnType<typeof lockCliRunPolicy>> | undefined
  return writeTransaction(pool, async tx => (current = await lockCliRunPolicy(tx, runId, userId, options)), {
    guard: (_tx, signal) => policyMemberships(current!, userId, signal, guard),
  })
}

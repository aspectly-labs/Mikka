import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { memberProjectOrganization } from '@/lib/resource-access/project-creation-default'
import { workspaceListChanged } from '@/lib/live/lists'
import { inDatabaseTransaction } from '@/lib/db/request-scope'
import { currentTransactionBoundary } from '@/lib/db/transaction-boundary'
import { workspaceSecrets } from '@/lib/db/secrets-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'
import type { WorkspaceTransaction } from '@/lib/workspace-access'
import { ActionFailureError } from '@/lib/action-error'
import { GovernanceError } from '@/lib/governance/errors'
import { isMachineSize } from '@/lib/cloud-computer/machine-pricing'
import { ENVIRONMENT_INSTRUCTIONS_MAX, environmentConfiguration, environmentInstructionsScope, environmentRepositories, environmentShareInput, projectEnvironmentVariableInput, listProjectSetupVersionsInput, rollbackProjectSetupInput, type projectSetupScope, type EnvironmentInstructionsView, type EnvironmentRepository, type EnvironmentScope, type ProjectSetupHistory, type ProjectSetupRecipe, repositoryBindingInput, saveEnvironmentInput, saveEnvironmentInstructionsInput, workspaceRepositoryPolicyInput, type EnvironmentConfiguration, type ProjectExecutionSnapshot } from './contracts'

type Reader = Parameters<typeof withTaskWorkspace>[0]
const actorId = (reader: Reader) => typeof reader === 'string' ? reader : reader.id
export type EnvironmentRow = { id: string; workspaceId: string; name: string; revision: number; configuration: EnvironmentConfiguration; instructions?: string; archivedAt: Date | null; defaultMachineSize: string | null
  scope: EnvironmentScope; ownerId: string | null; repositories: unknown }
/** The columns every EnvironmentRow read selects, unqualified. */
const environmentColumns = sql.raw(`id,"workspaceId",name,configuration,instructions,revision,"archivedAt","defaultMachineSize",scope,"ownerId",repositories`)
type ResourceLease = { userId: string; workspaceId: string; tx: WorkspaceTransaction; active: boolean; boundary: object | undefined }
const resourceLease = new AsyncLocalStorage<ResourceLease>()
const currentResourceLease = () => {
  const held = resourceLease.getStore()
  return held?.active && held.boundary === currentTransactionBoundary() ? held : undefined
}

/** Acquire before the APP transaction. Nested Factory queues borrow the same
 * lease; the shared locks survive savepoints and last through the owner's COMMIT.
 * An existing APP owner without that lease must not invert the two databases. */
export async function withProjectResourceLease<T>(reader: Reader, workspaceId: string, work: (tx: WorkspaceTransaction) => Promise<T>, requireExisting = false): Promise<T> {
  const scope = taskReaderScope(reader)
  if (scope.workspaceId && scope.workspaceId !== workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  const held = currentResourceLease()
  if (held?.active && held.userId === scope.userId && held.workspaceId === workspaceId) return work(held.tx)
  if (requireExisting || inDatabaseTransaction() || held?.active) throw new ActionFailureError('projectEnvironmentUnavailable')
  return withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('mikka-team-relations',0))`)
    await resourceLock(tx, workspaceId, false)
    const lease: ResourceLease = { userId: scope.userId, workspaceId, tx, active: true, boundary: currentTransactionBoundary() }
    try { return await resourceLease.run(lease, () => work(tx)) }
    finally { lease.active = false }
  })
}

export function requireProjectResourceLease(userId: string, workspaceId: string) {
  const held = currentResourceLease()
  if (!held?.active || held.userId !== userId || held.workspaceId !== workspaceId) throw new ActionFailureError('projectEnvironmentUnavailable')
}

/** A continuation may retain its frozen configuration only while that exact
 * repository/branch/environment selection is still admitted. Never combine a
 * historical Environment with a newly selected branch or rewrite the snapshot. */
export function assertFrozenProjectExecution(frozen: ProjectExecutionSnapshot, admitted: ProjectExecutionSnapshot) {
  if (frozen.workspaceId !== admitted.workspaceId || frozen.projectId !== admitted.projectId || frozen.repositoryKey !== admitted.repositoryKey || frozen.baseBranch !== admitted.baseBranch) throw new ActionFailureError('projectRepositoryDenied')
  if ((frozen.environment?.id ?? null) !== (admitted.environment?.id ?? null) || (frozen.environment?.revision ?? null) !== (admitted.environment?.revision ?? null)) throw new ActionFailureError('projectEnvironmentUnavailable')
}

/** Called after the queue locks the actual device repository and Agent. */
export function assertProjectExecutionTarget(snapshot: ProjectExecutionSnapshot, target: { userId: string; workspaceId: string; repositoryKey: string | null; runtime: 'local' | 'cloud'; harness: string }) {
  requireProjectResourceLease(target.userId, target.workspaceId)
  if (snapshot.workspaceId !== target.workspaceId || snapshot.repositoryKey !== target.repositoryKey) throw new ActionFailureError('projectRepositoryDenied')
  const environment = snapshot.environment
  if (environment && ((environment.runtime !== 'any' && environment.runtime !== target.runtime) || (environment.harness !== 'any' && environment.harness !== target.harness))) throw new ActionFailureError('projectEnvironmentUnavailable')
}

export async function resourceLock(tx: WorkspaceTransaction, workspaceId: string, write: boolean) {
  await tx.execute(write
    ? sql`select pg_advisory_xact_lock(hashtextextended(${'project-resources:' + workspaceId},0))`
    : sql`select pg_advisory_xact_lock_shared(hashtextextended(${'project-resources:' + workspaceId},0))`)
}
export async function resourceWriteLock(tx: WorkspaceTransaction, workspaceId: string) {
  // Configuration edits cannot upgrade an admission's shared lease. Every
  // independent writer takes relation -> resource -> entity locks, matching
  // admission and Project lifecycle operations across the split databases.
  if (currentResourceLease()) throw new ActionFailureError('projectResourceConflict')
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('mikka-team-relations',0))`)
  await resourceLock(tx, workspaceId, true)
}
async function memberRole(tx: WorkspaceTransaction, reader: Reader, workspaceId: string) {
  const [member] = await tx.select({ role: workspaceMembers.role }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorId(reader)), eq(workspaceMembers.status, 'active')))
  return member?.role ?? null
}
async function admin(tx: WorkspaceTransaction, reader: Reader, workspaceId: string) {
  if (await memberRole(tx, reader, workspaceId) !== 'admin') throw new ActionFailureError('workspaceAccessDenied')
}

/** A personal environment (「仅我」) exists only for its owner: every read, write and run admission treats it
 * as missing for anyone else, administrators included. A shared one is visible to every member. */
export function environmentVisibleTo(row: Pick<EnvironmentRow, 'scope' | 'ownerId'>, userId: string) {
  return row.scope === 'workspace' || row.ownerId === userId
}
/** Who edits, archives and restores an environment's setup: its owner, and for a shared one also administrators. */
export function environmentManageableBy(row: Pick<EnvironmentRow, 'scope' | 'ownerId'>, userId: string, role: 'admin' | 'member' | null) {
  if (!role) return false
  return row.ownerId === userId || (row.scope === 'workspace' && role === 'admin')
}
const visibleEnvironment = (userId: string) => sql`(scope='workspace' or "ownerId"=${userId})`

/** The environment's repository rows. A row written before the repositories column (or by an older writer)
 * has only configuration.repositoryKeys: those are its start rows. */
export function environmentRepositoryRows(row: Pick<EnvironmentRow, 'configuration' | 'repositories'>): EnvironmentRepository[] {
  const keys = Array.isArray(row.configuration?.repositoryKeys) ? row.configuration.repositoryKeys : []
  const stored = environmentRepositories.safeParse(row.repositories ?? [])
  const rows = stored.success ? stored.data : []
  const byKey = new Map(rows.map(item => [item.key, item]))
  // repositoryKeys stays authoritative for the start rows, so an older writer's list is never contradicted.
  const start = keys.map(key => ({ ...(byKey.get(key) ?? { key, baseBranch: null, primary: false }), key, clone: 'start' as const }))
  const demand = rows.filter(item => item.clone === 'demand' && !keys.includes(item.key))
  let primary = false
  return [...start, ...demand].map(item => {
    const keep = item.primary && !primary
    primary ||= keep
    return { ...item, primary: keep }
  })
}
async function audit(tx: WorkspaceTransaction, reader: Reader, workspaceId: string, kind: string, resourceId: string | null, detail: object) {
  await tx.execute(sql`insert into workspace_resource_events(id,"workspaceId","actorId",kind,"resourceId",detail)
    values(${randomUUID()},${workspaceId},${actorId(reader)},${kind},${resourceId},${JSON.stringify(detail)}::jsonb)`)
}
async function secretsFit(workspaceId: string, configuration: EnvironmentConfiguration, repositoryKey?: string | null) {
  if (!configuration.secretIds.length) return
  const ids = [...new Set(configuration.secretIds)]
  const secrets = await db.select({ id: workspaceSecrets.id, scopeType: workspaceSecrets.scopeType, scopeRef: workspaceSecrets.scopeRef })
    .from(workspaceSecrets).where(and(eq(workspaceSecrets.workspaceId, workspaceId), inArray(workspaceSecrets.id, ids)))
  const repo = repositoryKey?.startsWith('v2/github.com/') ? repositoryKey.slice('v2/github.com/'.length) : null
  if (secrets.length !== ids.length || (repositoryKey !== undefined && secrets.some(secret => secret.scopeType === 'repository' && secret.scopeRef !== repo))) {
    throw new ActionFailureError('projectEnvironmentUnavailable')
  }
}

/** Keep the Workspace Project row and its APP content policy locked during the
 * read. Missing and inaccessible Projects have one public result. Deprecated for one release:
 * only the read-only views of the retired Project bindings use it. */
async function withConfiguredProject<T>(reader: Reader, workspaceId: string, projectId: string,
  work: (tx: WorkspaceTransaction, project: { revision: number; archivedAt: Date | null }) => Promise<T>) {
  const { withResourceAccess } = await import('@/lib/resource-access/store')
  return withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    // Match the Project lifecycle writer: the APP policy is locked before
    // the source row. The surrounding Workspace transaction owns both uses.
    try {
      return await withResourceAccess(reader, { kind: 'project', id: projectId, workspaceId }, 'canReadContent', async () => {
        const project = (await tx.execute<{ revision: number; archivedAt: Date | null }>(sql`select revision,"archivedAt"
          from workspace_projects where id=${projectId} and "workspaceId"=${workspaceId} for share`)).rows[0]
        if (!project) throw new ActionFailureError('projectNotFound')
        return work(tx, project)
      })
    } catch (error) {
      if (error instanceof ActionFailureError && error.code === 'issueNotFound') throw new ActionFailureError('projectNotFound', undefined, undefined, { cause: error })
      throw error
    }
  })
}

type ProjectRepositoryBinding = z.output<typeof repositoryBindingInput>

async function projectRepositoryBindings(tx: WorkspaceTransaction, workspaceId: string, projectId: string) {
  const result = await tx.execute<ProjectRepositoryBinding>(sql`select "repositoryKey","baseBranch","environmentId","isPrimary" from workspace_project_repositories
    where "projectId"=${projectId} and "workspaceId"=${workspaceId} order by "repositoryKey"`)
  return result.rows
}

/** Workspace configuration stays tenant-scoped. Project bindings also require current Project content access. */
export async function listProjectResources(reader: Reader, workspaceId: string, projectId?: string) {
  const read = async (tx: WorkspaceTransaction) => {
    const policy = await tx.execute<{ mode: string; repositoryKeys: string[]; revision: number }>(sql`select mode,"repositoryKeys",revision from workspace_repository_policies where "workspaceId"=${workspaceId}`)
    // Someone else's personal environment is not listed, for administrators either.
    const environments = await tx.execute<EnvironmentRow>(sql`select ${environmentColumns} from workspace_environments
      where "workspaceId"=${workspaceId} and ${visibleEnvironment(actorId(reader))} order by name,id`)
    const repositories = projectId ? await projectRepositoryBindings(tx, workspaceId, projectId) : []
    const bindings = projectId ? await tx.execute(sql`select "environmentId","isDefault" from workspace_project_environments where "projectId"=${projectId} and "workspaceId"=${workspaceId} order by "environmentId"`) : { rows: [] }
    return { policy: policy.rows[0] ?? { mode: 'inherit', repositoryKeys: [], revision: 0 },
      environments: environments.rows.map(row => ({ ...row, repositories: environmentRepositoryRows(row) })),
      // Deprecated for one release: the retired Project bindings, read-only. Runs no longer use them.
      repositories, environmentBindings: bindings.rows }
  }
  return projectId ? withConfiguredProject(reader, workspaceId, projectId, read)
    : withTaskWorkspace(reader, workspaceId, (_workspace, tx) => read(tx))
}

function activeDefaultEnvironment(workspaceId: string, projectId: string, userId: string) {
  return sql`from workspace_project_environments b
    join workspace_environments e on e.id=b."environmentId" and e."workspaceId"=b."workspaceId"
    where b."workspaceId"=${workspaceId} and b."projectId"=${projectId} and b."isDefault"
      and e."archivedAt" is null and (e.scope='workspace' or e."ownerId"=${userId})`
}

/** Read one ordinary variable from the Project's current default environment. */
export async function readProjectEnvironmentVariable(reader: Reader, raw: z.input<typeof projectEnvironmentVariableInput>) {
  const { workspaceId, projectId, name } = projectEnvironmentVariableInput.parse(raw)
  return withConfiguredProject(reader, workspaceId, projectId, async tx => {
    const { rows: [row] } = await tx.execute<{ value: string | null }>(sql`
      SELECT e.configuration->'variables'->>${name}::text AS value
      ${activeDefaultEnvironment(workspaceId, projectId, actorId(reader))}`)
    return row?.value == null ? null : { name, value: row.value }
  })
}

const organizationVariableInput = projectEnvironmentVariableInput.omit({ workspaceId: true }).extend({ organizationId: z.uuid() })

export async function readOrganizationProjectEnvironmentVariable(reader: Reader, raw: z.input<typeof organizationVariableInput>) {
  const { organizationId, projectId, name } = organizationVariableInput.parse(raw)
  // Discovery selects only a candidate. The Workspace lease pins its attachment
  // while the current membership, Project ACL and default Environment are read.
  const { rows: [project] } = await workspacePool.query<{ workspaceId: string }>(`SELECT p."workspaceId"
    FROM workspace_projects p JOIN mikka_organization_workspaces a ON a."workspaceId"=p."workspaceId"
    WHERE p.id=$1 AND a."organizationId"=$2 AND p."archivedAt" IS NULL`, [projectId, organizationId])
  if (!project) throw new GovernanceError('not_found')
  return withTaskWorkspace(reader, project.workspaceId, async (workspace, tx) => {
    if (await memberProjectOrganization(tx, workspace, actorId(reader)) !== organizationId) throw new GovernanceError('not_found')
    return readProjectEnvironmentVariable(reader, { workspaceId: workspace.id, projectId, name })
  })
}

/** Restricted + an empty list is an explicit deny-all policy; no row means inherit. */
export async function saveWorkspaceRepositoryPolicy(reader: Reader, raw: z.input<typeof workspaceRepositoryPolicyInput>) {
  const input = workspaceRepositoryPolicyInput.parse(raw)
  return withTaskWorkspace(reader, input.workspaceId, async (_workspace, tx) => {
    await admin(tx, reader, input.workspaceId)
    await resourceWriteLock(tx, input.workspaceId)
    const current = await tx.execute(sql`select revision from workspace_repository_policies where "workspaceId"=${input.workspaceId}`)
    if (Number(current.rows[0]?.revision ?? 0) !== input.revision) throw new ActionFailureError('projectResourceConflict')
    const revision = input.revision + 1
    const keys = [...new Set(input.repositoryKeys)].sort()
    await tx.execute(sql`insert into workspace_repository_policies("workspaceId",mode,"repositoryKeys",revision,"updatedBy")
      values(${input.workspaceId},${input.mode},${JSON.stringify(keys)}::jsonb,${revision},${actorId(reader)})
      on conflict("workspaceId") do update set mode=excluded.mode,"repositoryKeys"=excluded."repositoryKeys",revision=excluded.revision,"updatedBy"=excluded."updatedBy","updatedAt"=now()`)
    await audit(tx, reader, input.workspaceId, 'repository_policy.changed', null, { revision, mode: input.mode, repositoryCount: keys.length })
    return { revision }
  })
}

function setupRecipe(configuration: EnvironmentConfiguration): ProjectSetupRecipe | null {
  const setup = configuration.setup
  return setup ? { copyFiles: setup.copyFiles, ...(setup.command !== undefined ? { command: setup.command } : {}) } : null
}

async function recordSetupVersion(tx: WorkspaceTransaction, workspaceId: string, id: string, revision: number, configuration: EnvironmentConfiguration) {
  const recipe = setupRecipe(configuration)
  await tx.execute(sql`insert into workspace_environment_setup_versions ("workspaceId","environmentId",revision,recipe)
    select ${workspaceId}::uuid,${id}::uuid,${revision}::integer,nullif(${JSON.stringify(recipe)}::jsonb,'null'::jsonb)
    where not exists (select 1 from (select recipe from workspace_environment_setup_versions where "workspaceId"=${workspaceId}
      and "environmentId"=${id} order by revision desc limit 1) latest
      where latest.recipe is not distinct from nullif(${JSON.stringify(recipe)}::jsonb,'null'::jsonb))`)
}

type EnvironmentWrite = { configuration: EnvironmentConfiguration; repositories: EnvironmentRepository[]; revision: number; archivedAt: Date | null
  defaultMachineSize?: string | null; instructions?: string; scope?: EnvironmentScope; ownerId?: string | null }
async function persistEnvironment(tx: WorkspaceTransaction, reader: Reader, workspaceId: string, id: string, name: string, write: EnvironmentWrite) {
  const { configuration, repositories, revision, archivedAt, defaultMachineSize, instructions } = write
  // Absent optional columns keep their saved values across archive, restore and setup rollback.
  // Scope and owner are set when the row is made; only share/unshare changes them.
  const keepSize = defaultMachineSize === undefined
  const keepInstructions = instructions === undefined
  await tx.execute(sql`insert into workspace_environments(id,"workspaceId",name,configuration,repositories,instructions,revision,"archivedAt","createdBy","updatedBy","defaultMachineSize",scope,"ownerId")
    values(${id},${workspaceId},${name},${JSON.stringify(configuration)}::jsonb,${JSON.stringify(repositories)}::jsonb,${instructions ?? ''},${revision},${archivedAt},${actorId(reader)},${actorId(reader)},${defaultMachineSize ?? null},${write.scope ?? 'workspace'},${write.ownerId ?? null})
    on conflict(id) do update set name=excluded.name,configuration=excluded.configuration,repositories=excluded.repositories,revision=excluded.revision,"archivedAt"=excluded."archivedAt","updatedBy"=excluded."updatedBy","updatedAt"=now(),
      instructions=CASE WHEN ${keepInstructions} THEN workspace_environments.instructions ELSE excluded.instructions END,
      "defaultMachineSize"=CASE WHEN ${keepSize} THEN workspace_environments."defaultMachineSize" ELSE excluded."defaultMachineSize" END`)
  await recordSetupVersion(tx, workspaceId, id, revision, configuration)
}

/** Present rows replace the saved ones and set repositoryKeys to the start rows; an older editor's
 * repositoryKeys keep each saved row's branch and 主仓库 and keep its on-demand rows. */
function nextRepositories(configuration: EnvironmentConfiguration, saved: Pick<EnvironmentRow, 'configuration' | 'repositories'> | null, input?: EnvironmentRepository[]) {
  if (input) return { repositories: input, repositoryKeys: input.filter(row => row.clone === 'start').map(row => row.key) }
  const repositoryKeys = [...new Set(configuration.repositoryKeys)]
  const repositories = environmentRepositoryRows({ configuration: { ...configuration, repositoryKeys }, repositories: saved ? environmentRepositoryRows(saved) : [] })
  return { repositories, repositoryKeys }
}

export async function saveEnvironment(reader: Reader, raw: z.input<typeof saveEnvironmentInput>) {
  const parsed = saveEnvironmentInput.safeParse(raw)
  if (!parsed.success) {
    const tooLong = parsed.error.issues.some(issue => issue.path[0] === 'instructions' && issue.message === 'personalInstructionsTooLong')
    throw new ActionFailureError(tooLong ? 'personalInstructionsTooLong' : 'validationGeneric')
  }
  const input = parsed.data
  const actor = actorId(reader)
  return withTaskWorkspace(reader, input.workspaceId, async (_workspace, tx) => {
    const role = await memberRole(tx, reader, input.workspaceId)
    if (!role) throw new ActionFailureError('workspaceAccessDenied')
    // A member makes personal environments only; shared ones stay with administrators (Alex, 2026-11-25).
    if (!input.id && (input.scope ?? 'workspace') === 'workspace' && role !== 'admin') throw new ActionFailureError('workspaceAccessDenied')
    await resourceWriteLock(tx, input.workspaceId)
    await secretsFit(input.workspaceId, input.configuration)
    const id = input.id ?? randomUUID()
    const current = await tx.execute<{ revision: number; configuration: Partial<EnvironmentConfiguration> | null; scope: EnvironmentScope; ownerId: string | null; repositories: unknown }>(
      sql`select revision,configuration,scope,"ownerId",repositories from workspace_environments where id=${id} and "workspaceId"=${input.workspaceId} for update`)
    const saved = current.rows[0]
    // Someone else's personal environment does not exist for this reader.
    if (input.id && (!saved || !environmentVisibleTo(saved, actor) || Number(saved.revision) !== input.revision)) throw new ActionFailureError('projectResourceConflict')
    if (saved && !environmentManageableBy(saved, actor, role)) throw new ActionFailureError('workspaceAccessDenied')
    // Scope changes only through share/unshare, which keep the owner and record who changed it.
    if (saved && input.scope && input.scope !== saved.scope) throw new ActionFailureError('validationGeneric')
    const existingConfig = saved?.configuration ?? null
    const revision = Number(current.rows[0]?.revision ?? 0) + 1
    // Preserve newer optional fields when an older editor submits a payload that omits them.
    // Callers clear startScript explicitly by passing an empty string.
    const nextStartScript = input.configuration.startScript === undefined
      ? (typeof existingConfig?.startScript === 'string' && existingConfig.startScript.trim() ? existingConfig.startScript.trim() : undefined)
      : (input.configuration.startScript.trim() || undefined)
    const nextNetworkAccess = input.configuration.networkAccess ?? existingConfig?.networkAccess ?? 'inherit'
    const configuration: EnvironmentConfiguration = {
      ...input.configuration,
      networkAccess: nextNetworkAccess,
      ...(nextStartScript ? { startScript: nextStartScript } : { startScript: undefined }),
      secretIds: [...new Set(input.configuration.secretIds)],
    }
    if (configuration.startScript === undefined) delete configuration.startScript
    const { repositories, repositoryKeys } = nextRepositories(input.configuration, saved
      ? { configuration: environmentConfiguration.safeParse(saved.configuration).data ?? environmentConfiguration.parse({}), repositories: saved.repositories } : null, input.repositories)
    configuration.repositoryKeys = repositoryKeys
    const scope = saved?.scope ?? input.scope ?? 'workspace'
    if (scope === 'workspace' && role !== 'admin' && configuration.setup) configuration.setup.approved = false
    await persistEnvironment(tx, reader, input.workspaceId, id, input.name, { configuration, repositories, revision, archivedAt: input.archived ? new Date() : null,
      defaultMachineSize: input.defaultMachineSize, instructions: input.instructions, scope, ownerId: saved ? saved.ownerId : scope === 'personal' ? actor : null })
    await audit(tx, reader, input.workspaceId, input.archived ? 'environment.archived' : 'environment.saved', id, { revision, ...(saved ? {} : { scope }) })
    await workspaceListChanged(tx, input.workspaceId, ['workspace_settings'])
    return { id, revision }
  })
}

/**
 * Share a personal environment with the workspace (its owner only: nobody else can see it), or take a shared one
 * back to 「仅我」 (its owner, or an administrator under the existing policy that administrators manage shared
 * environments; a shared environment with no owner goes to the administrator who takes it back). Idempotent; the
 * revision changes when sharing invalidates personal setup approval. Runs
 * by anyone but the owner are refused at their next admission once it is personal.
 */
export async function setEnvironmentScope(reader: Reader, raw: z.input<typeof environmentShareInput>, scope: EnvironmentScope) {
  const parsed = environmentShareInput.safeParse(raw)
  if (!parsed.success) throw new ActionFailureError('validationGeneric')
  const { workspaceId, environmentId } = parsed.data
  const actor = actorId(reader)
  const result = await withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    const role = await memberRole(tx, reader, workspaceId)
    if (!role) throw new ActionFailureError('workspaceAccessDenied')
    await resourceWriteLock(tx, workspaceId)
    const { rows: [row] } = await tx.execute<{ scope: EnvironmentScope; ownerId: string | null; archivedAt: Date | null }>(sql`select scope,"ownerId","archivedAt"
      from workspace_environments where id=${environmentId} and "workspaceId"=${workspaceId} and ${visibleEnvironment(actor)} for update`)
    if (!row) throw new ActionFailureError('projectEnvironmentUnavailable')
    if (row.archivedAt) throw new ActionFailureError('projectArchived')
    if (row.scope === scope) return { id: environmentId, scope, ownerId: row.ownerId, changed: false }
    if (scope === 'workspace' ? row.ownerId !== actor : row.ownerId !== actor && role !== 'admin') throw new ActionFailureError('workspaceAccessDenied')
    const ownerId = row.ownerId ?? actor
    // A personal setup's approval covers its owner only. Sharing a runnable recipe requires a fresh workspace approval.
    const resetApproval = sql`${scope}='workspace' and configuration#>>'{setup,approved}'='true'`
    await tx.execute(sql`update workspace_environments set scope=${scope},"ownerId"=${ownerId},"updatedBy"=${actor},"updatedAt"=now(),
      configuration=case when ${resetApproval} then jsonb_set(configuration,'{setup,approved}','false') else configuration end,
      revision=revision+case when ${resetApproval} then 1 else 0 end
      where id=${environmentId} and "workspaceId"=${workspaceId}`)
    await audit(tx, reader, workspaceId, scope === 'workspace' ? 'environment.shared' : 'environment.unshared', environmentId, { ownerId })
    await workspaceListChanged(tx, workspaceId, ['workspace_settings'])
    return { id: environmentId, scope, ownerId, changed: true }
  })
  return { id: result.id, scope: result.scope, ownerId: result.ownerId }
}

export async function readEnvironmentInstructions(reader: Reader, raw: z.input<typeof environmentInstructionsScope>): Promise<EnvironmentInstructionsView> {
  const parsed = environmentInstructionsScope.safeParse(raw)
  if (!parsed.success) throw new ActionFailureError('validationGeneric')
  const { workspaceId, environmentId } = parsed.data
  return withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    const [member] = await tx.select({ role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorId(reader)), eq(workspaceMembers.status, 'active')))
    const { rows: [row] } = await tx.execute<{ id: string; name: string; instructions: string; revision: number; archivedAt: Date | null; scope: EnvironmentScope; ownerId: string | null }>(
      sql`select id,name,instructions,revision,"archivedAt",scope,"ownerId" from workspace_environments where id=${environmentId} and "workspaceId"=${workspaceId} and ${visibleEnvironment(actorId(reader))}`,
    )
    if (!row) throw new ActionFailureError('projectEnvironmentUnavailable')
    const instructions = row.instructions ?? ''
    return {
      workspaceId,
      environmentId: row.id,
      name: row.name,
      instructions,
      charCount: [...instructions].length,
      maxChars: ENVIRONMENT_INSTRUCTIONS_MAX,
      revision: Number(row.revision),
      archived: Boolean(row.archivedAt),
      canEdit: environmentManageableBy(row, actorId(reader), member?.role ?? null) && !row.archivedAt,
      source: instructions ? 'environment' : 'default',
    }
  })
}

export async function saveEnvironmentInstructions(reader: Reader, raw: unknown): Promise<EnvironmentInstructionsView> {
  const parsed = saveEnvironmentInstructionsInput.safeParse(raw)
  if (!parsed.success) {
    const tooLong = parsed.error.issues.some(issue => issue.path[0] === 'instructions' && issue.message === 'personalInstructionsTooLong')
    throw new ActionFailureError(tooLong ? 'personalInstructionsTooLong' : 'validationGeneric')
  }
  const input = parsed.data
  return withTaskWorkspace(reader, input.workspaceId, async (_workspace, tx) => {
    const role = await memberRole(tx, reader, input.workspaceId)
    if (!role) throw new ActionFailureError('workspaceAccessDenied')
    await resourceWriteLock(tx, input.workspaceId)
    const { rows: [current] } = await tx.execute<{ id: string; name: string; revision: number; archivedAt: Date | null; scope: EnvironmentScope; ownerId: string | null }>(
      sql`select id,name,revision,"archivedAt",scope,"ownerId" from workspace_environments where id=${input.environmentId} and "workspaceId"=${input.workspaceId} and ${visibleEnvironment(actorId(reader))} for update`,
    )
    if (!current) throw new ActionFailureError('projectEnvironmentUnavailable')
    if (!environmentManageableBy(current, actorId(reader), role)) throw new ActionFailureError('workspaceAccessDenied')
    if (current.archivedAt) throw new ActionFailureError('projectArchived')
    if (input.revision !== undefined && Number(current.revision) !== input.revision) throw new ActionFailureError('projectResourceConflict')
    const revision = Number(current.revision) + 1
    await tx.execute(sql`update workspace_environments set instructions=${input.instructions},revision=${revision},"updatedBy"=${actorId(reader)},"updatedAt"=now()
      where id=${input.environmentId} and "workspaceId"=${input.workspaceId}`)
    await audit(tx, reader, input.workspaceId, 'environment.instructions_saved', input.environmentId, { revision, charCount: [...input.instructions].length })
    await workspaceListChanged(tx, input.workspaceId, ['workspace_settings'])
    return {
      workspaceId: input.workspaceId,
      environmentId: input.environmentId,
      name: current.name,
      instructions: input.instructions,
      charCount: [...input.instructions].length,
      maxChars: ENVIRONMENT_INSTRUCTIONS_MAX,
      revision,
      archived: false,
      canEdit: true,
      source: input.instructions ? 'environment' : 'default',
    }
  })
}

/**
 * The Environment a new Bot works in when the workspace has none (lib/bot-environment.ts):
 * any active member may make it, through the same lock, setup history and audit
 * as saveEnvironment. Under the write lock an Environment made meanwhile wins,
 * so two Bots created at once never make two.
 */
export async function ensureBotEnvironment(reader: Reader, workspaceId: string, name: string, repositoryKeys: string[]): Promise<string> {
  const configuration = environmentConfiguration.parse({ repositoryKeys: [...new Set(repositoryKeys)] })
  return withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    await resourceWriteLock(tx, workspaceId)
    // A Bot works for the whole workspace: only a shared environment can be its default.
    const { rows: [existing] } = await tx.execute<{ id: string }>(sql`select id from workspace_environments where "workspaceId"=${workspaceId} and "archivedAt" is null and scope='workspace' order by "createdAt",id limit 1`)
    if (existing) return existing.id
    const id = randomUUID()
    await persistEnvironment(tx, reader, workspaceId, id, name, { configuration, repositories: environmentRepositoryRows({ configuration, repositories: [] }), revision: 1, archivedAt: null })
    await audit(tx, reader, workspaceId, 'environment.saved', id, { revision: 1, source: 'bot' })
    await workspaceListChanged(tx, workspaceId, ['workspace_settings'])
    return id
  })
}

/** Whether the reader may use this live Environment: a shared one, or their own personal one.
 * `shared`: a workspace-wide user (a Bot) may bind only a shared one. */
export async function readableEnvironment(reader: Reader, workspaceId: string, environmentId: string, options: { shared?: boolean } = {}): Promise<boolean> {
  return withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    const { rowCount } = await tx.execute(sql`select 1 from workspace_environments where id=${environmentId} and "workspaceId"=${workspaceId} and "archivedAt" is null
      and ${options.shared ? sql`scope='workspace'` : visibleEnvironment(actorId(reader))}`)
    return Boolean(rowCount)
  })
}

const currentSetupScope = z.object({ workspaceId: z.uuid(), projectId: z.uuid() }).strict()

type SelectedProjectRepository = Pick<ProjectRepositoryBinding, 'repositoryKey' | 'baseBranch' | 'environmentId'> & { selectedEnvironmentId: string | null }

/** The Run admission and current setup view resolve the same Project repository overrides and default. */
async function configuredProjectBindings(tx: WorkspaceTransaction, workspaceId: string, projectId: string) {
  const { rows } = await tx.execute<{ repositoryKey: string | null; baseBranch: string | null; environmentId: string | null; defaultEnvironmentId: string | null }>(sql`
    select r."repositoryKey", r."baseBranch", r."environmentId", d."environmentId" as "defaultEnvironmentId"
    from (values (${workspaceId}::uuid, ${projectId}::uuid)) as scope(workspace_id, project_id)
    left join workspace_project_environments d on d."workspaceId"=scope.workspace_id and d."projectId"=scope.project_id and d."isDefault"
    left join workspace_project_repositories r on r."workspaceId"=scope.workspace_id and r."projectId"=scope.project_id
    order by r."repositoryKey"`)
  const repositories: SelectedProjectRepository[] = []
  for (const { repositoryKey, baseBranch, environmentId, defaultEnvironmentId } of rows) {
    if (repositoryKey !== null) repositories.push({ repositoryKey, baseBranch, environmentId, selectedEnvironmentId: environmentId ?? defaultEnvironmentId })
  }
  return { repositories, defaultEnvironmentId: rows[0]?.defaultEnvironmentId ?? null }
}

/** An explicit repository selection survives archival. Such an Environment has no readable current recipe. */
export async function readCurrentProjectSetup(reader: Reader, input: z.input<typeof currentSetupScope>) {
  const { workspaceId, projectId } = currentSetupScope.parse(input)
  return withConfiguredProject(reader, workspaceId, projectId, async (tx, project) => {
    if (project.archivedAt) throw new ActionFailureError('projectNotFound')
    const { repositories, defaultEnvironmentId } = await configuredProjectBindings(tx, workspaceId, projectId)
    const ids = new Set(repositories.flatMap(repo => repo.environmentId ? [repo.environmentId] : []))
    if (defaultEnvironmentId) ids.add(defaultEnvironmentId)
    const rows = ids.size ? (await tx.execute<{ id: string; revision: number; setup: unknown }>(sql`
      select id, revision, configuration->'setup' as setup from workspace_environments
      where "workspaceId"=${workspaceId} and "archivedAt" is null and ${visibleEnvironment(actorId(reader))}
        and id in (${sql.join([...ids].map(id => sql`${id}::uuid`), sql`, `)})
      order by id`)).rows : []
    const environments = rows.map(row => {
      const setup = environmentConfiguration.shape.setup.nullable().safeParse(row.setup)
      if (!setup.success) throw new ActionFailureError('projectEnvironmentUnavailable', undefined, undefined, { cause: setup.error })
      return { id: row.id, revision: row.revision, setup: setup.data ?? null }
    })
    return { defaultEnvironmentId, repositories, environments }
  })
}

type SetupScope = z.infer<typeof projectSetupScope>
/** Setup history belongs to the environment (the retired Project scope is ignored): a reader sees the
 * environments they can see, and a restore needs the same right as editing the environment. */
async function withEnvironmentSetup<T>(reader: Reader, scope: SetupScope, write: boolean, work: (tx: WorkspaceTransaction, environment: EnvironmentRow, impact: { projects: number; tasks: number }, bindingSnapshot: string) => Promise<T>) {
  const { workspaceId, environmentId } = scope
  const actor = actorId(reader)
  return withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    const role = await memberRole(tx, reader, workspaceId)
    if (!role) throw new ActionFailureError('workspaceAccessDenied')
    if (write) await resourceWriteLock(tx, workspaceId)
    else {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('mikka-team-relations',0))`)
      await resourceLock(tx, workspaceId, false)
    }
    const environment = (await tx.execute<EnvironmentRow>(sql`select ${environmentColumns} from workspace_environments
      where id=${environmentId} and "workspaceId"=${workspaceId} and "archivedAt" is null and ${visibleEnvironment(actor)}`)).rows[0]
    if (!environment) throw new ActionFailureError('projectEnvironmentUnavailable')
    if (write && !environmentManageableBy(environment, actor, role)) throw new ActionFailureError('workspaceAccessDenied')
    const { rows: [counts] } = await tx.execute<{ projects: number; tasks: number; taskSet: string | null }>(sql`select
      (select count(*)::int from (select "projectId" from workspace_project_environments where "workspaceId"=${workspaceId} and "environmentId"=${environmentId}
        union select "projectId" from workspace_project_repositories where "workspaceId"=${workspaceId} and "environmentId"=${environmentId}) bound) as projects,
      count(*)::int as tasks, md5(string_agg("issueId"::text,',' order by "issueId")) as "taskSet"
      from workspace_task_environments where "workspaceId"=${workspaceId} and "environmentId"=${environmentId}`)
    // The restore confirmation names who it reaches; a change in that reach makes the confirmation stale.
    const snapshot = createHash('sha256').update(JSON.stringify([workspaceId, environmentId, environment.scope, environment.ownerId, counts.taskSet])).digest('hex')
    return work(tx, environment, counts, snapshot)
  })
}

export async function listProjectSetupVersions(reader: Reader, raw: z.input<typeof listProjectSetupVersionsInput>): Promise<ProjectSetupHistory> {
  const input = listProjectSetupVersionsInput.parse(raw)
  return withEnvironmentSetup(reader, input, false, async (tx, environment, impact, bindingSnapshot) => {
    const page = await tx.execute<{ revision: number; recordedAt: Date | string; recipe: ProjectSetupRecipe | null }>(sql`
      select revision,"recordedAt",recipe from workspace_environment_setup_versions where "workspaceId"=${input.workspaceId}
      and "environmentId"=${input.environmentId} ${input.before ? sql`and revision < ${input.before}` : sql``} order by revision desc limit 31`)
    const versions = page.rows.slice(0, 30).map(row => ({ ...row, recordedAt: new Date(row.recordedAt).toISOString() }))
    return { revision: environment.revision, bindingSnapshot, totalProjects: impact.projects, totalTasks: impact.tasks, versions, before: page.rows.length > 30 ? versions.at(-1)!.revision : null }
  })
}

export async function rollbackProjectSetup(reader: Reader, raw: z.input<typeof rollbackProjectSetupInput>) {
  const input = rollbackProjectSetupInput.parse(raw)
  return withEnvironmentSetup(reader, input, true, async (tx, environment, _impact, snapshot) => {
    if (environment.revision !== input.revision || snapshot !== input.bindingSnapshot) throw new ActionFailureError('projectResourceConflict')
    const historical = (await tx.execute<{ recipe: ProjectSetupRecipe | null }>(sql`select recipe from workspace_environment_setup_versions
      where "workspaceId"=${input.workspaceId} and "environmentId"=${environment.id} and revision=${input.version}`)).rows[0]
    if (!historical) throw new ActionFailureError('projectEnvironmentUnavailable')
    const { setup: _previous, ...current } = environment.configuration
    const configuration = environmentConfiguration.parse({ ...current, ...(historical.recipe ? { setup: { ...historical.recipe, approved: false } } : {}) })
    const revision = environment.revision + 1
    await persistEnvironment(tx, reader, input.workspaceId, environment.id, environment.name, { configuration, repositories: environmentRepositoryRows(environment), revision, archivedAt: null })
    await audit(tx, reader, input.workspaceId, 'environment.setup_restored', environment.id, { ...(input.projectId ? { projectId: input.projectId } : {}), fromRevision: input.version, revision })
    await workspaceListChanged(tx, input.workspaceId, ['workspace_settings'])
    return { id: environment.id, revision }
  })
}

/** `environmentId`: an Environment the run's request chose, used instead of the task's 「环境」 (it must still fit). */
export type ProjectExecutionInput = { userId: string; workspaceId: string; issueId: string; repositoryKey: string | null; baseBranch: string | null; runtime: 'local' | 'cloud'; harness: string; environmentId?: string; botId?: string | null }

/** Hold current membership and policy through the caller's Run transaction. Existing
 * GitHub/device authorization remains mandatory at that caller; an environment grants none.
 *
 * The environment is the request's choice, else the task's 「环境」 (decision 2026-11-26-0110 rules 3-5). A
 * personal one admits only its owner's runs. The workspace repository policy is the only repository gate: a
 * repository outside the environment is admitted by it and cloned on demand, recorded on the run as
 * `repositoryClone: 'demand'`. The environment's row for the repository supplies its base branch. */
export async function withProjectExecution<T>(input: ProjectExecutionInput, operation: (snapshot: ProjectExecutionSnapshot) => Promise<T>, requireExisting = false): Promise<T> {
  return withProjectResourceLease(input.userId, input.workspaceId, async tx => {
    const policy = await tx.execute<{ mode: string; repositoryKeys: string[]; revision: number }>(sql`select mode,"repositoryKeys",revision from workspace_repository_policies where "workspaceId"=${input.workspaceId}`)
    if (policy.rows[0]?.mode === 'restricted' && input.repositoryKey && !policy.rows[0].repositoryKeys.includes(input.repositoryKey)) throw new ActionFailureError('projectRepositoryDenied')
    // The Project stays the task's container until its removal; it no longer selects repositories or environments.
    const project = await tx.execute<{ id: string; revision: number; archivedAt: Date | null }>(sql`select p.id,p.revision,p."archivedAt" from workspace_project_tasks t join workspace_projects p on p.id=t."projectId" and p."workspaceId"=t."workspaceId" where t."issueId"=${input.issueId} and t."workspaceId"=${input.workspaceId}`)
    const selected = project.rows[0]
    if (selected?.archivedAt) throw new ActionFailureError('projectArchived')
    const { rows: [taskSettings] } = await tx.execute<{ environmentId: string | null; legacyBranch: string | null }>(sql`select
      (select "environmentId" from workspace_task_environments where "issueId"=${input.issueId} and "workspaceId"=${input.workspaceId}) as "environmentId",
      (select "baseBranch" from workspace_task_legacy_repository_branches where "workspaceId"=${input.workspaceId}
        and "issueId"=${input.issueId} and "repositoryKey"=${input.repositoryKey}) as "legacyBranch"`)
    const selectedId = input.environmentId ?? taskSettings.environmentId
    const bot = !selectedId && input.botId ? (await db.execute<{ environmentId: string | null }>(sql`
      select "environmentId" from bots where id=${input.botId} and "workspaceId"=${input.workspaceId}
      and "ownerId"=${input.userId} and "archivedAt" is null`)).rows[0] : null
    const environmentId = selectedId ?? bot?.environmentId
    let baseBranch = environmentId ? input.baseBranch : taskSettings.legacyBranch ?? input.baseBranch
    let repositoryClone: ProjectExecutionSnapshot['repositoryClone'] = null
    let environment: ProjectExecutionSnapshot['environment'] = null
    if (environmentId) {
      const rows = await tx.execute<EnvironmentRow>(sql`select ${environmentColumns} from workspace_environments where id=${environmentId} and "workspaceId"=${input.workspaceId} and "archivedAt" is null`)
      const row = rows.rows[0]
      // Someone else's personal environment does not exist for this run.
      if (!row || !environmentVisibleTo(row, input.userId) || (!selectedId && row.scope !== 'workspace')) throw new ActionFailureError('projectEnvironmentUnavailable')
      const parsed = environmentConfiguration.safeParse(row.configuration)
      if (!parsed.success) throw new ActionFailureError('projectEnvironmentUnavailable')
      const config = parsed.data
      if ((config.runtime !== 'any' && config.runtime !== input.runtime) || (config.harness !== 'any' && config.harness !== input.harness)) throw new ActionFailureError('projectEnvironmentUnavailable')
      await secretsFit(input.workspaceId, config, input.repositoryKey)
      const repositories = environmentRepositoryRows({ configuration: config, repositories: row.repositories })
      if (policy.rows[0]?.mode === 'restricted' && repositories.some(repo => repo.clone === 'start'
        && !policy.rows[0].repositoryKeys.includes(repo.key))) throw new ActionFailureError('projectRepositoryDenied')
      const configured = input.repositoryKey ? repositories.find(item => item.key === input.repositoryKey) : undefined
      if (input.repositoryKey) repositoryClone = configured?.clone ?? 'demand'
      baseBranch = configured ? configured.baseBranch : input.baseBranch
      environment = { id: row.id, revision: row.revision, name: row.name, ...config, scope: row.scope, repositories, ...(input.environmentId ? { chosen: true as const } : {}),
        ...(isMachineSize(row.defaultMachineSize) ? { defaultMachineSize: row.defaultMachineSize } : {}) }
    }
    return operation({ version: 1, workspaceId: input.workspaceId, projectId: selected?.id ?? null, projectRevision: selected?.revision ?? null, policyRevision: policy.rows[0]?.revision ?? 0,
      repositoryKey: input.repositoryKey, baseBranch, ...(repositoryClone ? { repositoryClone } : {}), environment })
  }, requireExisting)
}

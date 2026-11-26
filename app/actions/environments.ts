'use server'

import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { daemonTestMode, normalizeRepository } from '@mikka/protocol/repository'
import { requireUser } from '@/lib/issue-access'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { accessibleProjects } from '@/lib/project-access'
import { db } from '@/lib/db'
import { projectDb } from '@/lib/db/projects'
import { deviceRepos, githubRepositoryInstallations } from '@/lib/db/schema'
import { workspaceSecrets } from '@/lib/db/secrets-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { environmentManageableBy, listProjectResources } from '@/lib/project-resources/store'
import { projectRepositoryKey, type EnvironmentConfiguration, type EnvironmentNetworkAccess, type EnvironmentRepository, type EnvironmentScope, type taskEnvironmentInput, type taskEnvironmentsInput } from '@/lib/project-resources/contracts'
import { runAction } from '@/lib/action-error'
import type { z } from 'zod'
import { isMachineSize, type MachineSize } from '@/lib/cloud-computer/machine-pricing'
import { e2bMachineOptions, type E2BComputeSpec } from '@/lib/cloud-computer/e2b-template-pricing'
import { isCloudEdition } from '@/lib/edition'
import type { CloudTemplateKind } from '@/lib/cloud-template-models'
import type { SecretDelivery } from '@/lib/secrets/delivery'

export type EnvironmentView = { id: string; name: string; revision: number; configuration: EnvironmentConfiguration & { networkAccess: EnvironmentNetworkAccess }; instructions?: string; archived: boolean; defaultMachineSize: MachineSize | null
  /** 'personal' (「仅我」) is listed only for its owner; 'workspace' is shared. */
  scope: EnvironmentScope
  /** The owner of a personal environment, or the member who shared it; null for a shared one made by an administrator. */
  ownerId: string | null
  /** Every repository row: cloned at start (configuration.repositoryKeys) or on demand, with base branch and 主仓库. */
  repositories: EnvironmentRepository[]
  /** Edit, archive, restore its setup. */
  canEdit: boolean
  /** Share with the workspace (its owner, while personal). */
  canShare: boolean
  /** Take back to 「仅我」 (its owner or an administrator, while shared). */
  canUnshare: boolean }
/** Deprecated for one release: the retired Project default-environment bindings, read-only. */
export type EnvironmentProject = { id: string; name: string; revision: number; environmentId: string | null; canEditProperties: boolean }
export type EnvironmentAvailableRepository = { key: string; label: string }
export type EnvironmentAvailableSecret = {
  id: string
  name: string
  scopeType: 'workspace' | 'repository'
  scopeRef: string
  delivery: SecretDelivery
}
export type EnvironmentsView = {
  environments: EnvironmentView[]
  /** Deprecated for one release (see EnvironmentProject). */
  projects: EnvironmentProject[]
  /** Create shared environments (administrators). */
  canManage: boolean
  /** Create personal 「仅我」 environments (every active member). */
  canCreatePersonal: boolean
  availableRepositories: EnvironmentAvailableRepository[]
  availableSecrets: EnvironmentAvailableSecret[]
  e2bMachineOptions?: (E2BComputeSpec & { kind: CloudTemplateKind })[]
}

function repositoryLabel(key: string): string {
  const parts = key.split('/')
  return parts.length >= 4 ? `${parts[2]}/${parts[3]}` : key
}

/** The editor and admission use the same Workspace environments and Project bindings. */
export async function listEnvironments(workspaceId?: string): Promise<EnvironmentsView> {
  const user = await requireUser()
  const context = await loadWorkspaceContext(workspaceId, user)
  return withTaskWorkspace(user, context.workspace.id, async (_workspace, tx) => {
    const [resources, projects] = await Promise.all([
      listProjectResources(user, context.workspace.id),
      accessibleProjects(user, projectDb, context.workspace.id),
    ])
    const ids = projects.filter(project => !project.archivedAt).map(project => project.id)
    const [bindings, projectRepos, secretRows, githubRows, deviceRepoRows, memberRows] = await Promise.all([
      ids.length ? projectDb.execute<{ projectId: string; environmentId: string }>(sql`
        select "projectId","environmentId" from workspace_project_environments
        where "workspaceId"=${context.workspace.id} and "projectId" in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`,`)}) and "isDefault"`) : Promise.resolve({ rows: [] }),
      ids.length ? projectDb.execute<{ repositoryKey: string }>(sql`
        select distinct "repositoryKey" from workspace_project_repositories
        where "workspaceId"=${context.workspace.id} and "projectId" in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`,`)})`) : Promise.resolve({ rows: [] }),
      // Secret metadata only (never ciphertext/iv/values): members and admins may list workspace secrets per lib/secrets/permissions.ts.
      db.select({
        id: workspaceSecrets.id,
        name: workspaceSecrets.name,
        scopeType: workspaceSecrets.scopeType,
        scopeRef: workspaceSecrets.scopeRef,
        delivery: workspaceSecrets.delivery,
      })
        .from(workspaceSecrets)
        .where(and(
          eq(workspaceSecrets.workspaceId, context.workspace.id),
          eq(workspaceSecrets.kind, 'secret'),
          inArray(workspaceSecrets.scopeType, ['workspace', 'repository']),
        ))
        .orderBy(asc(workspaceSecrets.name), asc(workspaceSecrets.scopeType), asc(workspaceSecrets.scopeRef)),
      db.select({ remoteKey: githubRepositoryInstallations.remoteKey })
        .from(githubRepositoryInstallations)
        .where(eq(githubRepositoryInstallations.userId, user.id)),
      db.select({ repoPath: deviceRepos.repoPath, remoteUrl: deviceRepos.remoteUrl })
        .from(deviceRepos)
        .where(eq(deviceRepos.userId, user.id)),
      // The context can predate a role change. Membership is now locked; expose
      // management only from the role that remains authoritative for this read.
      tx.select({ role: workspaceMembers.role }).from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, context.workspace.id), eq(workspaceMembers.userId, user.id), eq(workspaceMembers.status, 'active'))),
    ])
    const defaults = new Map(bindings.rows.map(row => [row.projectId, row.environmentId]))
    const member = memberRows[0]
    const policyKeys = Array.isArray(resources.policy.repositoryKeys) ? resources.policy.repositoryKeys : []
    const restrictedAllowlist = resources.policy.mode === 'restricted' ? new Set(policyKeys) : null
    const normalizeOptions = { allowFile: daemonTestMode(process.env) }
    const deviceRepoKeys = deviceRepoRows.flatMap(row => {
      if (row.repoPath.startsWith('v2/')) return [row.repoPath]
      if (!row.remoteUrl) return []
      try {
        return [normalizeRepository(row.remoteUrl, normalizeOptions).key]
      } catch {
        return []
      }
    })
    const candidateKeys = new Set<string>()
    for (const rawKey of [
      ...policyKeys,
      ...resources.environments.flatMap(env => [...(env.configuration.repositoryKeys ?? []), ...env.repositories.map(row => row.key)]),
      ...projectRepos.rows.map(row => row.repositoryKey),
      ...githubRows.map(row => row.remoteKey),
      ...deviceRepoKeys,
    ]) {
      const parsed = projectRepositoryKey.safeParse(rawKey)
      if (!parsed.success) continue
      if (restrictedAllowlist && !restrictedAllowlist.has(parsed.data)) continue
      candidateKeys.add(parsed.data)
    }
    const availableRepositories: EnvironmentAvailableRepository[] = [...candidateKeys]
      .sort((a, b) => a.localeCompare(b))
      .map(key => ({ key, label: repositoryLabel(key) }))
    const availableSecrets: EnvironmentAvailableSecret[] = secretRows.map(row => ({
      id: row.id,
      name: row.name,
      scopeType: row.scopeType as 'workspace' | 'repository',
      scopeRef: row.scopeRef,
      delivery: row.delivery ?? { mode: 'protected' },
    }))
    return {
      environments: resources.environments.map(({ id, name, revision, configuration, instructions, archivedAt, defaultMachineSize, scope, ownerId, repositories }) => {
        const canEdit = environmentManageableBy({ scope, ownerId }, user.id, member?.role ?? null)
        return {
          id,
          name,
          revision,
          configuration: { ...configuration, networkAccess: configuration.networkAccess ?? 'inherit' },
          instructions: instructions ?? '',
          archived: Boolean(archivedAt),
          defaultMachineSize: isMachineSize(defaultMachineSize) ? defaultMachineSize : null,
          scope,
          ownerId,
          repositories,
          canEdit,
          canShare: Boolean(member) && !archivedAt && scope === 'personal' && ownerId === user.id,
          canUnshare: Boolean(member) && !archivedAt && scope === 'workspace' && (ownerId === user.id || member?.role === 'admin'),
        }
      }),
      projects: projects.filter(project => !project.archivedAt).map(({ id, name, revision, canEditProperties }) => ({ id, name, revision, canEditProperties, environmentId: defaults.get(id) ?? null })),
      canManage: member?.role === 'admin',
      canCreatePersonal: Boolean(member),
      availableRepositories,
      availableSecrets,
      ...(isCloudEdition() ? { e2bMachineOptions: e2bMachineOptions() } : {}),
    }
  })
}

/** Set or clear a task's 「环境」 (replaces its Project's default environment). */
export async function setTaskEnvironment(input: z.input<typeof taskEnvironmentInput>) {
  const { setTaskEnvironment } = await import('@/lib/project-resources/task-environment')
  return runAction(async () => setTaskEnvironment(await requireUser(), input))
}

/** The 「环境」 of up to 200 tasks the reader can see. */
export async function listTaskEnvironments(input: z.input<typeof taskEnvironmentsInput>) {
  const { readTaskEnvironments } = await import('@/lib/project-resources/task-environment')
  return runAction(async () => ({ tasks: await readTaskEnvironments(await requireUser(), input) }))
}

export async function getEnvironmentSnapshot(input: import('@/lib/project-resources/environment-snapshot-contract').SnapshotInput) {
  const { readEnvironmentSnapshot } = await import('@/lib/project-resources/environment-snapshots')
  return runAction(async () => readEnvironmentSnapshot(await requireUser(), input))
}

export async function buildEnvironmentSnapshot(input: import('@/lib/project-resources/environment-snapshot-contract').SnapshotInput) {
  const { requestEnvironmentSnapshot } = await import('@/lib/project-resources/environment-snapshots')
  return runAction(async () => requestEnvironmentSnapshot(await requireUser(), input))
}

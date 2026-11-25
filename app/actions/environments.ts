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
import { listProjectResources } from '@/lib/project-resources/store'
import { projectRepositoryKey, type EnvironmentConfiguration, type EnvironmentNetworkAccess } from '@/lib/project-resources/contracts'
import { isMachineSize, type MachineSize } from '@/lib/cloud-computer/machine-pricing'
import type { SecretDelivery } from '@/lib/secrets/delivery'

export type EnvironmentView = { id: string; name: string; revision: number; configuration: EnvironmentConfiguration & { networkAccess: EnvironmentNetworkAccess }; instructions?: string; archived: boolean; defaultMachineSize: MachineSize | null }
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
  projects: EnvironmentProject[]
  canManage: boolean
  availableRepositories: EnvironmentAvailableRepository[]
  availableSecrets: EnvironmentAvailableSecret[]
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
      ...resources.environments.flatMap(env => env.configuration.repositoryKeys ?? []),
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
      environments: resources.environments.map(({ id, name, revision, configuration, instructions, archivedAt, defaultMachineSize }) => ({
        id,
        name,
        revision,
        configuration: { ...configuration, networkAccess: configuration.networkAccess ?? 'inherit' },
        instructions: instructions ?? '',
        archived: Boolean(archivedAt),
        defaultMachineSize: isMachineSize(defaultMachineSize) ? defaultMachineSize : null,
      })),
      projects: projects.filter(project => !project.archivedAt).map(({ id, name, revision, canEditProperties }) => ({ id, name, revision, canEditProperties, environmentId: defaults.get(id) ?? null })),
      canManage: member?.role === 'admin',
      availableRepositories,
      availableSecrets,
    }
  })
}

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

/** Configure actual canonical Project/Environment rows through the production
 * resource writers. Fixtures still queue and continue through real admission.
 * The environment is the task's 「环境」 and carries the repository's base branch
 * (decision 2026-11-26-0110 rules 4-5); the Project only contains the task. */
export async function seedRunProjectResources(pool: Pool, input: {
  ownerId: string; workspaceId: string; issueId: string; repositoryKey: string;
  runtime: 'local' | 'cloud'; harness: 'codex' | 'claude_code'; environment?: boolean; baseBranch?: string | null;
}) {
  const resources = await import('../../lib/project-resources/store')
  const { setTaskEnvironment } = await import('../../lib/project-resources/task-environment')
  const projectId = randomUUID()
  await pool.query(`INSERT INTO workspace_projects(id,"userId","workspaceId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision)
    VALUES($1,$2,$3,'Run resource fixture','','','planned','none','','','','','[]',1)`, [projectId, input.ownerId, input.workspaceId])
  // Project archive and other ACL-guarded project writers require the same
  // policy row that the production creation transaction registers.
  const { registerProjectAccess } = await import('../../lib/resource-access/projects')
  await registerProjectAccess(input.ownerId, projectId, input.workspaceId)
  const linked = await pool.query(`INSERT INTO workspace_project_tasks("issueId","projectId","workspaceId")
    SELECT id,$1,"workspaceId" FROM issues WHERE id=$2 AND "workspaceId"=$3 AND "ownershipState"='bound'`,
  [projectId, input.issueId, input.workspaceId])
  if (linked.rowCount !== 1) throw new Error('Run resource fixture needs a bound Task in its canonical Workspace')
  const configuration = { runtime: input.runtime, harness: input.harness, repositoryKeys: [input.repositoryKey],
    variables: { RESOURCE_FIXTURE: 'original' }, setup: { command: 'node --version', copyFiles: [], approved: true } }
  const repositories = (baseBranch: string) => [{ key: input.repositoryKey, clone: 'start' as const, baseBranch, primary: true }]
  const create = () => resources.saveEnvironment(input.ownerId, {
    workspaceId: input.workspaceId, name: 'Frozen Run environment', configuration, repositories: repositories(input.baseBranch ?? 'main'),
  })
  const assign = async (environmentId: string) => {
    const { rows: [task] } = await pool.query<{ revision: number }>('SELECT revision FROM issues WHERE id=$1', [input.issueId])
    await setTaskEnvironment({ id: input.ownerId }, { workspaceId: input.workspaceId, issueId: input.issueId, revision: task.revision, environmentId })
  }
  const environment = input.environment === false ? null : await create()
  if (environment) await assign(environment.id)
  return { projectId, environment,
    async refuse(kind: 'repository' | 'environment-revision' | 'environment-archive' | 'project-archive' | 'branch') {
      if (kind === 'repository') return resources.saveWorkspaceRepositoryPolicy(input.ownerId, {
        workspaceId: input.workspaceId, revision: 0, mode: 'restricted', repositoryKeys: [],
      })
      if (kind === 'project-archive') return (await import('../../lib/project-lifecycle')).setProjectArchive(input.ownerId, input.workspaceId, {
        id: projectId, archived: true, message: 'Fixture archives the Project before continuation',
      })
      // Without an environment there is no configured branch: the task acquires one that names a new branch.
      if (kind === 'branch' && !environment) {
        const created = await create()
        await resources.saveEnvironment(input.ownerId, { workspaceId: input.workspaceId, id: created.id, revision: created.revision,
          name: 'Frozen Run environment', configuration, repositories: repositories('changed-after-start') })
        return assign(created.id)
      }
      if (!environment) throw new Error('This fixture has no Environment to change')
      return resources.saveEnvironment(input.ownerId, { workspaceId: input.workspaceId, id: environment.id, revision: 1,
        name: 'Changed after start', configuration: kind === 'branch' ? configuration : { ...configuration, variables: { RESOURCE_FIXTURE: 'changed' } },
        ...(kind === 'branch' ? { repositories: repositories('changed-after-start') } : {}),
        ...(kind === 'environment-archive' ? { archived: true } : {}) })
    },
  }
}

/** A task's 「环境」 through the production writer, as the task page sets it. */
export async function assignTaskEnvironment(pool: Pool, ownerId: string, workspaceId: string, issueIds: readonly string[], environmentId: string | null) {
  const { setTaskEnvironment } = await import('../../lib/project-resources/task-environment')
  for (const issueId of issueIds) {
    const { rows: [task] } = await pool.query<{ revision: number }>('SELECT revision FROM issues WHERE id=$1', [issueId])
    await setTaskEnvironment({ id: ownerId }, { workspaceId, issueId, revision: task.revision, environmentId })
  }
}

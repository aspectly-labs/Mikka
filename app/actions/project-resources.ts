'use server'
import { z } from 'zod'
import { requireUser } from '@/lib/issue-access'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { ActionFailureError, runAction } from '@/lib/action-error'
import * as store from '@/lib/project-resources/store'
import { projectPullAuthorInput, listProjectSetupVersionsInput, rollbackProjectSetupInput, saveEnvironmentInput, environmentShareInput, listDependencyRepositoriesInput, replaceDependencyRepositoriesInput, projectDefaultEnvironmentInput, projectResourcesInput, workspaceRepositoryPolicyInput } from '@/lib/project-resources/contracts'

export async function listProjectResources(workspaceId: string, projectId?: string) {
  const user = await requireUser()
  const context = await loadWorkspaceContext(z.uuid().parse(workspaceId), user)
  return store.listProjectResources(user, context.workspace.id, projectId ? z.uuid().parse(projectId) : undefined)
}
export async function saveEnvironment(input: z.input<typeof saveEnvironmentInput>) {
  return runAction(async () => {
    const user = await requireUser()
    const saved = await store.saveEnvironment(user, input)
    if (!input.archived) {
      const { buildSnapshotsOnSave } = await import('@/lib/project-resources/environment-snapshots')
      // The settings revision already committed. An enqueue failure is retryable
      // via buildSnapshot and must not misreport the save as a conflict.
      await buildSnapshotsOnSave(user, input.workspaceId, saved.id).catch(() => console.warn('Environment snapshot enqueue failed'))
    }
    return saved
  })
}
/** A personal environment becomes visible to and usable by the whole workspace. */
export async function shareEnvironment(input: z.input<typeof environmentShareInput>) {
  return runAction(async () => store.setEnvironmentScope(await requireUser(), input, 'workspace'))
}
/** A shared environment goes back to 「仅我」 for its owner. */
export async function unshareEnvironment(input: z.input<typeof environmentShareInput>) {
  return runAction(async () => store.setEnvironmentScope(await requireUser(), input, 'personal'))
}
/** Retired with the Project -> repository -> environment bindings (decision 2026-11-26-0110 rule 5). Kept for one
 * release so an older client gets a coded refusal; a task's 「环境」 is set with setTaskEnvironment. */
export async function saveProjectResources(_input: z.input<typeof projectResourcesInput>) {
  return runAction(async () => {
    await requireUser()
    throw new ActionFailureError('projectBindingsRetired')
  })
}
/** Retired; see saveProjectResources. */
export async function setProjectDefaultEnvironment(_input: z.input<typeof projectDefaultEnvironmentInput>) {
  return runAction(async () => {
    await requireUser()
    throw new ActionFailureError('projectBindingsRetired')
  })
}
export async function saveWorkspaceRepositoryPolicy(input: z.input<typeof workspaceRepositoryPolicyInput>) {
  return runAction(async () => store.saveWorkspaceRepositoryPolicy(await requireUser(), input))
}

export async function listProjectSetupVersions(input: z.input<typeof listProjectSetupVersionsInput>) {
  return runAction(async () => store.listProjectSetupVersions(await requireUser(), input))
}
export async function rollbackProjectSetup(input: z.input<typeof rollbackProjectSetupInput>) {
  return runAction(async () => store.rollbackProjectSetup(await requireUser(), input))
}

export async function listDependencyRepositories(input: z.input<typeof listDependencyRepositoriesInput>) {
  const store = await import('@/lib/project-resources/dependency-repositories')
  return runAction(async () => store.listDependencyRepositories(await requireUser(), input))
}
export async function replaceDependencyRepositories(input: z.input<typeof replaceDependencyRepositoriesInput>) {
  const store = await import('@/lib/project-resources/dependency-repositories')
  return runAction(async () => store.replaceDependencyRepositories(await requireUser(), input))
}

export async function searchProjectPullAuthors(input: z.input<typeof projectPullAuthorInput>) {
  const [{ withFreshSession }, { workspaceAction }, { actingContext }] = await Promise.all([
    import('@/lib/fresh-session'), import('@/lib/workspace-admin/action'), import('@/lib/activity-actor'),
  ])
  return withFreshSession(() => workspaceAction(async () => {
    if (actingContext.getStore()) throw new ActionFailureError('authRequired')
    const { projectPullAuthors } = await import('@/lib/project-resources/pull-authors')
    return { authors: await projectPullAuthors(await requireUser(), projectPullAuthorInput.parse(input)) }
  }))
}

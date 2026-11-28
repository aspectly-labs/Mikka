import { projectRepositoryKey, type ProjectExecutionSnapshot } from './contracts'

/** The primary checkout already follows its normal admission and checkout
 * path. Only extra startup rows share the machine with it. */
export function startupRepositories(environment: ProjectExecutionSnapshot['environment'] | undefined, primary: string | null) {
  if (!environment) return []
  const settings = new Map(environment.repositories?.map(row => [row.key, row.baseBranch]))
  return [...new Set(environment.repositoryKeys)].filter(key => key !== primary).map(key => ({
    key: projectRepositoryKey.parse(key), baseBranch: settings.get(key) ?? null,
  }))
}

import { authorizeRunGitHubToken } from '@/lib/github/run-token-authority'
import { createRunGitHubTokenExchange, RUN_GITHUB_MIN_VALIDITY_MS } from '@/lib/github/run-token-exchange'
import { githubMachineCredential } from '@/lib/github/machine-credential'
import { recordRepositoryInstallation, repositoryInstallationFresh } from '@/lib/github/repository-installation'
import { defineRoute } from '@/lib/primitives/define-route'

const exchange = createRunGitHubTokenExchange({
  authorize: authorizeRunGitHubToken,
  issue: (userId, scope) => githubMachineCredential(userId, { remoteKey: scope.remoteKey, minValidityMs: RUN_GITHUB_MIN_VALIDITY_MS }),
  // The run's repository installation, at most once a day per person and repository.
  afterIssue: async (scope, issued) => {
    if (issued.installationId || !scope.remoteKey || !issued.githubAccountId || await repositoryInstallationFresh(scope.userId, scope.remoteKey)) return
    await recordRepositoryInstallation(scope.userId, scope.remoteKey, { token: issued.token, githubAccountId: issued.githubAccountId })
  },
})

// Worker run tokens (`mkw_`) are this endpoint's protocol credential, not a
// Better Auth session; createRunGitHubTokenExchange verifies and re-verifies them.
export const POST = defineRoute<'public', 'none'>(
  {
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  ({ request }) => exchange(request),
)

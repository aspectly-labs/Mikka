import { withDeviceRoute } from '@/lib/device-route'
import { authorizeDesktopGitHubToken, authorizeDeviceRunGitHubToken, authorizeEnvironmentRepositoryToken } from '@/lib/github/desktop-token-authority'
import { createRunGitHubTokenExchange, RUN_GITHUB_MIN_VALIDITY_MS } from '@/lib/github/run-token-exchange'
import { githubMachineCredential } from '@/lib/github/machine-credential'


/** `POST /v1/devices/:deviceId/github-token`: a Bot desktop's git and gh get its owner's own GitHub credential (decision 2026-11-02-1600). */
async function handlePOST(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await params
  const paramsQuery = new URL(request.url).searchParams
  const runId = paramsQuery.get('runId')
  const startup = paramsQuery.get('startupRepository')
  if (startup !== null) {
    if (!runId) return Response.json({ error: 'runGitHubAccessDenied' }, { status: 403, headers: { 'cache-control': 'no-store' } })
    const { githubRepositoryReadCredential } = await import('@/lib/github/user-access')
    return createRunGitHubTokenExchange({
      authorize: value => authorizeEnvironmentRepositoryToken(value, deviceId, runId, startup),
      issue: async userId => ({ token: (await githubRepositoryReadCredential(userId, startup)).token, expiresAt: null }),
    })(request)
  }
  return createRunGitHubTokenExchange({
    authorize: value => runId === null ? authorizeDesktopGitHubToken(value, deviceId) : authorizeDeviceRunGitHubToken(value, deviceId, runId),
    issue: (userId, scope) => githubMachineCredential(userId, { remoteKey: scope.remoteKey, minValidityMs: RUN_GITHUB_MIN_VALIDITY_MS }),
    naturalExpiry: runId !== null,
  })(request)
}

export const POST = withDeviceRoute(handlePOST)

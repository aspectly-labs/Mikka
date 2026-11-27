import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { type ApiSession } from '@/lib/api-auth'
import { issueForUser } from '@/lib/issue-access'
import { pullRequestSchema, readIssueMetadata } from '@/lib/issue-metadata'
import { GitHubAccessError, readAuthorizedPullRequest } from '@/lib/github/user-access'
import { defineRoute } from '@/lib/primitives/define-route'

const inputSchema = z.object({ issueId: z.uuid(), url: pullRequestSchema.shape.url }).strict()
const canonicalUrl = (url: string) => url.replace(/\/$/, '').toLowerCase()
const headers = { 'Cache-Control': 'private, no-store' }
const fail = (error: string, status: number) => RouteResponse.json({ error }, { status, headers })

/** The viewer's channel for this task, or null (the badge then reads on its slow fallback only). */
async function liveWorkspace(issueId: string, viewerId: string) {
  try {
    const [{ documentLiveWorkspace }, { pool }, { workspacePool }] = await Promise.all([import('@/lib/live/panels'), import('@/lib/db'), import('@/lib/workspace-db')])
    return await documentLiveWorkspace(pool, workspacePool, issueId, viewerId)
  } catch { return null }
}

async function handlePOST(request: Request, session: ApiSession) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return fail('originNotAllowed', 403)
  const input = inputSchema.safeParse(await request.json().catch(() => null))
  if (!input.success) return fail('githubPullRequestInvalid', 400)
  const issue = await issueForUser(session.user, input.data.issueId)
  if (!issue) return fail('issueNotFound', 404)
  const linked = readIssueMetadata(issue.content).pullRequests.find(pr => canonicalUrl(pr.url) === canonicalUrl(input.data.url))
  if (!linked) return fail('githubPullRequestNotLinked', 404)
  try {
    const pr = await readAuthorizedPullRequest(request.headers, linked.url)
    if (pr.userId !== session.user.id) return fail('authRequired', 401)
    // GitHub data is returned only to this viewer, never persisted in shared metadata. The task's live
    // channel (#1212) says when a webhook changed a delivered PR, so the badge asks again.
    const live = await liveWorkspace(input.data.issueId, session.user.id)
    return RouteResponse.json({ viewerId: session.user.id, url: pr.url, state: pr.state, updatedAt: pr.updatedAt, title: pr.title, createdAt: pr.createdAt, mergedAt: pr.mergedAt, live: { workspaceId: live } }, { headers })
  } catch (error) {
    return error instanceof GitHubAccessError ? fail(error.code, error.status) : fail('githubUnavailable', 502)
  }
}

export const POST = defineRoute(
  {
    route: '/api/github/pull-request-status',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    onOriginFailure: () => fail('originNotAllowed', 403),
    desktop: true,
  },
  ({ request, session }) => handlePOST(request, session),
)

import { ReviewAuthorityError, withTaskReviewAuthority } from '@/lib/coding-workspace/review-authority'
import { type ReviewSessionKind } from '@/lib/coding-workspace/review-sessions'

export const maxDuration = 30

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers })

export async function GET(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  try {
    return await withTaskReviewAuthority(request, taskId, async (authority, client) => {
      if (new URL(request.url).search) return json({ error: 'invalid_request' }, 400)
      if (authority.machineKind !== 'cloud') return json({ error: 'workspace_unsupported' }, 422)
      const { rows } = await client.query<{ id: string; kind: ReviewSessionKind; name: string; expiresAt: Date }>(
        `SELECT id,kind,name,"expiresAt" FROM coding_review_sessions
          WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "bindingId"=$4
            AND "credentialKind"=$5 AND "credentialId"=$6 AND "revokedAt" IS NULL AND "expiresAt">clock_timestamp()
          ORDER BY kind,name`,
        [authority.runId, authority.ownerId, authority.workspaceId, authority.bindingId,
          authority.credential.kind, authority.credential.id])
      return json({ runId: authority.runId, sessions: rows.map(r => ({ id: r.id, kind: r.kind, name: r.name, expiresAt: r.expiresAt.toISOString() })) })
    })
  } catch (error) {
    if (error instanceof ReviewAuthorityError) return json({ error: error.code }, error.status)
    throw error
  }
}

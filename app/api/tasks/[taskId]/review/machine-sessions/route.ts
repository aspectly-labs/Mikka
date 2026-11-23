import { ReviewAuthorityError, withTaskReviewAuthority } from '@/lib/coding-workspace/review-authority'
import { listReviewSessions } from '@/lib/coding-workspace/review-sessions'

export const maxDuration = 30

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers })

export async function GET(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  try {
    return await withTaskReviewAuthority(request, taskId, async (authority, client) => {
      if (new URL(request.url).search) return json({ error: 'invalid_request' }, 400)
      if (authority.machineKind !== 'cloud') return json({ error: 'workspace_unsupported' }, 422)
      return json({ runId: authority.runId, sessions: await listReviewSessions(authority, client) })
    })
  } catch (error) {
    if (error instanceof ReviewAuthorityError) return json({ error: error.code }, error.status)
    throw error
  }
}

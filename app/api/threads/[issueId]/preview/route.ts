import { NextResponse } from '@/lib/server-runtime/server'
import { auth } from '@/lib/api-auth'
import { readThreadPreview } from '@/lib/thread-preview'

// The 30-second cache is per identity: Vary keeps one signed-in person's
// browser cache from serving the previous owner's reply excerpt.
const headers = { 'Cache-Control': 'private, max-age=30', 'Vary': 'Cookie, Authorization' }

type Context = { params: Promise<{ issueId: string }> }

/** The hover card's light read; the projection may cache for 30 seconds (#2935). */
export const GET = async (request: Request, { params }: Context) => {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
  const { issueId } = await params
  const preview = await readThreadPreview(session.user, issueId)
  if (!preview) return NextResponse.json({ error: 'threadNotFound' }, { status: 404, headers })
  return NextResponse.json(preview, { headers })
}

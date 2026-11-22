import { NextResponse } from '@/lib/server-runtime/server'
import { auth } from '@/lib/api-auth'
import { readThreadPreview } from '@/lib/thread-preview'

type Context = { params: Promise<{ issueId: string }> }

/** The hover card's light read; the projection may cache for 30 seconds (#2935). */
export const GET = async (request: Request, { params }: Context) => {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  const { issueId } = await params
  const preview = await readThreadPreview(session.user.id, issueId)
  if (!preview) return NextResponse.json({ error: 'threadNotFound' }, { status: 404 })
  return NextResponse.json(preview, { headers: { 'Cache-Control': 'private, max-age=30' } })
}

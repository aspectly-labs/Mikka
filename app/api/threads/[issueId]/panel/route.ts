import { NextResponse } from '@/lib/server-runtime/server'
import { auth } from '@/lib/api-auth'
import { readThreadPanelState, threadPanelAccess, threadPanelStateSchema, writeThreadPanelState } from '@/lib/thread-panel'

const headers = { 'Cache-Control': 'private, no-store' }

type Context = { params: Promise<{ issueId: string }> }

/** The right column's per-thread layout ({tabs, active, open}), kept per viewer (#2935). */
export const GET = async (request: Request, { params }: Context) => {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
  const { issueId } = await params
  if (!(await threadPanelAccess(session.user.id, issueId))) return NextResponse.json({ error: 'threadNotFound' }, { status: 404, headers })
  return NextResponse.json(await readThreadPanelState(session.user.id, issueId), { headers })
}

export const PUT = async (request: Request, { params }: Context) => {
  if (request.headers.get('origin') !== new URL(request.url).origin) return NextResponse.json({ error: 'originMismatch' }, { status: 403, headers })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
  const { issueId } = await params
  const parsed = threadPanelStateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalidInput' }, { status: 400, headers })
  if (!(await threadPanelAccess(session.user.id, issueId))) return NextResponse.json({ error: 'threadNotFound' }, { status: 404, headers })
  await writeThreadPanelState(session.user.id, issueId, parsed.data)
  return NextResponse.json(parsed.data, { headers })
}

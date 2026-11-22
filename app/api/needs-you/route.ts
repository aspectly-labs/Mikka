import { NextResponse } from '@/lib/server-runtime/server'
import { auth } from '@/lib/api-auth'
import { listNeedsYou } from '@/lib/needs-you'

const headers = { 'Cache-Control': 'private, no-store' }

/** One needs-you list across pending approvals and factory questions (#2935). */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
  return NextResponse.json(await listNeedsYou(session.user), {
    headers: { ...headers, 'X-Mikka-Observed-At': new Date().toISOString(), 'X-Mikka-Viewer': session.user.id },
  })
}

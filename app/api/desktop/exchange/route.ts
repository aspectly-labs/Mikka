import { RouteResponse } from '@/lib/server-runtime/server'
import { and, eq, gt, isNotNull, isNull } from 'drizzle-orm'

import { db } from '@/lib/db'
import { desktopAuthRequests } from '@/lib/db/schema'
import { desktopAuthCode, desktopAuthState, desktopAuthVerifier } from '@/lib/desktop-auth'
import { sha256Hex, verifierMatches } from '@/lib/desktop-auth-server'
import { auth } from '@/lib/auth'
import { safeDesktopSession } from '@/lib/desktop-rpc/session'
import { DESKTOP_SESSION_CACHE_HEADER, desktopSessionCacheFromHeaders } from '@/lib/desktop-rpc/session-cache'
import { defineRoute } from '@/lib/primitives/define-route'


const noStore = { 'Cache-Control': 'no-store' }

/**
 * The desktop trades the loopback code and the verifier it kept since
 * /begin for the parked one-time sign-in token. The row is consumed on the
 * first attempt, right or wrong, so a code cannot be guessed against.
 */
export const POST = defineRoute(
  {
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    route: '/api/desktop/exchange',
    onOriginFailure: () => new RouteResponse(null, { status: 403 }),
  },
  async ({ request }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return RouteResponse.json({ error: 'invalidRequest' }, { status: 400, headers: noStore })
    }
    const value = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    const state = desktopAuthState(value.state)
    const code = desktopAuthCode(value.code)
    const verifier = desktopAuthVerifier(value.verifier)
    if (!state || !code || !verifier || (value.client !== undefined && value.client !== 'bundled')) return RouteResponse.json({ error: 'invalidRequest' }, { status: 400, headers: noStore })

    const now = new Date()
    // Lock the still-unused row before returning its old token. Consuming and
    // clearing then commit together; concurrent attempts cannot both redeem it.
    const pending = db.$with('pending_desktop_auth').as(db.select({
      stateHash: desktopAuthRequests.stateHash, codeHash: desktopAuthRequests.codeHash,
      challenge: desktopAuthRequests.codeChallenge, token: desktopAuthRequests.token,
    }).from(desktopAuthRequests)
      .where(and(eq(desktopAuthRequests.stateHash, sha256Hex(state)), isNotNull(desktopAuthRequests.boundAt), isNull(desktopAuthRequests.usedAt), gt(desktopAuthRequests.expiresAt, now)))
      .for('update'))
    const [row] = await db.with(pending).update(desktopAuthRequests).set({ usedAt: now, token: null })
      .from(pending).where(eq(desktopAuthRequests.stateHash, pending.stateHash))
      .returning({ codeHash: pending.codeHash, challenge: pending.challenge, token: pending.token })
    if (!row?.token || row.codeHash !== sha256Hex(code) || !verifierMatches(verifier, row.challenge)) {
      return RouteResponse.json({ error: 'exchangeRejected' }, { status: 400, headers: noStore })
    }
    if (value.client === 'bundled') {
      try {
        // The same single-use PKCE handoff, redeemed here so only the main process
        // receives a bearer. Never expose the parked token to the local renderer.
        const { response: session, headers } = await auth.api.verifyOneTimeToken({ body: { token: row.token }, headers: new Headers(), returnHeaders: true })
        const cache = desktopSessionCacheFromHeaders(headers, (await auth.$context).authCookies.sessionData.name)
        return RouteResponse.json({ token: session.session.token, ...safeDesktopSession(session) }, { headers: { ...noStore, ...(cache !== undefined ? { [DESKTOP_SESSION_CACHE_HEADER]: cache } : {}) } })
      } catch {
        return RouteResponse.json({ error: 'exchangeRejected' }, { status: 400, headers: noStore })
      }
    }
    return RouteResponse.json({ token: row.token }, { headers: noStore })
  },
)

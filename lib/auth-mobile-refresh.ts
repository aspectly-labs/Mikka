import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { z } from 'zod'

/**
 * Refresh credentials for the iOS app (decision 2026-11-24 mobile-refresh-credentials).
 *
 * The app keeps riding a Better Auth session cookie as its access credential.
 * `exchange` gives a signed-in phone a refresh token bound to that session;
 * `rotate` trades a refresh token for a fresh one-hour access credential, set
 * as the session cookie like a sign-in, and the next refresh token in the same
 * family. The access session is renewed in place: a new token and expiry on
 * the same row, so the previous cookie stops working while the session's id
 * (push registrations, the app's outbox, review sessions, 2FA and SSO fields)
 * stays. A refresh token is single use: presenting a used one again revokes
 * its whole family and ends its session, except within a short grace window
 * that covers a response lost on the network. Old app builds and the web never
 * call these endpoints and see no change.
 *
 * The table and its two session triggers live in
 * drizzle/20261124035101_mobile_refresh_tokens.sql: deleting a live access
 * session revokes the family it backs, and a rotated access session never
 * slides past the hour it was given.
 */

/** A distinct prefix: never a Better Auth session token, a PAT (`mkp_`) or an OAuth token (`mka_`/`mkr_`). */
export const MOBILE_REFRESH_TOKEN_PREFIX = 'mkmr_'
const TOKEN = /^mkmr_[A-Za-z0-9_-]{43}$/
/** A rotated access session. Short, so a stolen cookie is worth an hour at most. */
export const MOBILE_ACCESS_SECONDS = 60 * 60
/** A refresh token unused this long expires; each rotation starts a new one. */
export const MOBILE_REFRESH_SECONDS = 60 * 24 * 60 * 60
/** No rotation keeps a family past this; then the person signs in again. */
export const MOBILE_REFRESH_FAMILY_SECONDS = 180 * 24 * 60 * 60
/** A used token presented again this soon, while its child is still unused, is a lost response, not a replay. */
export const MOBILE_REFRESH_GRACE_SECONDS = 60
/** The client-visible refusal: only this one means the refresh credential is gone. */
export const REFRESH_REJECTED = 'refreshRejected'
export const REFRESH_UNAVAILABLE = 'refreshUnavailable'

/**
 * SQL over a row of "session": the phone is still signed in. Its session is
 * unexpired, or the iPhone's refresh credential backs it: that access session
 * lasts an hour and is renewed when the app next opens, so a phone in a pocket
 * keeps getting its pushes until someone signs it out (which revokes the family).
 */
export const PHONE_SESSION_SIGNED_IN = `("session"."expiresAt">clock_timestamp() OR EXISTS (SELECT 1 FROM mobile_refresh_tokens r
  WHERE r.session_id="session".id AND r.user_id="session"."userId" AND r.revoked_at IS NULL AND r.expires_at>clock_timestamp()))`

const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const newToken = () => `${MOBILE_REFRESH_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
/** A session token in Better Auth's own shape: 32 letters and digits. */
function sessionTokenValue() {
  let value = ''
  while (value.length < 32) for (const byte of randomBytes(48)) if (byte < 248 && value.length < 32) value += ALPHANUMERIC[byte % 62]
  return value
}
const later = (seconds: number) => new Date(Date.now() + seconds * 1000)
const rejected = () => new APIError('UNAUTHORIZED', { code: REFRESH_REJECTED, message: 'Refresh rejected' })
/** A credential response is never cached by anything between the server and the phone. */
const noStore = (ctx: { setHeader(name: string, value: string): void }) => { ctx.setHeader('cache-control', 'no-store'); ctx.setHeader('pragma', 'no-cache') }
const body = z.object({ refreshToken: z.string().max(256) })

type Row = {
  id: string; family_id: string; user_id: string; session_id: string | null
  expires_at: Date; family_expires_at: Date; used_at: Date | null; replaced_by: string | null; revoked_at: Date | null
  two_factor_verified_at: Date | null; two_factor_method: string | null
}
type Assurance = { verifiedAt: Date | null; method: string | null }
type Database = Pick<Pool, 'connect' | 'query'>

async function transaction<T>(database: Database, work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await database.connect()
  try {
    await tx.query('begin')
    const value = await work(tx)
    await tx.query('commit')
    return value
  } catch (error) {
    await tx.query('rollback').catch(() => undefined)
    throw error
  } finally { tx.release() }
}

/** Ends every unrevoked row of these families. Returns the access sessions they backed, for the caller to delete. */
async function revokeFamilies(tx: Pick<PoolClient, 'query'>, where: string, values: unknown[], reason: string): Promise<string[]> {
  const { rows } = await tx.query<{ session_id: string }>(`with target as (
      select id, session_id from mobile_refresh_tokens
      where revoked_at is null and family_id in (select family_id from mobile_refresh_tokens where ${where}) for update),
    ended as (update mobile_refresh_tokens r set revoked_at = now(), revoked_reason = $${values.length + 1}, session_id = null
      from target where r.id = target.id returning target.session_id)
    select session_id from ended where session_id is not null`, [...values, reason])
  return rows.map(row => row.session_id)
}

type EndpointContext = {
  context: {
    internalAdapter: {
      deleteSession(token: string): Promise<unknown>
      findUserById(id: string): Promise<{ id: string } | null>
      findSession(token: string): Promise<{ session: { id: string; token: string }; user: { id: string } } | null>
      createSession(userId: string, dontRememberMe?: boolean, override?: Record<string, unknown>, overrideAll?: boolean): Promise<{ id: string; token: string; expiresAt: Date; userId: string } | null>
    }
    authCookies: { sessionToken: { name: string; attributes: Record<string, unknown> } }
    secret: string
    isTrustedOrigin(url: string): boolean
  }
  setCookie(name: string, value: string, options?: Record<string, unknown>): unknown
  getSignedCookie(name: string, secret: string): Promise<string | null | false>
}

export function mobileRefresh(options: { database: Database }): BetterAuthPlugin {
  const { database } = options

  async function deleteSessions(ctx: EndpointContext, ids: string[]) {
    if (!ids.length) return []
    const { rows } = await database.query<{ token: string }>('select token from session where id = any($1::text[])', [ids])
    for (const { token } of rows) await ctx.context.internalAdapter.deleteSession(token)
    return rows.map(row => row.token)
  }

  /** The access session's second-factor assurance, from its row while it exists, else the family's copy. */
  async function assurance(row: Row): Promise<Assurance> {
    if (row.session_id) {
      const { rows: [session] } = await database.query<{ verifiedAt: Date | null; method: string | null }>(
        'select "twoFactorVerifiedAt" as "verifiedAt", "twoFactorMethod" as method from session where id = $1 and "userId" = $2', [row.session_id, row.user_id])
      if (session) return session
    }
    return { verifiedAt: row.two_factor_verified_at, method: row.two_factor_method }
  }

  type Linked = { sessionToken: string; retiredTokens: string[] }
  /**
   * In one transaction: retire the claimed token (and, in the grace case, the
   * child whose answer was lost), renew the access session or adopt the minted
   * one, and insert the next token. The previous session token stops working
   * here. 'gone' means the backing session row no longer exists.
   */
  async function link(row: Row, token: string, refreshExpiresAt: Date, accessExpiresAt: Date, userAgent: string | null, minted: { id: string; token: string } | null): Promise<Linked | 'gone' | null> {
    return transaction(database, async tx => {
      const { rows: [parent] } = await tx.query<Row>('select * from mobile_refresh_tokens where id = $1 for update', [row.id])
      if (!parent || parent.revoked_at) return null
      // The grace case: the child whose response was lost is superseded below.
      const { rows: [child] } = parent.replaced_by
        ? await tx.query<Row>('select * from mobile_refresh_tokens where id = $1 for update', [parent.replaced_by])
        : { rows: [] as Row[] }
      if (child?.used_at || child?.revoked_at) return null
      const backing = parent.session_id ?? child?.session_id ?? null
      const { rows: [old] } = backing
        ? await tx.query<{ token: string }>('select token from session where id = $1 and "userId" = $2 for update', [backing, parent.user_id])
        : { rows: [] as { token: string }[] }
      if (!minted && !old) return 'gone'
      if (child) await tx.query(`update mobile_refresh_tokens set revoked_at = now(), revoked_reason = 'superseded', session_id = null where id = $1`, [child.id])
      // Nothing backs the session while it is renewed, so the no-slide trigger lets this extension through.
      await tx.query('update mobile_refresh_tokens set session_id = null where id = $1', [parent.id])
      let sessionId: string, sessionToken: string
      if (minted) {
        sessionId = minted.id; sessionToken = minted.token
        // A vanished session's phone registrations follow the sign-in.
        if (backing) await tx.query('update mobile_push_tokens set "sessionId" = $1 where "userId" = $2 and "sessionId" = $3', [minted.id, parent.user_id, backing])
      } else {
        sessionId = backing!; sessionToken = sessionTokenValue()
        await tx.query('update session set token = $2, "expiresAt" = $3, "updatedAt" = now() where id = $1', [sessionId, sessionToken, accessExpiresAt])
      }
      const { rows: [assured] } = await tx.query<{ verifiedAt: Date | null; method: string | null }>(
        'select "twoFactorVerifiedAt" as "verifiedAt", "twoFactorMethod" as method from session where id = $1', [sessionId])
      const id = randomUUID()
      await tx.query(`insert into mobile_refresh_tokens (id, family_id, user_id, session_id, session_rotated, token_hash, expires_at,
          family_expires_at, user_agent, two_factor_verified_at, two_factor_method) values ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10)`,
      [id, parent.family_id, parent.user_id, sessionId, hash(token), refreshExpiresAt, parent.family_expires_at,
        userAgent, assured?.verifiedAt ?? null, assured?.method ?? null])
      await tx.query('update mobile_refresh_tokens set replaced_by = $2 where id = $1', [parent.id, id])
      return { sessionToken, retiredTokens: old ? [old.token] : [] }
    })
  }

  const exchange = createAuthEndpoint('/mobile-refresh/exchange', { method: 'POST', requireHeaders: true }, async ctx => {
    // Only the native app: a browser always sends its own http(s) Origin, so a
    // script on a web page can never turn the person's cookie into a refresh token.
    const origin = ctx.headers?.get('origin')
    if (!origin || /^https?:/i.test(origin) || !ctx.context.isTrustedOrigin(origin)) throw new APIError('FORBIDDEN', { code: 'INVALID_ORIGIN', message: 'Invalid origin' })
    const current = await getSessionFromCtx(ctx, { disableCookieCache: true })
    if (!current?.session) throw new APIError('UNAUTHORIZED', { code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const token = newToken()
    const issued = await transaction(database, async tx => {
      const { rows: [session] } = await tx.query<{ id: string; expiresAt: Date; verifiedAt: Date | null; method: string | null; enterprise: boolean }>(`select id, "expiresAt",
          "twoFactorVerifiedAt" as "verifiedAt", "twoFactorMethod" as method,
          ("enterpriseOrganizationId" is not null or "enterpriseSamlRootSessionId" is not null) as enterprise
        from session where id = $1 and "userId" = $2 and "expiresAt" > now() for share`, [current.session.id, current.user.id])
      if (!session) return null
      // An organization SSO session's assurance belongs to its identity provider's
      // own session (SAML lineage, deprovisioning). It keeps today's session.
      if (session.enterprise) return 'enterprise' as const
      // A session a rotation renewed stays short even when a new family adopts it.
      const { rows: [{ rotated }] } = await tx.query<{ rotated: boolean }>(
        'select exists(select 1 from mobile_refresh_tokens where session_id = $1 and session_rotated) as rotated', [session.id])
      // One family per access session; an older one (a lost keychain) ends here.
      await revokeFamilies(tx, 'session_id = $1', [session.id], 'replaced')
      // Bounded cleanup instead of a sweep: this person's ended families.
      await tx.query(`delete from mobile_refresh_tokens where user_id = $1
        and (family_expires_at < now() or revoked_at < now() - interval '30 days')`, [current.user.id])
      const familyExpiresAt = later(MOBILE_REFRESH_FAMILY_SECONDS), expiresAt = later(MOBILE_REFRESH_SECONDS)
      await tx.query(`insert into mobile_refresh_tokens (id, family_id, user_id, session_id, session_rotated, token_hash, expires_at,
          family_expires_at, user_agent, two_factor_verified_at, two_factor_method) values ($1, $2, $3, $4, $11, $5, $6, $7, $8, $9, $10)`,
      [randomUUID(), randomUUID(), current.user.id, session.id, hash(token), expiresAt, familyExpiresAt,
        ctx.headers?.get('user-agent')?.slice(0, 512) ?? null, session.verifiedAt, session.method, rotated])
      return { refreshExpiresAt: expiresAt, accessExpiresAt: session.expiresAt }
    })
    if (issued === 'enterprise') throw new APIError('CONFLICT', { code: REFRESH_UNAVAILABLE, message: 'Refresh unavailable' })
    if (!issued) throw new APIError('UNAUTHORIZED', { code: 'UNAUTHORIZED', message: 'Unauthorized' })
    noStore(ctx)
    return ctx.json({ userId: current.user.id, refreshToken: token, refreshExpiresAt: issued.refreshExpiresAt.toISOString(), accessExpiresAt: issued.accessExpiresAt.toISOString() })
  })

  const rotate = createAuthEndpoint('/mobile-refresh/rotate', { method: 'POST', body, requireHeaders: true }, async ctx => {
    const presented = ctx.body.refreshToken
    if (!TOKEN.test(presented)) throw rejected()
    const endpoint = ctx as unknown as EndpointContext
    // 1. Claim the presented token, or recognise a replay.
    const claim = await transaction(database, async tx => {
      const { rows: [row] } = await tx.query<Row>('select * from mobile_refresh_tokens where token_hash = $1 for update', [hash(presented)])
      if (!row || row.revoked_at || row.expires_at <= new Date()) return { kind: 'rejected' as const }
      if (!row.used_at) {
        await tx.query('update mobile_refresh_tokens set used_at = now() where id = $1', [row.id])
        return { kind: 'claimed' as const, row }
      }
      const { rows: [child] } = row.replaced_by
        ? await tx.query<{ used_at: Date | null; revoked_at: Date | null }>('select used_at, revoked_at from mobile_refresh_tokens where id = $1', [row.replaced_by])
        : { rows: [] }
      const inGrace = Date.now() - row.used_at.getTime() <= MOBILE_REFRESH_GRACE_SECONDS * 1000
      if (inGrace && (!child || !child.used_at && !child.revoked_at)) return { kind: 'claimed' as const, row }
      // A used token again: someone else holds a copy. End the whole sign-in.
      return { kind: 'reused' as const, sessions: await revokeFamilies(tx, 'id = $1', [row.id], 'reused') }
    })
    if (claim.kind === 'reused') await deleteSessions(endpoint, claim.sessions)
    if (claim.kind !== 'claimed') throw rejected()
    const { row } = claim
    const user = await endpoint.context.internalAdapter.findUserById(row.user_id)
    if (!user) throw rejected()

    // 2. Renew the access session the family backs, in place: a new token and
    // a short expiry on the same session row. Its id, second-factor and SSO
    // fields, push registrations and everything else bound to it stay. Only
    // when that row is gone (Better Auth deleted it on a stale cookie) is a new
    // session minted through Better Auth, with the sign-in's own assurance.
    const accessExpiresAt = new Date(Math.min(later(MOBILE_ACCESS_SECONDS).getTime(), row.family_expires_at.getTime()))
    const refreshExpiresAt = new Date(Math.min(later(MOBILE_REFRESH_SECONDS).getTime(), row.family_expires_at.getTime()))
    const token = newToken()
    const userAgent = ctx.headers?.get('user-agent')?.slice(0, 512) ?? null
    let minted: { id: string; token: string } | null = null
    try {
      let linked: Linked | 'gone' | null = await link(row, token, refreshExpiresAt, accessExpiresAt, userAgent, null)
      if (linked === 'gone') {
        const carried = await assurance(row)
        const created = await endpoint.context.internalAdapter.createSession(row.user_id, false, { expiresAt: accessExpiresAt }, true)
        if (!created) throw new APIError('INTERNAL_SERVER_ERROR', { code: 'FAILED_TO_CREATE_SESSION', message: 'Failed to create session' })
        minted = created
        await database.query('update session set "twoFactorVerifiedAt" = $2, "twoFactorMethod" = $3 where id = $1 and "userId" = $4',
          [created.id, carried.verifiedAt, carried.method, row.user_id])
        linked = await link(row, token, refreshExpiresAt, accessExpiresAt, userAgent, created)
      }
      if (!linked || linked === 'gone') throw rejected()
      const renewed = await endpoint.context.internalAdapter.findSession(linked.sessionToken)
      if (!renewed) throw rejected()
      const cookie = endpoint.context.authCookies.sessionToken
      for (const old of linked.retiredTokens) endpoint.setCookie(`${cookie.name}_multi-${old.toLowerCase()}`, '', { ...cookie.attributes, maxAge: 0 })
      // The cookie lasts as long as the access session, so the app's cookie jar drops it on time.
      await setSessionCookie(ctx, renewed as never, false, { maxAge: Math.max(1, Math.floor((accessExpiresAt.getTime() - Date.now()) / 1000)) })
      minted = null
      noStore(ctx)
      return ctx.json({ userId: row.user_id, refreshToken: token, refreshExpiresAt: refreshExpiresAt.toISOString(), accessExpiresAt: accessExpiresAt.toISOString() })
    } finally {
      if (minted) await endpoint.context.internalAdapter.deleteSession(minted.token).catch(() => undefined)
    }
  })

  /** Signing out on the phone ends its family even when the access session already expired. */
  const revoke = createAuthEndpoint('/mobile-refresh/revoke', { method: 'POST', body, requireHeaders: true }, async ctx => {
    const presented = ctx.body.refreshToken
    if (TOKEN.test(presented)) {
      const sessions = await transaction(database, tx => revokeFamilies(tx, 'token_hash = $1', [hash(presented)], 'signed_out'))
      await deleteSessions(ctx as unknown as EndpointContext, sessions)
    }
    noStore(ctx)
    return ctx.json({ status: true })
  })

  return {
    id: 'mikka-mobile-refresh',
    endpoints: { mobileRefreshExchange: exchange, mobileRefreshRotate: rotate, mobileRefreshRevoke: revoke },
    // Per client address, like Better Auth's own sign-in limits. A phone rotates about once an hour.
    rateLimit: [
      { pathMatcher: path => path === '/mobile-refresh/rotate' || path === '/mobile-refresh/revoke', window: 60, max: 20 },
      { pathMatcher: path => path === '/mobile-refresh/exchange', window: 60, max: 10 },
    ],
    init: () => ({ options: { databaseHooks: { session: { delete: { after: async (session: { id: string; token: string; expiresAt: Date }, ctx: unknown) => {
      // A live session's deletion is handled by the database trigger. An expired
      // one is deleted either by Better Auth when its own stale cookie arrives
      // (not a sign-out: the app rotates next) or by someone ending it on
      // purpose (another device's revoke, sign out everywhere, a password reset).
      if (new Date(session.expiresAt).getTime() > Date.now()) return
      const endpoint = ctx as EndpointContext | null
      const own = endpoint ? await endpoint.getSignedCookie(endpoint.context.authCookies.sessionToken.name, endpoint.context.secret).catch(() => null) : null
      if (own === session.token) return
      await transaction(database, tx => revokeFamilies(tx, 'session_id = $1', [session.id], 'session_ended'))
    } } } } } }),
    hooks: {
      after: [{
        // Better Auth skips expired sessions here; a phone whose access session
        // expired is still signed in through its family, so it is "another device" too.
        matcher: ctx => ctx.path === '/revoke-other-sessions',
        handler: createAuthMiddleware(async ctx => {
          const returned = ctx.context.returned
          if (returned instanceof APIError || returned instanceof Response && !returned.ok) return
          const current = ctx.context.session
          if (!current) return
          await transaction(database, tx => revokeFamilies(tx, `user_id = $1 and family_id not in
            (select family_id from mobile_refresh_tokens where session_id = $2)`, [current.user.id, current.session.id], 'session_ended'))
        }),
      }],
    },
  } satisfies BetterAuthPlugin
}

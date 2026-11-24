import 'server-only'
import { pool } from '@/lib/db'
import { endMobileRefreshForSession } from '@/lib/auth-mobile-refresh'
import { describeUserAgent } from './user-agent'

/** One signed-in device in 「登录设备」. The session token never leaves the server. */
export interface SignedInDevice {
  id: string
  /** 'Chrome · macOS', 'Mikka · iPhone'; null when the User-Agent says nothing recognisable. */
  label: string | null
  client: string | null
  os: string | null
  app: boolean
  current: boolean
  createdAt: string
  /**
   * When the session was last refreshed. Better Auth refreshes a session at most
   * once a day (lib/auth.ts session.updateAge), so this is accurate to a day.
   */
  lastActiveAt: string
}

interface SessionRow { id: string; userAgent: string | null; createdAt: Date; updatedAt: Date }

/**
 * The person's signed-in devices, the current one first, then the most recently
 * active: unexpired sessions, and an iPhone's short access session that expired
 * while its refresh credential (lib/auth-mobile-refresh.ts) still keeps it
 * signed in. Revoking that row ends the refresh credential too. An iPhone shows
 * when its sign-in started, not its latest hourly access session.
 */
export async function listSignedInDevices(userId: string, currentSessionId: string): Promise<SignedInDevice[]> {
  const { rows } = await pool.query<SessionRow>(
    `select s.id, s."userAgent", coalesce(refresh.started, s."createdAt") as "createdAt", s."updatedAt" from session s
     left join lateral (
       select (select min(f.created_at) from mobile_refresh_tokens f where f.family_id = r.family_id) as started
       from mobile_refresh_tokens r
       where r.session_id = s.id and r.revoked_at is null and r.expires_at > now() limit 1
     ) refresh on true
     where s."userId" = $1 and (s."expiresAt" > now() or refresh.started is not null)
     order by (s.id = $2) desc, s."updatedAt" desc`,
    [userId, currentSessionId],
  )
  return rows.map(row => {
    const device = describeUserAgent(row.userAgent)
    return {
      id: row.id, ...device, current: row.id === currentSessionId,
      createdAt: row.createdAt.toISOString(), lastActiveAt: row.updatedAt.toISOString(),
    }
  })
}

/** The token of one of the person's own sessions, so Better Auth can revoke it; null for anyone else's. */
export async function sessionTokenFor(userId: string, sessionId: string): Promise<string | null> {
  const { rows } = await pool.query<{ token: string }>('select token from session where id = $1 and "userId" = $2 limit 1', [sessionId, userId])
  return rows[0]?.token ?? null
}

/**
 * Before one device is signed out: ends the iPhone refresh credential that
 * keeps it signed in, so no rotation can renew or replace it again, and
 * returns the tokens of every session to revoke: this one's as it is now (a
 * rotation may have renewed it since the list was drawn) and any replacement
 * a rotation committed meanwhile. Empty when nothing is left.
 */
export async function endSignedInDevice(userId: string, sessionId: string): Promise<string[]> {
  return endMobileRefreshForSession(pool, userId, sessionId)
}

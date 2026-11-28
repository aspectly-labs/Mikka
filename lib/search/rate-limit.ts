import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { writeTransaction } from '../operations/write-transaction'
import { WEB_USER_LIMIT_PER_MINUTE } from './types'

export async function admitWebRequest(pool: Pick<Pool, 'connect'>, userId: string, signal?: AbortSignal) {
  return consumeWebRate(pool, userId, Date.now(), WEB_USER_LIMIT_PER_MINUTE, signal)
}

/** Same sliding minute as the service, shared across durable workers/restarts.
 * Reuse Better Auth's existing rateLimit storage in a separate hashed namespace.
 * Rows claim request count only; no provider I/O or money reservation lives here. */
export async function consumeWebRate(pool: Pick<Pool, 'connect'>, userId: string, now: number, limit: number, signal?: AbortSignal) {
  const prefix = `web-rate:${createHash('sha256').update(userId).digest('hex')}:`
  return writeTransaction(pool, async tx => {
    // Take the lock in its own statement. A waiting worker's next statement
    // must see the slot committed by the previous lock holder.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [prefix])
    // Data-changing CTEs share a snapshot, so count only active rows explicitly.
    // Cleanup still runs on refusal and never touches another user's/auth rows.
    const id = randomUUID()
    const { rowCount } = await tx.query(`WITH expired AS (
      DELETE FROM "rateLimit" WHERE key LIKE $1 AND "lastRequest" <= $2
    ) INSERT INTO "rateLimit" (id,key,count,"lastRequest")
      SELECT $3,$4,1,$5 WHERE (SELECT COALESCE(sum(count),0) FROM "rateLimit"
        WHERE key LIKE $1 AND "lastRequest" > $2) < $6 RETURNING id`,
    [`${prefix}%`,now-60_000,id,`${prefix}${id}`,now,limit])
    return rowCount === 1
  }, { signal })
}

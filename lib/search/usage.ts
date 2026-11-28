import 'server-only'
import type { Pool } from 'pg'

export interface WebSearchUsageDay { day: string; costMicroUsd: number; settledCalls: number; unknownCalls: number }

/** A requester may read their own hosted search receipts in this workspace. */
export async function byokWebSearchUsage(pool: Pick<Pool, 'query'>, scope: { ownerId: string; workspaceId: string }, from: Date, to: Date) {
  const { rows } = await pool.query<WebSearchUsageDay>(`
    SELECT to_char(u."createdAt" at time zone 'UTC','YYYY-MM-DD') AS day,
      COALESCE(sum(u."costMicroUsd") FILTER (WHERE u.state='settled'),0)::float8 AS "costMicroUsd",
      count(*) FILTER (WHERE u.state='settled')::int AS "settledCalls",
      count(*) FILTER (WHERE u.state='unknown')::int AS "unknownCalls"
    FROM hosted_usage u
    WHERE u."actorId"=$1 AND u."usageWorkspaceId"=$2 AND u."createdAt">=$3 AND u."createdAt"<$4
      AND u."byokWebSearch" AND (u.state='unknown' OR (u.state='settled' AND (u."generationId" IS NOT NULL OR u."costMicroUsd">0)))
    GROUP BY 1 ORDER BY 1`, [scope.ownerId, scope.workspaceId, from, to])
  return rows
}

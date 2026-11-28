import type { PoolClient } from 'pg'

type Query = Pick<PoolClient, 'query'>

/**
 * Counts current-UTC-month purchased-credit overage spend while excluding
 * Free-tier top-up spend incurred outside any active (non-fully-refunded)
 * paid plan grant window. When no timestamped plan grants exist (legacy rows
 * or minimal billing fixtures), falls back to the full UTC calendar month.
 */
export async function queryMonthlyOverageMicroUsd(
  tx: Query,
  workspaceId: string,
  options: { includeReservedPurchased?: boolean } = {},
): Promise<number> {
  const amountExpr = options.includeReservedPurchased
    ? `u."purchasedMicroUsd"+CASE WHEN u.state IN ('pending','unknown') THEN u."reservedPurchased" ELSE 0 END`
    : `u."purchasedMicroUsd"`
  const { rows } = await tx.query<{ spent: string }>(
    `SELECT COALESCE(sum(${amountExpr}), 0)::text AS spent
     FROM hosted_usage u
     WHERE u."workspaceId"=$1
       AND u.state<>'failed'
       AND COALESCE(u."billingSource",'credits')='credits'
       AND u."createdAt">=date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       AND (
         NOT EXISTS (
           SELECT 1 FROM workspace_credit_grants g
           WHERE g."workspaceId"=$1
             AND g.bucket='plan'
             AND g."parentGrantId" IS NULL
             AND g.points>0
             AND g."periodStart" IS NOT NULL
         )
         OR EXISTS (
           SELECT 1 FROM workspace_credit_grants g
           WHERE g."workspaceId"=$1
             AND g.bucket='plan'
             AND g."parentGrantId" IS NULL
             AND g.points>0
             AND (g.points::bigint + COALESCE((SELECT sum(r.points) FROM workspace_credit_grants r WHERE r."parentGrantId"=g.id), 0)) > 0
             AND (g."periodStart" IS NULL OR u."createdAt">=g."periodStart")
             AND (g."expiresAt" IS NULL OR u."createdAt"<g."expiresAt")
         )
       )`,
    [workspaceId],
  )
  return Number(rows[0]?.spent ?? 0)
}

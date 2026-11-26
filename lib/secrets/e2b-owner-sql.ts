import { isCloudEdition } from '../edition'
import type { Pool } from 'pg'

/**
 * SQL for "this person has their own E2B key" (orchestration § 2: a key is personal, never a
 * workspace's or a teammate's). A key saved before keys were personal still counts for the
 * person who saved it until lib/secrets/e2b.ts adopts it on first use.
 */
export const ownE2BKeySql = (owner: string) =>
  isCloudEdition() || process.env.E2B_API_KEY?.trim() ? `(${owner} IS NOT NULL AND ${process.env.E2B_API_KEY?.trim() ? 'TRUE' : 'FALSE'})` :
  `(EXISTS (SELECT 1 FROM user_e2b_keys uk WHERE uk."userId"=${owner}) OR EXISTS (SELECT 1 FROM workspace_e2b_keys wk WHERE wk."createdBy"=${owner}))`

/** Managed runtime authority is deployment configuration. Only a self-hosted
 * installation without that configuration may consult personal credentials. */
export async function hasE2BRuntimeCredential(query: Pick<Pool, 'query'>, userId: string): Promise<boolean> {
  const managed = Boolean(process.env.E2B_API_KEY?.trim())
  if (isCloudEdition() || managed) return managed
  const { rows: [present] } = await query.query(`SELECT 1 FROM user_e2b_keys WHERE "userId"=$1 UNION ALL SELECT 1 FROM workspace_e2b_keys WHERE "createdBy"=$1 LIMIT 1`, [userId])
  return Boolean(present)
}

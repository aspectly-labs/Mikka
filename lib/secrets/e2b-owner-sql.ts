import { isCloudEdition } from '../edition'

/**
 * SQL for "this person has their own E2B key" (orchestration § 2: a key is personal, never a
 * workspace's or a teammate's). A key saved before keys were personal still counts for the
 * person who saved it until lib/secrets/e2b.ts adopts it on first use.
 */
export const ownE2BKeySql = (owner: string) =>
  isCloudEdition() || process.env.E2B_API_KEY?.trim() ? `(${owner} IS NOT NULL AND ${process.env.E2B_API_KEY?.trim() ? 'TRUE' : 'FALSE'})` :
  `(EXISTS (SELECT 1 FROM user_e2b_keys uk WHERE uk."userId"=${owner}) OR EXISTS (SELECT 1 FROM workspace_e2b_keys wk WHERE wk."createdBy"=${owner}))`

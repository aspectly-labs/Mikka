import 'server-only'
import { WORKING_RUN_STATUSES } from './agent-run-statuses'

type Query = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }

const WORKING = WORKING_RUN_STATUSES.map(status => `'${status}'`).join(',')

/**
 * How many more runs a device's saved concurrency limit allows. A queued run holds
 * no lease, so only the runs it already picked up count. The offer and the claim
 * read the same rule; the claim locks the device row so two claims cannot both pass.
 */
export async function freeDeviceSlots(database: Query, deviceId: string): Promise<number> {
  const { rows: [row] } = await database.query(`SELECT d."maxConcurrentRuns"-(SELECT count(*) FROM agent_runs busy
    WHERE busy."deviceId"=d.id AND busy.status IN (${WORKING})
    AND NOT (busy.status='paused' AND busy."pauseReason" IS NOT DISTINCT FROM 'quota_exhausted'
      AND busy."leaseExpiresAt" IS NULL)) AS free FROM devices d WHERE d.id=$1`, [deviceId])
  return Math.max(0, Number(row?.free ?? 0))
}

import 'server-only'
import type { Pool } from 'pg'
import { deviceIsOnline } from '@/lib/device-presence'
import { cloudMachineState, deviceMachineKind, type ThreadMachine } from '@/lib/thread-machine'
import { isMachineSize, type MachineSize } from '@/lib/cloud-computer/machine-pricing'

type Row = {
  runId: string; kind: string | null; deviceType: string | null; name: string | null; platform: string | null; arch: string | null
  hostname: string | null; deviceId: string | null; lastSeenAt: Date | null
  sessionOpenedAt: Date | null; sessionClosedAt: Date | null
  sandboxId: string | null; template: string | null; machineState: string | null; machineCreatedAt: Date | null; endedAt: Date | null
  workerLeaseId: string | null; workerLeaseUntil: Date | null; size: string | null
}

/**
 * Where the thread's live run runs, for its owner only: the device it was given
 * and, for a cloud run, its E2B sandbox. Earlier runs of the chain are the
 * fallback while the newest one has no machine yet. One indexed read; a
 * computer's presence is its device session.
 */
export async function readThreadMachine(pool: Pool, ownerId: string, runIds: readonly string[]): Promise<ThreadMachine | null> {
  return (await readThreadMachinePlacement(pool, ownerId, runIds))?.machine ?? null
}

/**
 * The same read, with the machine's size: the size a Cloudflare task machine
 * was created at, as its prepaid chunks are priced (lib/cloud-computer/sponsored-lifecycle.ts).
 * Null for a computer, a server or any machine with no recorded size; never a default.
 */
export async function readThreadMachinePlacement(pool: Pick<Pool, 'query'>, ownerId: string, runIds: readonly string[]): Promise<{ machine: ThreadMachine; size: MachineSize | null } | null> {
  if (!runIds.length) return null
  const { rows } = await pool.query<Row>(`SELECT r.id AS "runId", d.kind, d."deviceType", d.name, d.platform, d.arch, d.hostname,
      d.id AS "deviceId", d."lastSeenAt", d."sessionOpenedAt", d."sessionClosedAt", tm."sandboxId", tm."snapshotId" AS template, tm.state AS "machineState",
      tm."createdAt" AS "machineCreatedAt", tm."endedAt", tm."workerLeaseId", tm."workerLeaseUntil", tm.lifecycle->>'sponsoredSize' AS size
    FROM agent_runs r
    LEFT JOIN devices d ON d.id = r."deviceId"
    LEFT JOIN thread_machines tm ON tm."runId" = r.id AND tm."ownerId" = r."userId"
    WHERE r.id = ANY($1::uuid[]) AND r."userId" = $2`, [runIds, ownerId])
  const byId = new Map(rows.map(row => [row.runId, row]))
  // Newest first: the live end of the chain decides, an earlier attempt only stands in.
  const row = [...runIds].reverse().map(id => byId.get(id)).find(item => item && (item.deviceId || item.sandboxId || item.machineState))
  if (!row) return null
  if (row.sandboxId || row.kind === 'cloud' || (!row.deviceId && row.machineState)) {
    const state = row.machineState ? cloudMachineState(row.machineState, row) : 'ended'
    return { size: isMachineSize(row.size) ? row.size : null, machine: {
      kind: 'cloud', state, name: null,
      platform: null, arch: null, hostname: null, lastSeenAt: null,
      cloud: row.sandboxId ? { sandboxId: row.sandboxId, template: row.template ?? '', createdAt: (row.machineCreatedAt ?? new Date(0)).toISOString(), endedAt: state === 'ended' ? row.endedAt?.toISOString() ?? null : null } : null,
    } }
  }
  const online = row.deviceId ? deviceIsOnline(row) : false
  return { size: null, machine: {
    kind: deviceMachineKind(row), state: online ? 'online' : 'offline', name: row.name,
    platform: row.platform, arch: row.arch, hostname: row.kind !== 'cloud' && row.deviceType === 'server' ? row.hostname : null,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null, cloud: null,
  } }
}

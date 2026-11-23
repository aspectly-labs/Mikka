import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from '@/lib/server-runtime/server'
import { readUnderDeviceAuthority } from '@/lib/db'
import { authenticateDevice } from '@/lib/device-link'
import { freeDeviceSlotsSql } from '@/lib/device-capacity'
import { COMMANDS_MAX_SKIP, COMMANDS_SKIP_PARAM } from '@mikka/protocol/device'


/** `GET /v1/devices/:deviceId/runs?state=queued`: runs waiting for this device. */
async function handleGET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  const skip = (new URL(request.url).searchParams.get(COMMANDS_SKIP_PARAM) ?? '')
    .split(',', COMMANDS_MAX_SKIP)
  // Credential, current ownership and queued work share one read snapshot.
  // A device with scheduling off gets no work; it stays registered.
  const result = await readUnderDeviceAuthority<{ runIds: string[] } | null>(`SELECT json_build_object('runIds',
    CASE WHEN d.enabled THEN COALESCE((SELECT json_agg(queued.id ORDER BY queued."createdAt",queued.id) FROM (
      SELECT r.id,r."createdAt" FROM agent_runs r WHERE r."deviceId"=d.id AND r.status=$3 AND NOT (r.id::text=ANY($4::text[]))
      ORDER BY r."createdAt",r.id LIMIT LEAST(100,${freeDeviceSlotsSql})
    ) queued), '[]'::json) ELSE '[]'::json END)
    FROM devices d WHERE d.id=$1 AND d."ownerId"=$2 AND d."removedAt" IS NULL`, [deviceId, caller.userId, 'queued', skip])
  if (!result) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  return NextResponse.json(result)
}

export const GET = withDeviceRoute(handleGET)

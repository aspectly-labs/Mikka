import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { enqueueDeviceCommand } from '@/lib/device-management'
import { isPatSession, sameOriginMutationAllowed } from '@/lib/http-security'
import { defineRoute } from '@/lib/primitives/define-route'

export const POST = defineRoute<'session', 'none', { deviceId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  async ({ request, session, params }) => {
    if (!sameOriginMutationAllowed(request)) return new Response(null, { status: 403 })
    if (isPatSession(session)) return new Response(null, { status: 403 })
    const { deviceId } = params
    const parsed = z.object({ kind: z.enum(['redetect', 'restart', 'update']) }).safeParse(await request.json().catch(() => null))
    if (!parsed.success || !z.uuid().safeParse(deviceId).success) return new Response(null, { status: 400 })
    const id = await enqueueDeviceCommand(session.user.id, deviceId, parsed.data.kind)
    return id ? RouteResponse.json({ id }, { status: 202 }) : new Response(null, { status: 404 })
  },
)

export const GET = defineRoute<'session', 'none', { deviceId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  async ({ session, params }) => {
    if (isPatSession(session)) return new Response(null, { status: 403 })
    const { deviceId } = params
    if (!z.uuid().safeParse(deviceId).success) return new Response(null, { status: 400 })
    const result = await pool.query(`SELECT c.id,c.kind,c."createdAt",c."completedAt",c.error FROM device_management_commands c JOIN devices d ON d.id=c."deviceId" WHERE d.id=$1 AND d."ownerId"=$2 ORDER BY c."createdAt" DESC LIMIT 20`, [deviceId, session.user.id])
    return RouteResponse.json({ commands: result.rows }, { headers: { 'Cache-Control': 'no-store' } })
  },
)

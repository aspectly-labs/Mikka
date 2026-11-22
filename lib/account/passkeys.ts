import 'server-only'
import { getAuthenticatorName } from '@better-auth/passkey'
import { isAPIError } from '@better-auth/core/utils/is-api-error'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { assertTwoFactorManagement } from '@/lib/enterprise/two-factor'
import { GovernanceError } from '@/lib/governance/errors'
import { governanceJson } from '@/lib/governance/http'
import {
  deletePasskeyInputSchema,
  renamePasskeyInputSchema,
  type PasskeySummary,
} from './passkeys-contract'

type Database = Pick<Pool | PoolClient, 'query'>

type PasskeyRow = {
  id: string
  name: string | null
  deviceType: string
  backedUp: boolean
  transports: string | null
  createdAt: Date | null
  aaguid: string | null
}

const PASSKEY_COLUMNS = 'id, name, "deviceType", "backedUp", transports, "createdAt", aaguid'

export function toPasskeySummary(row: PasskeyRow): PasskeySummary {
  const transports = row.transports ? row.transports.split(',').map(item => item.trim()).filter(Boolean) : []
  return {
    id: row.id,
    name: row.name ?? null,
    providerName: getAuthenticatorName(row.aaguid) ?? null,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    transports,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    aaguid: row.aaguid ?? null,
  }
}

export async function countUserPasskeys(userId: string, database: Database = pool): Promise<number> {
  const { rows: [row] } = await database.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM "passkey" WHERE "userId" = $1',
    [userId],
  )
  return row?.count ?? 0
}

export async function listUserPasskeys(userId: string, database: Database = pool): Promise<PasskeySummary[]> {
  const { rows } = await database.query<PasskeyRow>(
    `SELECT ${PASSKEY_COLUMNS} FROM "passkey" WHERE "userId" = $1 ORDER BY "createdAt" DESC NULLS LAST, id ASC`,
    [userId],
  )
  return rows.map(toPasskeySummary)
}

export async function renameUserPasskey(
  userId: string,
  sessionId: string,
  input: unknown,
  database: Database = pool,
): Promise<PasskeySummary> {
  const value = renamePasskeyInputSchema.parse(input)
  await assertTwoFactorManagement(userId, sessionId)
  const { rows: [updated] } = await database.query<PasskeyRow>(
    `UPDATE "passkey" SET name = $3 WHERE id = $1 AND "userId" = $2 RETURNING ${PASSKEY_COLUMNS}`,
    [value.id, userId, value.name],
  )
  if (!updated) throw new GovernanceError('not_found')
  return toPasskeySummary(updated)
}

export async function deleteUserPasskey(
  userId: string,
  sessionId: string,
  input: unknown,
  database: Database = pool,
): Promise<{ deleted: true }> {
  const value = deletePasskeyInputSchema.parse(input)
  await assertTwoFactorManagement(userId, sessionId)
  const result = await database.query(
    'DELETE FROM "passkey" WHERE id = $1 AND "userId" = $2',
    [value.id, userId],
  )
  if (result.rowCount !== 1) throw new GovernanceError('not_found')
  return { deleted: true as const }
}

class PasskeyUnauthenticatedError extends Error {
  constructor() { super('unauthorized') }
}

export async function passkeyAccountSession(request: Request) {
  if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('origin') !== new URL(request.url).origin) {
    throw new GovernanceError('access_denied')
  }
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user || !session.session) throw new PasskeyUnauthenticatedError()
  if (session.tokenId || session.tokenWorkspaceId) throw new GovernanceError('access_denied')
  const { rows } = await pool.query(
    'SELECT 1 FROM session WHERE id = $1 AND "userId" = $2 AND "expiresAt" > now()',
    [session.session.id, session.user.id],
  )
  if (!rows.length) throw new PasskeyUnauthenticatedError()
  return session
}

export { governanceJson as passkeyJson }

export async function passkeyRouteResponse(work: () => Promise<Response | unknown>): Promise<Response> {
  try {
    const value = await work()
    return value instanceof Response ? value : Response.json(value, { headers: { 'cache-control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof PasskeyUnauthenticatedError) {
      return Response.json({ error: { code: 'unauthorized' } }, { status: 401, headers: { 'cache-control': 'private, no-store' } })
    }
    if (isAPIError(error) && error.statusCode === 403) {
      const code = typeof (error.body as { code?: unknown } | undefined)?.code === 'string'
        ? (error.body as { code: string }).code : 'TWO_FACTOR_REQUIRED'
      return Response.json({ error: { code, detail: 'two_factor_required' } }, { status: 403, headers: { 'cache-control': 'private, no-store' } })
    }
    if (error instanceof z.ZodError) {
      return Response.json({ error: { code: 'invalid_request', detail: 'invalid_request' } }, { status: 400, headers: { 'cache-control': 'private, no-store' } })
    }
    if (error instanceof GovernanceError) {
      const status = error.detail === 'access_denied' ? 403 : error.detail === 'not_found' ? 404 : error.detail === 'invalid_request' ? 400 : 409
      return Response.json({ error: { code: error.code, detail: error.detail } }, { status, headers: { 'cache-control': 'private, no-store' } })
    }
    console.error('passkey_request_failed', { name: error instanceof Error ? error.name : 'UnknownError' })
    return Response.json({ error: { code: 'passkey_request_failed' } }, { status: 500, headers: { 'cache-control': 'private, no-store' } })
  }
}

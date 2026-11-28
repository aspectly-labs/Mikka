import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

type Query = Pick<Pool | PoolClient, 'query'>

/**
 * A run's token for the Mikka model gateway (decision 2026-11-15-2000). The CLI
 * on the machine holds only this; the provider key or Mikka's own gateway
 * credential stays on the server. Only the SHA-256 is stored.
 */
export type GatewaySource = { kind: 'credits' } | { kind: 'api_key'; keyId: string } | { kind: 'subscription'; deviceId: string }
export interface GatewayGrant {
  runId: string
  ownerId: string
  workspaceId: string | null
  harness: 'claude_code' | 'codex'
  /** The model the run was frozen on: a catalogue id for Mikka 额度, the provider's id for a key. */
  model: string
  source: GatewaySource
  /** Server-verified speed tier frozen on the run's modelDispatch, if any. */
  pro?: true
  serviceTier?: 'fast' | 'ultrafast'
  /** Server-verified Daybreak program (`access_programs.cyber`) frozen on the run's modelDispatch, if any. */
  cyberAccessProgram?: 'daybreak_blue' | 'daybreak_red'
}

const PREFIX = 'mkg_'
/** The default gateway lifetime for API-key and credits runs. */
export const GATEWAY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
/** The run states in which its CLI may still call a model, as `validateRunApiKey` checks them. */
const ACTIVE_RUN = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing']

export const hashGatewayToken = (token: string) => createHash('sha256').update(token).digest('hex')
const tokenShape = /^mkg_[A-Za-z0-9_-]{43}$/

export async function mintGatewayToken(query: Query, grant: GatewayGrant,
  { now = Date.now(), subscriptionLeaseExpiresAt }: { now?: number; subscriptionLeaseExpiresAt?: string } = {}): Promise<{ token: string; expiresAt: Date }> {
  z.uuid().parse(grant.runId)
  if (grant.workspaceId) z.uuid().parse(grant.workspaceId)
  if (grant.source.kind === 'api_key') z.uuid().parse(grant.source.keyId)
  if (grant.source.kind === 'subscription') z.uuid().parse(grant.source.deviceId)
  const model = z.string().trim().min(1).max(128).parse(grant.model)
  const token = PREFIX + randomBytes(32).toString('base64url')
  const expiresAt = new Date(grant.source.kind === 'subscription' && subscriptionLeaseExpiresAt
    ? subscriptionLeaseExpiresAt : now + GATEWAY_TOKEN_TTL_MS)
  if (expiresAt.getTime() <= now || !Number.isFinite(expiresAt.getTime())) throw new Error('model_gateway_lease_expired')
  await query.query(`INSERT INTO model_gateway_tokens ("tokenHash","runId","ownerId","workspaceId",harness,model,"sourceKind","keyId","expiresAt","deviceId")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [hashGatewayToken(token), grant.runId, grant.ownerId, grant.workspaceId, grant.harness, model, grant.source.kind,
    grant.source.kind === 'api_key' ? grant.source.keyId : null, expiresAt, grant.source.kind === 'subscription' ? grant.source.deviceId : null])
  return { token, expiresAt }
}

/**
 * The grant behind a token, or null: unknown, expired, or its run no longer
 * active (ended, failed, stop requested). A run that ends therefore revokes its
 * token without any cleanup job.
 */
export async function verifyGatewayToken(query: Query, token: string, now = new Date()): Promise<GatewayGrant | null> {
  if (!tokenShape.test(token)) return null
  const { rows: [row] } = await query.query<{ runId: string; ownerId: string; workspaceId: string | null; harness: GatewayGrant['harness']; model: string; sourceKind: 'credits' | 'api_key' | 'subscription'; deviceId: string | null; keyId: string | null; pro: boolean; serviceTier: string | null; cyberAccessProgram: string | null }>(
    `SELECT t."runId"::text AS "runId",t."ownerId",t."workspaceId"::text AS "workspaceId",t.harness,t.model,t."sourceKind",t."keyId"::text AS "keyId",t."deviceId"::text AS "deviceId",
       (r."agentDefinition"->'modelDispatch'->'pro') = 'true'::jsonb AS pro,
       r."agentDefinition"->'modelDispatch'->>'serviceTier' AS "serviceTier",
       r."agentDefinition"->'modelDispatch'->>'cyberAccessProgram' AS "cyberAccessProgram"
     FROM model_gateway_tokens t JOIN agent_runs r ON r.id=t."runId" AND r."userId"=t."ownerId"
     WHERE t."tokenHash"=$1 AND t."expiresAt">$2 AND r.status=ANY($3::text[]) AND r."stopRequestedAt" IS NULL
       AND (t."sourceKind" <> 'subscription' OR (t."deviceId"=r."deviceId" AND r."leaseExpiresAt">$2))`,
    [hashGatewayToken(token), now, ACTIVE_RUN])
  if (!row || row.sourceKind === 'subscription' && !row.deviceId) return null
  const serviceTier = row.serviceTier === 'fast' || row.serviceTier === 'ultrafast' ? row.serviceTier : undefined
  const cyberAccessProgram = row.sourceKind !== 'credits' && (row.cyberAccessProgram === 'daybreak_blue' || row.cyberAccessProgram === 'daybreak_red')
    ? row.cyberAccessProgram : undefined
  return { runId: row.runId, ownerId: row.ownerId, workspaceId: row.workspaceId, harness: row.harness, model: row.model,
    source: row.sourceKind === 'subscription' ? { kind: 'subscription', deviceId: row.deviceId! }
      : row.sourceKind === 'api_key' && row.keyId ? { kind: 'api_key', keyId: row.keyId } : { kind: 'credits' },
    ...(row.pro === true ? { pro: true } : serviceTier ? { serviceTier } : {}),
    ...(cyberAccessProgram ? { cyberAccessProgram } : {}) }
}

/** The token a request carries: Claude Code sends `x-api-key`, Codex `Authorization: Bearer`. */
export function requestGatewayToken(headers: Headers): string | null {
  const bearer = headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
  return bearer ?? headers.get('x-api-key')?.trim() ?? null
}

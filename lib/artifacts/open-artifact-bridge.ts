import 'server-only'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import {
  OPEN_ARTIFACT_BRIDGE_MAX_SKEW_SECONDS,
  OPEN_ARTIFACT_BRIDGE_SIGNATURE_HEADER,
  OPEN_ARTIFACT_BRIDGE_SIGNATURE_PREFIX,
  OPEN_ARTIFACT_BRIDGE_TIMESTAMP_HEADER,
  isValidOpenArtifactExternalId,
  isWideArtifactType,
  type OpenArtifactBridgeRequest,
  type OpenArtifactIdentity,
  type OpenArtifactRole,
  type OpenArtifactWakeClassification,
  type OpenArtifactWakeRequest,
  type OpenArtifactWakeResponse,
  type OpenArtifactWakeSender,
  type RichArtifactType,
} from '@mikka/protocol/open-artifact'
import type { WebhookVerifyResult } from '@/lib/primitives/define-route'
import { db } from '@/lib/db'
import { agentRuns, artifactShares, artifacts, type ArtifactKind } from '@/lib/db/schema'
import { cleanTitle } from '@/lib/artifacts/limits'
import { submissionWorkspace } from '@/lib/artifacts/access'
import { ActionFailureError } from '@/lib/action-error'
import { isOpenArtifactTypeEnabled, readOpenArtifactConfig } from '@/lib/artifacts/open-artifact-config'
import { enterprisePrincipal, type EnterprisePrincipal } from '@/lib/enterprise/principal'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { artifactChanged } from '@/lib/live/artifacts'
import { taskActivityChanged } from '@/lib/factory/activity-live'
import { activeTaskWorkspaces, activeWorkspaceShareIssuer, withTaskWorkspace } from '@/lib/task-workspace'
import { readWorkspaceSharingDefaults } from '@/lib/settings/workspace-sharing'
import { coordinatorBot, personalWorkspaceId } from '@/lib/coordinator/coordinator-bot'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { artifactSubmittedEvent, type CoordinatorEventInput } from '@/lib/coordinator-events'

export const OPEN_ARTIFACT_BRIDGE_MAX_BODY_BYTES = 262_144
export const OPEN_ARTIFACT_WAKE_TEXT_MAX = 4000

const SHARE_PREFIX = 'mks_'
const PAT_BEARER_PATTERN = /^Bearer\s+mkp_/i
const TIMESTAMP_PATTERN = /^\d{9,12}$/
const SIGNATURE_HEX_PATTERN = /^[0-9a-f]{64}$/i

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex')

export interface VerifiedOpenArtifactBridgeRequest {
  rawBody: string
  json: unknown
  timestamp: number
}

// --- HMAC-SHA256 Bridge Signing & Verification -------------------------------

export function signOpenArtifactBridgePayload(
  rawBody: string,
  secret: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): { timestamp: string; signature: string } {
  const timestamp = String(Math.trunc(timestampSeconds))
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  return {
    timestamp,
    signature: `${OPEN_ARTIFACT_BRIDGE_SIGNATURE_PREFIX}${digest}`,
  }
}

export type BridgeSignatureVerifyResult =
  | { ok: true; timestamp: number }
  | {
      ok: false
      reason:
        | 'missing_secret'
        | 'missing_headers'
        | 'invalid_timestamp'
        | 'timestamp_out_of_window'
        | 'invalid_signature'
    }

export function verifyOpenArtifactBridgeSignature(input: {
  rawBody: string
  timestampHeader: string | null | undefined
  signatureHeader: string | null | undefined
  secret: string | null | undefined
  nowSeconds?: number
  maxSkewSeconds?: number
}): BridgeSignatureVerifyResult {
  if (!input.secret) return { ok: false, reason: 'missing_secret' }
  const timestampRaw = input.timestampHeader?.trim() ?? ''
  const signatureRaw = input.signatureHeader?.trim() ?? ''
  if (!timestampRaw || !signatureRaw) return { ok: false, reason: 'missing_headers' }
  if (!TIMESTAMP_PATTERN.test(timestampRaw)) return { ok: false, reason: 'invalid_timestamp' }

  const timestamp = Number(timestampRaw)
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return { ok: false, reason: 'invalid_timestamp' }
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const maxSkew = input.maxSkewSeconds ?? OPEN_ARTIFACT_BRIDGE_MAX_SKEW_SECONDS
  if (Math.abs(now - timestamp) > maxSkew) {
    return { ok: false, reason: 'timestamp_out_of_window' }
  }

  if (!signatureRaw.startsWith(OPEN_ARTIFACT_BRIDGE_SIGNATURE_PREFIX)) {
    return { ok: false, reason: 'invalid_signature' }
  }
  const actualHex = signatureRaw.slice(OPEN_ARTIFACT_BRIDGE_SIGNATURE_PREFIX.length)
  if (!SIGNATURE_HEX_PATTERN.test(actualHex)) {
    return { ok: false, reason: 'invalid_signature' }
  }

  const expectedHex = createHmac('sha256', input.secret)
    .update(`${timestampRaw}.${input.rawBody}`)
    .digest('hex')
  const actualBuf = Buffer.from(actualHex, 'hex')
  const expectedBuf = Buffer.from(expectedHex, 'hex')
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return { ok: false, reason: 'invalid_signature' }
  }
  return { ok: true, timestamp }
}

async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

function precheckBridgeHeaders(input: {
  timestampHeader: string | null | undefined
  signatureHeader: string | null | undefined
  nowSeconds?: number
  maxSkewSeconds?: number
}): boolean {
  const timestampRaw = input.timestampHeader?.trim() ?? ''
  const signatureRaw = input.signatureHeader?.trim() ?? ''
  if (!timestampRaw || !signatureRaw) return false
  if (!TIMESTAMP_PATTERN.test(timestampRaw)) return false
  const timestamp = Number(timestampRaw)
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return false
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const maxSkew = input.maxSkewSeconds ?? OPEN_ARTIFACT_BRIDGE_MAX_SKEW_SECONDS
  if (Math.abs(now - timestamp) > maxSkew) return false
  if (!signatureRaw.startsWith(OPEN_ARTIFACT_BRIDGE_SIGNATURE_PREFIX)) return false
  return SIGNATURE_HEX_PATTERN.test(signatureRaw.slice(OPEN_ARTIFACT_BRIDGE_SIGNATURE_PREFIX.length))
}

export async function verifyOpenArtifactBridgeHttpRequest(
  request: Request,
  options: {
    env?: Readonly<Record<string, string | undefined>>
    nowSeconds?: number
    maxSkewSeconds?: number
  } = {},
): Promise<WebhookVerifyResult<VerifiedOpenArtifactBridgeRequest>> {
  const config = readOpenArtifactConfig(options.env)
  if (!config.bridgeSecret) {
    return { ok: false, status: 503, error: 'openArtifactBridgeNotConfigured' }
  }
  const timestampHeader = request.headers.get(OPEN_ARTIFACT_BRIDGE_TIMESTAMP_HEADER)
  const signatureHeader = request.headers.get(OPEN_ARTIFACT_BRIDGE_SIGNATURE_HEADER)
  // Reject unsigned, malformed, or expired requests before reading any body bytes.
  if (
    !precheckBridgeHeaders({
      timestampHeader,
      signatureHeader,
      nowSeconds: options.nowSeconds,
      maxSkewSeconds: options.maxSkewSeconds,
    })
  ) {
    return { ok: false, status: 401, error: 'invalidBridgeSignature' }
  }
  const rawBody = await readBoundedText(request, OPEN_ARTIFACT_BRIDGE_MAX_BODY_BYTES)
  if (rawBody === null) {
    return { ok: false, status: 413, error: 'payloadTooLarge' }
  }
  const verified = verifyOpenArtifactBridgeSignature({
    rawBody,
    timestampHeader,
    signatureHeader,
    secret: config.bridgeSecret,
    nowSeconds: options.nowSeconds,
    maxSkewSeconds: options.maxSkewSeconds,
  })
  if (!verified.ok) {
    return { ok: false, status: 401, error: 'invalidBridgeSignature' }
  }
  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return { ok: false, status: 400, error: 'invalidJson' }
  }
  return {
    ok: true,
    payload: {
      rawBody,
      json,
      timestamp: verified.timestamp,
    },
  }
}

// --- Pure Policy & Fencing Helpers -------------------------------------------

/**
 * Strictly fences Open Artifact wake senders so collaborator or system events
 * can NEVER impersonate an owner prompt/turn.
 *
 * Only `from.kind === 'owner'` with a verified non-empty `from.subject` matching
 * the artifact's Neon PG `ownerUserId` classifies as `'owner_turn'`.
 */
export function classifyOpenArtifactWake(
  ownerUserId: string,
  from: OpenArtifactWakeSender,
): OpenArtifactWakeClassification {
  if (
    from.kind === 'owner'
    && typeof from.subject === 'string'
    && from.subject.length > 0
    && from.subject === ownerUserId
  ) {
    return 'owner_turn'
  }
  return 'fenced_notice'
}

export function sanitizeArtifactWakeText(raw: string): string {
  return raw
    .replace(/<\/?artifact_comment\b[^>]*>/gi, '[removed tag]')
    .trim()
    .slice(0, OPEN_ARTIFACT_WAKE_TEXT_MAX)
}

function normalizeShareVisibility(value: unknown): 'private' | 'workspace' | 'link' | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') return null
  const lower = value.trim().toLowerCase()
  if (lower === 'private' || lower === 'owner' || lower === 'none') return 'private'
  if (lower === 'workspace' || lower === 'team' || lower === 'org' || lower === 'organization') {
    return 'workspace'
  }
  if (lower === 'link' || lower === 'public' || lower === 'anyone' || lower === 'anyone_with_link') {
    return 'link'
  }
  return null
}

/**
 * Enforces workspace artifact sharing defaults fail-closed.
 * When workspace policy is `private`, external/workspace links are denied;
 * when workspace policy is `workspace`, anonymous public/link shares are denied.
 */
export function evaluateShareGuardPolicy(
  workspaceDefault: 'private' | 'workspace' | 'link',
  requestedVisibility: unknown,
): { allow: true } | { allow: false; deny: string } {
  const requested = requestedVisibility === undefined
    ? workspaceDefault
    : normalizeShareVisibility(requestedVisibility)
  if (!requested) {
    return { allow: false, deny: 'Unsupported share visibility.' }
  }
  if (workspaceDefault === 'private' && requested !== 'private') {
    return { allow: false, deny: 'Workspace policy restricts artifact sharing to private.' }
  }
  if (workspaceDefault === 'workspace' && requested === 'link') {
    return { allow: false, deny: 'Workspace policy restricts artifact sharing to workspace members.' }
  }
  return { allow: true }
}

// --- Injectable Persistence / Auth Dependencies ------------------------------

export interface IndexedOpenArtifactRow {
  id: string
  userId: string
  workspaceId: string | null
  title: string
  engine: string
  externalId: string | null
  artifactType: RichArtifactType | null
  runId: string | null
  issueId: string | null
  latestVersion: number
}

export interface LiveArtifactShareRow {
  id: string
  createdBy: string
  visibility: 'private' | 'workspace' | 'link'
}

export interface OpenArtifactBridgeDeps {
  getSession: (headers: Headers) => Promise<{
    user: {
      id: string
      email?: string | null
      name?: string | null
      image?: string | null
      [tokenWorkspace]?: string
      [enterprisePrincipal]?: EnterprisePrincipal
    }
    tokenWorkspaceId?: string
    tokenId?: string
  } | null>
  findArtifactByExternalId: (externalId: string) => Promise<IndexedOpenArtifactRow | null>
  activeWorkspaceIdsForUser: (userId: string, workspaceId?: string) => Promise<string[]>
  isActiveShareIssuer: (issuerUserId: string, workspaceId: string) => Promise<boolean>
  findLiveShareByToken: (artifactId: string, tokenHash: string) => Promise<LiveArtifactShareRow | null>
  findLiveWorkspaceShare: (artifactId: string) => Promise<LiveArtifactShareRow | null>
  readWorkspaceShareDefault: (workspaceId: string) => Promise<'private' | 'workspace' | 'link'>
  resolveBotForWake: (artifact: IndexedOpenArtifactRow & { workspaceId: string }) => Promise<string>
  recordWakeEvent: (
    userId: string,
    workspaceId: string,
    event: CoordinatorEventInput,
  ) => Promise<string | undefined>
  isAccountWritable: (userId: string) => Promise<boolean>
}

const defaultDeps: OpenArtifactBridgeDeps = {
  getSession: async headers => {
    const { getApiSession } = await import('@/lib/api-auth')
    return getApiSession({
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
    })
  },
  findArtifactByExternalId: async externalId => {
    const [row] = await db
      .select({
        id: artifacts.id,
        userId: artifacts.userId,
        workspaceId: artifacts.workspaceId,
        title: artifacts.title,
        engine: artifacts.engine,
        externalId: artifacts.externalId,
        artifactType: artifacts.artifactType,
        runId: artifacts.runId,
        issueId: artifacts.issueId,
        latestVersion: artifacts.latestVersion,
      })
      .from(artifacts)
      .where(and(eq(artifacts.engine, 'open_artifact'), eq(artifacts.externalId, externalId)))
      .limit(1)
    return row ?? null
  },
  activeWorkspaceIdsForUser: async (userId, workspaceId) => {
    const active = await activeTaskWorkspaces(userId, workspaceId)
    return active.map(workspace => workspace.id)
  },
  isActiveShareIssuer: (issuerUserId, workspaceId) => activeWorkspaceShareIssuer(issuerUserId, workspaceId),
  findLiveShareByToken: async (artifactId, tokenHash) => {
    const [share] = await db
      .select({
        id: artifactShares.id,
        createdBy: artifactShares.createdBy,
        visibility: artifactShares.visibility,
      })
      .from(artifactShares)
      .where(
        and(
          eq(artifactShares.artifactId, artifactId),
          eq(artifactShares.tokenHash, tokenHash),
          isNull(artifactShares.revokedAt),
        ),
      )
      .limit(1)
    return share ?? null
  },
  findLiveWorkspaceShare: async artifactId => {
    const [share] = await db
      .select({
        id: artifactShares.id,
        createdBy: artifactShares.createdBy,
        visibility: artifactShares.visibility,
      })
      .from(artifactShares)
      .where(
        and(
          eq(artifactShares.artifactId, artifactId),
          eq(artifactShares.visibility, 'workspace'),
          isNull(artifactShares.revokedAt),
        ),
      )
      .limit(1)
    return share ?? null
  },
  readWorkspaceShareDefault: async workspaceId => {
    const defaults = await readWorkspaceSharingDefaults(workspaceId)
    return defaults.artifact.value
  },
  resolveBotForWake: async artifact => {
    if (artifact.runId) {
      const [run] = await db
        .select({ botId: agentRuns.botId })
        .from(agentRuns)
        .where(and(eq(agentRuns.id, artifact.runId), eq(agentRuns.userId, artifact.userId)))
        .limit(1)
      if (run?.botId) return run.botId
    }
    const bot = await coordinatorBot(artifact.userId, artifact.workspaceId)
    return bot.botId
  },
  recordWakeEvent: async (userId, workspaceId, event) =>
    withTaskWorkspace({ id: userId }, workspaceId, () => recordCoordinatorEvent(db, event)),
  isAccountWritable: async userId => {
    try {
      await db.execute(sql`select mikka_account_assert_writable(${userId})`)
      return true
    } catch (error) {
      console.warn('open_artifact_account_not_writable', {
        name: error instanceof Error ? error.name : 'Error',
        code: typeof (error as { code?: unknown })?.code === 'string'
          ? (error as { code: string }).code
          : 'account_not_writable',
      })
      return false
    }
  },
}

// --- Bridge Actions ----------------------------------------------------------

export type AuthenticateBridgeResult =
  | { ok: true; identity: OpenArtifactIdentity }
  | { ok: false }

export async function authenticateOpenArtifact(
  input: Extract<OpenArtifactBridgeRequest, { action: 'authenticate' }>,
  deps: Partial<OpenArtifactBridgeDeps> = {},
): Promise<AuthenticateBridgeResult> {
  const cookie = input.cookieHeader?.trim()
  const authorization = input.authorizationHeader?.trim()
  // Personal Access Tokens are pinned to a single workspace; never admit them
  // into the browser-session Open Artifact host where the pin would be dropped.
  if (authorization && PAT_BEARER_PATTERN.test(authorization)) return { ok: false }
  if (!cookie && !authorization) return { ok: false }

  const headers = new Headers()
  if (cookie) headers.set('cookie', cookie)
  if (authorization) headers.set('authorization', authorization)

  const getSession = deps.getSession ?? defaultDeps.getSession
  try {
    const session = await getSession(headers)
    if (!session?.user?.id) return { ok: false }
    if (
      session.tokenId
      || session.tokenWorkspaceId
      || session.user[tokenWorkspace]
      || (session.user[enterprisePrincipal] && session.user[enterprisePrincipal].kind !== 'session')
    ) {
      return { ok: false }
    }
    return {
      ok: true,
      identity: {
        subject: session.user.id,
        ...(session.user.email ? { email: session.user.email } : {}),
        ...(session.user.name ? { name: session.user.name } : {}),
        ...(session.user.image ? { avatar: session.user.image } : {}),
      },
    }
  } catch (error) {
    console.warn('open_artifact_bridge_auth_failed', {
      name: error instanceof Error ? error.name : 'Error',
      code: typeof (error as { code?: unknown })?.code === 'string'
        ? (error as { code: string }).code
        : 'auth_failed',
    })
    return { ok: false }
  }
}

export interface AuthorizeBridgeResult {
  ok: true
  role: OpenArtifactRole | null
  artifactId?: string
  workspaceId?: string
}

function normalizeAuthenticatedSubject(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() || null
  if (!trimmed) return null
  if (trimmed === 'anonymous' || trimmed === 'guest' || trimmed.startsWith('guest:')) return null
  return trimmed
}

export async function authorizeOpenArtifact(
  input: Extract<OpenArtifactBridgeRequest, { action: 'authorize' }>,
  deps: Partial<OpenArtifactBridgeDeps> = {},
): Promise<AuthorizeBridgeResult> {
  if (!isValidOpenArtifactExternalId(input.externalId)) return { ok: true, role: null }
  const d = { ...defaultDeps, ...deps }

  const row = await d.findArtifactByExternalId(input.externalId)
  if (!row || !row.workspaceId) return { ok: true, role: null }

  const subject = normalizeAuthenticatedSubject(input.subject)
  const shareToken = input.shareToken?.trim() || null

  if (subject) {
    const active = await d.activeWorkspaceIdsForUser(subject, row.workspaceId)
    const memberOfWorkspace = active.includes(row.workspaceId)

    if (memberOfWorkspace && subject === row.userId) {
      return { ok: true, role: 'owner', artifactId: row.id, workspaceId: row.workspaceId }
    }

    if (shareToken && shareToken.startsWith(SHARE_PREFIX)) {
      const share = await d.findLiveShareByToken(row.id, sha256Hex(shareToken))
      if (!share) return { ok: true, role: null }
      if (share.visibility === 'private') {
        return memberOfWorkspace && subject === share.createdBy
          ? { ok: true, role: 'owner', artifactId: row.id, workspaceId: row.workspaceId }
          : { ok: true, role: null }
      }
      if (share.visibility === 'workspace') {
        if (!memberOfWorkspace) return { ok: true, role: null }
        const issuerActive = await d.isActiveShareIssuer(share.createdBy, row.workspaceId)
        return issuerActive
          ? { ok: true, role: 'commenter', artifactId: row.id, workspaceId: row.workspaceId }
          : { ok: true, role: null }
      }
      if (share.visibility === 'link') {
        const issuerActive = await d.isActiveShareIssuer(share.createdBy, row.workspaceId)
        return issuerActive
          ? { ok: true, role: 'viewer', artifactId: row.id, workspaceId: row.workspaceId }
          : { ok: true, role: null }
      }
      return { ok: true, role: null }
    }

    if (memberOfWorkspace) {
      const wsShare = await d.findLiveWorkspaceShare(row.id)
      if (wsShare && (await d.isActiveShareIssuer(wsShare.createdBy, row.workspaceId))) {
        return { ok: true, role: 'commenter', artifactId: row.id, workspaceId: row.workspaceId }
      }
    }

    return { ok: true, role: null }
  }

  // Anonymous request: only a valid non-revoked `link` share with an active issuer grants viewer access.
  if (shareToken && shareToken.startsWith(SHARE_PREFIX)) {
    const share = await d.findLiveShareByToken(row.id, sha256Hex(shareToken))
    if (
      share
      && share.visibility === 'link'
      && (await d.isActiveShareIssuer(share.createdBy, row.workspaceId))
    ) {
      return { ok: true, role: 'viewer', artifactId: row.id, workspaceId: row.workspaceId }
    }
  }

  return { ok: true, role: null }
}

export type GuardBridgeResult =
  | { ok: true; allow: true }
  | { ok: true; allow: false; deny: string }

export async function guardOpenArtifact(
  input: Extract<OpenArtifactBridgeRequest, { action: 'guard' }>,
  deps: Partial<OpenArtifactBridgeDeps> = {},
): Promise<GuardBridgeResult> {
  const subject = normalizeAuthenticatedSubject(input.subject)
  if (!subject) {
    return { ok: true, allow: false, deny: 'Authentication is required.' }
  }
  const d = { ...defaultDeps, ...deps }
  const action = input.guardAction.trim().toLowerCase()

  if (action === 'create' || action === 'artifact.create') {
    const requestedWorkspaceId =
      typeof input.detail?.workspaceId === 'string' && input.detail.workspaceId.trim()
        ? input.detail.workspaceId.trim()
        : undefined
    const active = await d.activeWorkspaceIdsForUser(subject, requestedWorkspaceId)
    if (!active.length) {
      return { ok: true, allow: false, deny: 'No active workspace membership.' }
    }
    const writable = await d.isAccountWritable(subject)
    if (!writable) {
      return { ok: true, allow: false, deny: 'Account is not writable.' }
    }
    return { ok: true, allow: true }
  }

  if (
    action === 'share'
    || action === 'share.create'
    || action === 'share.update'
    || action === 'artifact.share'
  ) {
    if (!input.externalId || !isValidOpenArtifactExternalId(input.externalId)) {
      return { ok: true, allow: false, deny: 'Valid externalId is required to share an artifact.' }
    }
    const row = await d.findArtifactByExternalId(input.externalId)
    if (!row || !row.workspaceId || row.userId !== subject) {
      return { ok: true, allow: false, deny: 'Only the artifact owner may share this artifact.' }
    }
    const active = await d.activeWorkspaceIdsForUser(subject, row.workspaceId)
    if (!active.includes(row.workspaceId)) {
      return { ok: true, allow: false, deny: 'Workspace access denied.' }
    }
    const workspaceDefault = await d.readWorkspaceShareDefault(row.workspaceId)
    const requestedVisibility =
      input.detail?.visibility ?? input.detail?.scope ?? input.detail?.access
    const policy = evaluateShareGuardPolicy(workspaceDefault, requestedVisibility)
    return policy.allow ? { ok: true, allow: true } : { ok: true, allow: false, deny: policy.deny }
  }

  if (
    action === 'update'
    || action === 'edit'
    || action === 'delete'
    || action === 'artifact.update'
    || action === 'artifact.delete'
  ) {
    if (!input.externalId || !isValidOpenArtifactExternalId(input.externalId)) {
      return { ok: true, allow: false, deny: 'Valid externalId is required.' }
    }
    const row = await d.findArtifactByExternalId(input.externalId)
    if (!row || !row.workspaceId || row.userId !== subject) {
      return { ok: true, allow: false, deny: 'Only the artifact owner may modify this artifact.' }
    }
    const active = await d.activeWorkspaceIdsForUser(subject, row.workspaceId)
    if (!active.includes(row.workspaceId)) {
      return { ok: true, allow: false, deny: 'Workspace access denied.' }
    }
    return { ok: true, allow: true }
  }

  if (action === 'comment' || action === 'request' || action === 'artifact.comment') {
    if (!input.externalId || !isValidOpenArtifactExternalId(input.externalId)) {
      return { ok: true, allow: false, deny: 'Valid externalId is required.' }
    }
    const authz = await authorizeOpenArtifact(
      { action: 'authorize', subject, externalId: input.externalId },
      d,
    )
    if (authz.role === 'owner' || authz.role === 'editor' || authz.role === 'commenter') {
      return { ok: true, allow: true }
    }
    return { ok: true, allow: false, deny: 'Comment access denied.' }
  }

  return { ok: true, allow: false, deny: 'Unsupported guard action.' }
}

export type SyncBridgeResult =
  | {
      ok: true
      event: 'created' | 'updated' | 'deleted'
      artifactId: string | null
      workspaceId: string | null
      version: number | null
    }
  | { ok: false; status: 400 | 403 | 404; error: string }

function fallbackNativeKind(artifactType: RichArtifactType | undefined): ArtifactKind {
  return isWideArtifactType(artifactType) ? 'html' : 'markdown'
}

export async function syncOpenArtifactCatalog(
  input: Extract<OpenArtifactBridgeRequest, { action: 'sync' }>,
): Promise<SyncBridgeResult> {
  const subject = input.subject.trim()
  if (!subject || !isValidOpenArtifactExternalId(input.externalId)) {
    return { ok: false, status: 400, error: 'invalidSyncPayload' }
  }

  if (input.event === 'deleted') {
    const [existing] = await db
      .select({
        id: artifacts.id,
        userId: artifacts.userId,
        workspaceId: artifacts.workspaceId,
        latestVersion: artifacts.latestVersion,
      })
      .from(artifacts)
      .where(and(eq(artifacts.engine, 'open_artifact'), eq(artifacts.externalId, input.externalId)))
      .limit(1)
    if (!existing) {
      return { ok: true, event: 'deleted', artifactId: null, workspaceId: null, version: null }
    }
    if (!existing.workspaceId || existing.userId !== subject) {
      return { ok: false, status: 403, error: 'artifactOwnershipMismatch' }
    }
    const active = await activeTaskWorkspaces(subject, existing.workspaceId)
    if (!active.some(w => w.id === existing.workspaceId)) {
      return { ok: false, status: 403, error: 'workspaceAccessDenied' }
    }
    const workspaceId = existing.workspaceId
    await withTaskWorkspace({ id: subject }, workspaceId, () =>
      db.transaction(async tx => {
        await tx.execute(sql`select mikka_account_assert_writable(${subject})`)
        await tx
          .delete(artifacts)
          .where(and(eq(artifacts.id, existing.id), eq(artifacts.userId, subject)))
        await artifactChanged(tx, subject, existing.id, workspaceId)
      }),
    )
    return {
      ok: true,
      event: 'deleted',
      artifactId: existing.id,
      workspaceId,
      version: existing.latestVersion,
    }
  }

  // `created` or `updated`
  const [existing] = await db
    .select({
      id: artifacts.id,
      userId: artifacts.userId,
      workspaceId: artifacts.workspaceId,
      title: artifacts.title,
      artifactType: artifacts.artifactType,
      latestVersion: artifacts.latestVersion,
      runId: artifacts.runId,
      issueId: artifacts.issueId,
    })
    .from(artifacts)
    .where(and(eq(artifacts.engine, 'open_artifact'), eq(artifacts.externalId, input.externalId)))
    .limit(1)

  if (existing && existing.userId !== subject) {
    return { ok: false, status: 403, error: 'artifactOwnershipMismatch' }
  }

  const candidateType: RichArtifactType = input.artifactType ?? existing?.artifactType ?? 'docs'
  if (!existing && input.event === 'updated') {
    return { ok: false, status: 404, error: 'artifactNotFound' }
  }
  if (!existing && !isOpenArtifactTypeEnabled(candidateType)) {
    return { ok: false, status: 403, error: 'artifactTypeDisabled' }
  }

  const effectiveRunId = input.runId ?? existing?.runId ?? null
  let effectiveIssueId = input.issueId ?? existing?.issueId ?? null
  if (effectiveRunId && !effectiveIssueId) {
    const [runRow] = await db
      .select({ issueId: agentRuns.issueId })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, effectiveRunId), eq(agentRuns.userId, subject)))
      .limit(1)
    if (runRow?.issueId) effectiveIssueId = runRow.issueId
  }

  let workspaceId: string | null = existing?.workspaceId ?? input.workspaceId ?? null
  if (input.runId || input.issueId) {
    let validatedWorkspaceId: string
    try {
      validatedWorkspaceId = await submissionWorkspace({
        userId: subject,
        workspaceId: workspaceId ?? undefined,
        runId: effectiveRunId,
        issueId: effectiveIssueId,
      })
    } catch (error) {
      if (error instanceof ActionFailureError) {
        return { ok: false, status: 403, error: 'workspaceAccessDenied' }
      }
      throw error
    }
    if (workspaceId && validatedWorkspaceId !== workspaceId) {
      return { ok: false, status: 403, error: 'workspaceAccessDenied' }
    }
    workspaceId = validatedWorkspaceId
  }
  if (!workspaceId) {
    workspaceId = await personalWorkspaceId(subject)
  }

  const active = await activeTaskWorkspaces(subject, workspaceId)
  if (!active.some(w => w.id === workspaceId)) {
    return { ok: false, status: 403, error: 'workspaceAccessDenied' }
  }

  const result = await withTaskWorkspace({ id: subject }, workspaceId, () =>
    db.transaction(async tx => {
      await tx.execute(sql`select mikka_account_assert_writable(${subject})`)
      // Re-read and row-lock inside the transaction so concurrent syncs never regress versions.
      const [locked] = await tx
        .select({
          id: artifacts.id,
          userId: artifacts.userId,
          workspaceId: artifacts.workspaceId,
          title: artifacts.title,
          artifactType: artifacts.artifactType,
          latestVersion: artifacts.latestVersion,
          runId: artifacts.runId,
          issueId: artifacts.issueId,
        })
        .from(artifacts)
        .where(and(eq(artifacts.engine, 'open_artifact'), eq(artifacts.externalId, input.externalId)))
        .for('update')
        .limit(1)

      if (locked) {
        if (locked.userId !== subject || locked.workspaceId !== workspaceId) {
          return { ok: false as const, status: 403 as const, error: 'artifactOwnershipMismatch' }
        }
        // Ignore stale out-of-order sync events so older metadata/links never overwrite newer state.
        if (input.version !== undefined && input.version < locked.latestVersion) {
          return { ok: true as const, artifactId: locked.id, version: locked.latestVersion }
        }
        const artifactType: RichArtifactType = input.artifactType ?? locked.artifactType ?? 'docs'
        const title = cleanTitle(input.title ?? locked.title) || input.externalId.slice(0, 200)
        const nextVersion = Math.max(locked.latestVersion, input.version ?? locked.latestVersion)
        const resolvedRunId = effectiveRunId ?? locked.runId ?? null
        const resolvedIssueId = effectiveIssueId ?? locked.issueId ?? null
        await tx
          .update(artifacts)
          .set({
            title,
            artifactType,
            kind: fallbackNativeKind(artifactType),
            runId: resolvedRunId,
            issueId: resolvedIssueId,
            latestVersion: sql`GREATEST(${artifacts.latestVersion}, ${nextVersion})`,
            updatedAt: new Date(),
          })
          .where(and(eq(artifacts.id, locked.id), eq(artifacts.userId, subject)))
        await artifactChanged(tx, subject, locked.id)
        if (resolvedRunId) taskActivityChanged(tx, resolvedRunId)
        return { ok: true as const, artifactId: locked.id, version: nextVersion }
      }

      // Never resurrect a deleted artifact from an in-flight update event.
      if (input.event === 'updated') {
        return { ok: false as const, status: 404 as const, error: 'artifactNotFound' }
      }

      const artifactId = crypto.randomUUID()
      const version = input.version ?? 1
      const artifactType: RichArtifactType = candidateType
      const title = cleanTitle(input.title ?? input.externalId) || input.externalId.slice(0, 200)
      const resolvedRunId = effectiveRunId
      const resolvedIssueId = effectiveIssueId
      await tx.insert(artifacts).values({
        id: artifactId,
        userId: subject,
        workspaceId,
        kind: fallbackNativeKind(artifactType),
        engine: 'open_artifact',
        externalId: input.externalId,
        artifactType,
        title,
        runId: resolvedRunId,
        issueId: resolvedIssueId,
        latestVersion: version,
      })

      if (resolvedRunId) {
        const [run] = await tx
          .select({ botId: agentRuns.botId })
          .from(agentRuns)
          .where(and(eq(agentRuns.id, resolvedRunId), eq(agentRuns.userId, subject)))
          .limit(1)
        await recordCoordinatorEvent(
          tx,
          artifactSubmittedEvent(
            {
              userId: subject,
              botId: run?.botId ?? null,
              runId: resolvedRunId,
              issueId: resolvedIssueId,
              authorName: 'Open Artifact',
            },
            { artifactId, version, title, kind: artifactType },
          ),
        )
        taskActivityChanged(tx, resolvedRunId)
      }
      await artifactChanged(tx, subject, artifactId)
      return { ok: true as const, artifactId, version }
    }),
  )

  if (!result.ok) {
    return result
  }

  return {
    ok: true,
    event: input.event,
    artifactId: result.artifactId,
    workspaceId,
    version: result.version,
  }
}

// --- Wake Delivery with Strict Collaborator Fencing --------------------------

export type DeliverOpenArtifactWakeResult =
  | OpenArtifactWakeResponse
  | { ok: false; status: 400 | 403 | 404; error: string }

export async function deliverOpenArtifactWake(
  input: OpenArtifactWakeRequest,
  deps: Partial<OpenArtifactBridgeDeps> = {},
): Promise<DeliverOpenArtifactWakeResult> {
  if (!isValidOpenArtifactExternalId(input.externalId)) {
    return { ok: false, status: 400, error: 'invalidExternalId' }
  }
  const d = { ...defaultDeps, ...deps }

  const row = await d.findArtifactByExternalId(input.externalId)
  if (!row || !row.workspaceId) {
    return { ok: false, status: 404, error: 'artifactNotFound' }
  }
  if (input.artifactId && input.artifactId !== row.id) {
    return { ok: false, status: 404, error: 'artifactNotFound' }
  }

  const ownerActiveWorkspaces = await d.activeWorkspaceIdsForUser(row.userId, row.workspaceId)
  if (!ownerActiveWorkspaces.includes(row.workspaceId)) {
    return { ok: false, status: 403, error: 'workspaceAccessDenied' }
  }

  const classification = classifyOpenArtifactWake(row.userId, input.from)
  const sanitizedText = sanitizeArtifactWakeText(input.text)
  if (!sanitizedText) {
    return { ok: false, status: 400, error: 'emptyWakeText' }
  }

  const workspaceId = row.workspaceId
  const botId = await d.resolveBotForWake({ ...row, workspaceId })
  const dedupeKey = input.dedupeKey
    ? `open_artifact_wake:${row.id}:${input.dedupeKey}`
    : `open_artifact_wake:${row.id}:${crypto.randomUUID()}`

  const event: CoordinatorEventInput = classification === 'owner_turn'
    ? {
        userId: row.userId,
        botId,
        kind: 'user_message',
        dedupeKey,
        issueId: row.issueId,
        runId: null,
        payload: {
          text: sanitizedText,
          source: 'open_artifact_wake',
          classification: 'owner_turn',
          artifactId: row.id,
          externalId: row.externalId,
          artifactTitle: row.title,
          reason: input.reason,
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.threads?.length ? { threads: input.threads } : {}),
          ...(input.requests?.length ? { requests: input.requests } : {}),
        },
      }
    : {
        userId: row.userId,
        botId,
        kind: 'run_report',
        dedupeKey,
        issueId: row.issueId,
        runId: row.runId,
        payload: {
          source: 'open_artifact_fenced_notice',
          classification: 'fenced_notice',
          artifactId: row.id,
          externalId: row.externalId,
          artifactTitle: row.title,
          reason: input.reason,
          actorKind: input.from.kind,
          actorName: input.from.name?.trim() || 'Collaborator',
          actorRole: input.from.role ?? null,
          text: sanitizedText,
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.threads?.length ? { threads: input.threads } : {}),
          ...(input.requests?.length ? { requests: input.requests } : {}),
        },
      }

  const eventId = await d.recordWakeEvent(row.userId, workspaceId, event)
  return {
    ok: true,
    delivered: true,
    classification,
    artifactId: row.id,
    eventId: eventId ?? null,
  }
}

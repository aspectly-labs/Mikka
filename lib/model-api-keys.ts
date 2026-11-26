import { modelEnabled, type ModelSettings } from './enabled-models-policy'
import 'server-only'
import { extractProviderSpeedModes, type ModelSpeedMode } from './model-routing'
import { executionMembersActive, revalidateExecutionIdentity, ExecutionIdentityError } from './execution-identity'
import type { WorkerDefinitionSnapshot } from './agent-kit/worker'
import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { gatewayFeaturesSchema, parseGatewayFeatures, type GatewayFeatures } from './model-gateway/features'
import { isPrivateAddress } from '@/lib/link-preview-parse'
import { isLoopbackHost } from '@/lib/loopback'
import { memberSubscriptionsAllowed } from '@/lib/personal-policy'
import { organizationResourceAllowed, assertOrganizationResourceShare, assertOrganizationModelProvider } from '@/lib/governance/resource-access'
import { stopRunsUsingApiKeys } from '@/lib/model-api-key-runs'
import { openSecret, sealSecret, SecretsKeyMissingError } from '@/lib/secrets/crypto'
import { WorkspaceError } from '@/lib/workspace-error'
import {
  API_KEY_PRESET_ENDPOINTS, API_KEY_PRESETS, apiKeyChatBaseUrl, apiKeyProtocols, customModelsUrl, gatewayKeyHarnesses,
  type ApiKeyHarness, type ApiKeyProtocol, type ApiKeyProvider, type ApiKeyView,
} from '@/lib/model-api-key-providers'
import { cyberAccessProgram, DAYBREAK_TIERS, parseDaybreakAccess, type DaybreakAccess, type DaybreakTier } from '@/lib/model-capabilities'

/**
 * 「模型与订阅」 API keys and custom providers (orchestration.md § 1, § 2, § 6;
 * conflict C22). A key belongs to the account. It is checked against the
 * provider's read-only model list before it is saved, sealed with
 * WORKSPACE_SECRETS_KEY, and never returned: views carry its last four
 * characters only. Only the server opens it for each authorized model request.
 */
type Query = Pick<Pool | PoolClient, 'query'>
type Env = Record<string, string | undefined>

const MAX_MODELS = 200
const MAX_BODY = 2 * 1024 * 1024
const modelId = z.string().trim().min(1).max(128)

export const addApiKeyInput = z.discriminatedUnion('provider', [
  z.strictObject({
    provider: z.enum(API_KEY_PRESETS),
    name: z.string().trim().min(1).max(60).optional(),
    apiKey: z.string().trim().min(8).max(512),
    replaceId: z.uuid().optional(),
  }),
  z.strictObject({
    provider: z.literal('custom'),
    name: z.string().trim().min(1).max(60),
    baseUrl: z.string().trim().min(1).max(500),
    protocol: z.enum(['anthropic', 'openai']),
    apiKey: z.string().trim().min(8).max(512),
    models: z.array(modelId).max(MAX_MODELS).optional(),
    replaceId: z.uuid().optional(),
  }),
])
export type AddApiKeyInput = z.infer<typeof addApiKeyInput>

export const updateApiKeyInput = z.strictObject({
  name: z.string().trim().max(60).nullable().optional(),
  baseUrl: z.string().trim().min(1).max(500).optional(),
  protocol: z.enum(['anthropic', 'openai']).optional(),
  apiKey: z.string().trim().min(8).max(512).optional(),
  models: z.array(modelId).max(MAX_MODELS).optional(),
})
export type UpdateApiKeyInput = z.infer<typeof updateApiKeyInput>

export type ApiKeyVerifyResult =
  | { ok: true; models: string[]; speedModes?: Record<string, readonly ModelSpeedMode[]> }
  | { ok: false; code: 'invalid' | 'unavailable' }

/** Binds a ciphertext to its row and owner: copied onto another row it will not open. */
const keyAad = (id: string, ownerId: string) => ['model_api_key', id.toLowerCase(), ownerId].join('\u0000')

/**
 * A custom provider's base URL: https on a public address. Loopback http is
 * allowed only for the browser tests' local provider (MIKKA_MODEL_KEY_LOOPBACK,
 * set by playwright.config.ts), never on Vercel.
 */
export async function checkBaseUrl(raw: string, env: Env = process.env, resolve: (host: string) => Promise<string[]> = defaultResolve): Promise<string> {
  let url: URL
  try { url = new URL(raw) } catch (error) { throw new WorkspaceError('apiKeyBaseUrlInvalid', { cause: error }) }
  if (url.username || url.password || url.search || url.hash) throw new WorkspaceError('apiKeyBaseUrlInvalid')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const loopbackTest = env.MIKKA_MODEL_KEY_LOOPBACK === '1' && !env.VERCEL && !env.VERCEL_ENV
    && url.protocol === 'http:' && isLoopbackHost(host)
  if (loopbackTest) return url.href.replace(/\/+$/, '')
  if (url.protocol !== 'https:') throw new WorkspaceError('apiKeyBaseUrlInvalid')
  const addresses = isIP(host) ? [host] : await resolve(host)
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new WorkspaceError('apiKeyBaseUrlInvalid')
  return url.href.replace(/\/+$/, '')
}
const defaultResolve = (host: string) => lookup(host, { all: true }).then(rows => rows.map(row => row.address), () => [])

/** GET the provider's model list with the key. Reads nothing else, creates nothing, costs nothing. */
export async function verifyApiKey(target: { modelsUrl: string; auth: ApiKeyProtocol }, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<ApiKeyVerifyResult> {
  const headers: Record<string, string> = target.auth === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${apiKey}` }
  try {
    const response = await fetchImpl(target.modelsUrl, { headers: { ...headers, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(10_000), cache: 'no-store' })
    if (response.status === 401 || response.status === 403) { void response.body?.cancel().catch(() => {}); return { ok: false, code: 'invalid' } }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return { ok: false, code: 'unavailable' } }
    const text = await response.text()
    if (text.length > MAX_BODY) return { ok: false, code: 'unavailable' }
    const body = JSON.parse(text) as { data?: unknown }
    if (!Array.isArray(body.data)) return { ok: false, code: 'unavailable' }
    const seen = new Set<string>()
    const models: string[] = []
    const speedModes: Record<string, readonly ModelSpeedMode[]> = {}
    for (const item of body.data) {
      const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined
      if (typeof id !== 'string' || !modelId.safeParse(id).success) continue
      const trimmed = id.trim()
      if (seen.has(trimmed)) continue
      seen.add(trimmed)
      models.push(trimmed)
      const advertised = extractProviderSpeedModes(item)
      if (advertised !== undefined) speedModes[trimmed] = advertised
      if (models.length >= MAX_MODELS) break
    }
    return Object.keys(speedModes).length ? { ok: true, models, speedModes } : { ok: true, models }
  } catch { return { ok: false, code: 'unavailable' } }
}

interface Row { id: string; ownerId: string; provider: ApiKeyProvider; name: string | null; baseUrl: string | null; protocol: ApiKeyProtocol; last4: string; models: string[]; modelsError: ApiKeyView['modelsError']; responsesApi: boolean; modelSettings?: ModelSettings | null; features?: unknown; daybreak?: unknown }
const COLUMNS = 'id,"ownerId",provider,name,"baseUrl",protocol,last4,models,"modelsError","responsesApi",features'
const view = (row: Row): ApiKeyView => {
  const daybreak = parseDaybreakAccess(row.daybreak)
  return {
    id: row.id, provider: row.provider, name: row.name, baseUrl: row.baseUrl, protocol: row.protocol, last4: row.last4, models: row.models, modelsError: row.modelsError ?? null, responsesApi: row.responsesApi,
    ...(row.features ? { features: parseGatewayFeatures(row.features) } : {}),
    ...(daybreak ? { daybreak } : {}),
  }
}
/** Where a key's models are listed: the preset's list, or the custom provider's by its protocol. */
function modelsTarget(row: Pick<Row, 'provider' | 'baseUrl' | 'protocol'>): { modelsUrl: string; auth: ApiKeyProtocol } {
  if (row.provider === 'custom') return { modelsUrl: customModelsUrl(row.baseUrl!, row.protocol), auth: row.protocol }
  const preset = API_KEY_PRESET_ENDPOINTS[row.provider]
  return { modelsUrl: preset.modelsUrl, auth: preset.modelsAuth }
}

/** The page's list: the owner's keys, teammates' workspace-shared keys, and whether keys can be shared here. */
export interface ApiKeysPage {
  keys: (ApiKeyView & { shared: boolean })[]
  /** Teammates' keys shared into this workspace (read-only for borrowers, populated by workspace-aware callers). */
  sharedKeys?: (UsableApiKey & { ownerName: string })[]
  /** A team workspace where the admin allows members' credentials: the 分享给团队成员 switch shows. */
  canShare: boolean
  apiKeyAfterQuota: boolean
}

export async function listApiKeys(query: Query, ownerId: string, workspace: { id: string; kind: 'personal' | 'team' }): Promise<ApiKeysPage> {
  const [keys, shares, fallback, allowed] = await Promise.all([
    query.query<Row>(`SELECT ${COLUMNS},to_jsonb(model_api_keys)->'daybreak' AS daybreak FROM model_api_keys WHERE "ownerId"=$1 ORDER BY "createdAt",id`, [ownerId]),
    query.query<{ keyId: string }>('SELECT s."keyId" FROM model_api_key_shares s JOIN model_api_keys k ON k.id=s."keyId" WHERE k."ownerId"=$1 AND s."workspaceId"=$2', [ownerId, workspace.id]),
    apiKeyAfterQuota(query, ownerId),
    workspace.kind === 'team' ? memberSubscriptionsAllowed(query, workspace.id) : Promise.resolve(false),
  ])
  const shared = new Set(shares.rows.map(row => row.keyId))
  return { keys: keys.rows.map(row => ({ ...view(row), shared: shared.has(row.id) })), canShare: allowed, apiKeyAfterQuota: fallback }
}

function speedModesJson(discovered: Record<string, readonly ModelSpeedMode[]> | undefined): string | null {
  if (!discovered || !Object.keys(discovered).length) return null
  return JSON.stringify(discovered)
}

/** Surgical SQL expression that updates ONLY `{speedModes}` in `"modelSettings"`, preserving concurrent `models` toggles and clearing stale speed metadata when absent. */
const SURGICAL_SPEED_MODES_SQL = (param: string, tablePrefix = '') =>
  `CASE WHEN ${param}::jsonb IS NULL THEN CASE WHEN ${tablePrefix}"modelSettings" IS NULL THEN NULL ELSE ${tablePrefix}"modelSettings" - 'speedModes' END ELSE jsonb_set(COALESCE(${tablePrefix}"modelSettings", '{"autoEnable":true,"models":{}}'::jsonb), '{speedModes}', ${param}::jsonb, true) END`

function parseStoredSpeedModes(settings: ModelSettings | null | undefined): Record<string, readonly ModelSpeedMode[]> | undefined {
  const raw = settings?.speedModes
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, readonly ModelSpeedMode[]> = {}
  for (const [id, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue
    const modes = list.filter((m): m is ModelSpeedMode => m === 'fast' || m === 'ultrafast')
    out[id] = modes
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Checks the key with the provider, then saves it sealed. Multiple keys per
 * preset or custom provider are supported (decision 2026-11-23); pass
 * `replaceId` to rotate an owned key in place while keeping its shares.
 * Errors: apiKeyInvalid (401/403), apiKeyUnverifiable (anything else),
 * apiKeyBaseUrlInvalid, apiKeyNotFound, secretsUnavailable. The key is never logged.
 */
export async function addApiKey(query: Query, ownerId: string, input: unknown, options: {
  env?: Env; fetch?: typeof fetch; resolve?: (host: string) => Promise<string[]>
  /** Atomically admit and save workspace sharing alongside the key write (never mutates/deletes on share refusal). */
  shareWorkspace?: { id: string; kind: 'personal' | 'team' }
} = {}): Promise<ApiKeyView> {
  const parsed = addApiKeyInput.parse(input)
  const env = options.env ?? process.env
  const custom = parsed.provider === 'custom' ? parsed : null
  const baseUrl = custom ? await checkBaseUrl(custom.baseUrl, env, options.resolve) : null
  // A preset's own protocols are its endpoints (apiKeyProtocols); the column keeps its first, for older readers.
  const protocol: ApiKeyProtocol = custom ? custom.protocol : apiKeyProtocols({ provider: parsed.provider, protocol: 'anthropic' })[0]
  const target = modelsTarget({ provider: parsed.provider, baseUrl, protocol })
  let id: string
  let endpointChanged = false
  if (parsed.replaceId) {
    const existing = (await query.query<{ id: string; provider: ApiKeyProvider; baseUrl: string | null; protocol: ApiKeyProtocol }>(
      'SELECT id,provider,"baseUrl",protocol FROM model_api_keys WHERE id=$1 AND "ownerId"=$2', [parsed.replaceId, ownerId])).rows[0]
    if (!existing || existing.provider !== parsed.provider) throw new WorkspaceError('apiKeyNotFound')
    id = existing.id
    endpointChanged = existing.provider === 'custom' && (baseUrl !== existing.baseUrl || protocol !== existing.protocol)
  } else {
    id = randomUUID()
  }
  const shareWorkspace = options.shareWorkspace
  if (shareWorkspace) {
    if (shareWorkspace.kind !== 'team') throw new WorkspaceError('validationGeneric')
    if (!(await memberSubscriptionsAllowed(query, shareWorkspace.id))) throw new WorkspaceError('workspaceAccessDenied')
    await assertOrganizationResourceShare(shareWorkspace.id, 'api_key', id, ownerId)
  }
  let sealed: ReturnType<typeof sealSecret>
  try { sealed = sealSecret(parsed.apiKey, keyAad(id, ownerId), env) } catch (error) {
    if (error instanceof SecretsKeyMissingError) throw new WorkspaceError('secretsUnavailable', { cause: error })
    throw error
  }
  const result = await verifyApiKey(target, parsed.apiKey, options.fetch)
  if (!result.ok) throw new WorkspaceError(result.code === 'invalid' ? 'apiKeyInvalid' : 'apiKeyUnverifiable')
  // A custom provider's own list, when given, is what its models are; otherwise what the provider listed.
  const models = custom?.models?.length ? [...new Set(custom.models)] : result.models
  const speedJson = speedModesJson(result.speedModes)
  const initialSettings = speedJson ? JSON.stringify({ autoEnable: true, models: {}, speedModes: result.speedModes }) : null
  // LiteLLM converts Chat Completions to Responses; no native inference probe.
  const responsesApi = true
  const name = parsed.name ?? null
  const persist = async (q: Query) => {
    if (shareWorkspace) {
      if (!(await memberSubscriptionsAllowed(q, shareWorkspace.id))) throw new WorkspaceError('workspaceAccessDenied')
      await assertOrganizationResourceShare(shareWorkspace.id, 'api_key', id, ownerId)
    }
    if (endpointChanged) {
      await q.query('DELETE FROM model_api_key_shares WHERE "keyId"=$1', [id])
    }
    const { rows: [saved] } = await q.query<Row>(`INSERT INTO model_api_keys (id,"ownerId",provider,name,"baseUrl",protocol,ciphertext,iv,"keyVersion",last4,models,"responsesApi","modelSettings")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,"baseUrl"=EXCLUDED."baseUrl",protocol=EXCLUDED.protocol,ciphertext=EXCLUDED.ciphertext,iv=EXCLUDED.iv,"keyVersion"=EXCLUDED."keyVersion",last4=EXCLUDED.last4,models=EXCLUDED.models,"modelsError"=NULL,"responsesApi"=EXCLUDED."responsesApi","modelSettings"=${SURGICAL_SPEED_MODES_SQL('$14', 'model_api_keys.')},daybreak=NULL,"updatedAt"=now()
      RETURNING ${COLUMNS},to_jsonb(model_api_keys)->'daybreak' AS daybreak`,
    [id, ownerId, parsed.provider, name, baseUrl, protocol, sealed.ciphertext, sealed.iv, sealed.keyVersion, parsed.apiKey.slice(-4), JSON.stringify(models), responsesApi, initialSettings, speedJson])
    if (shareWorkspace) {
      await q.query('INSERT INTO model_api_key_shares ("keyId","workspaceId") VALUES ($1,$2) ON CONFLICT DO NOTHING', [saved.id, shareWorkspace.id])
    }
    return saved
  }
  let row: Row
  if (shareWorkspace && 'connect' in query && typeof (query as Pool).connect === 'function') {
    const client = await (query as Pool).connect()
    try {
      await client.query('BEGIN')
      row = await persist(client)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  } else {
    row = await persist(query)
  }
  if (endpointChanged) await stopRunsUsingApiKeys(query, { keyId: id, ownerId })
  return view(row)
}

/**
 * Updates an owned key's label, custom endpoint settings, or secret key in place.
 * Preserves enabled-model flags via surgical JSONB updates. When rotating the key
 * or changing a custom endpoint/protocol, revalidates DNS/SSRF and re-verifies
 * against the provider; changing a custom endpoint/protocol revokes workspace
 * shares and stops active runs so teammates never inherit an unapproved target.
 */
export async function updateApiKey(query: Query, ownerId: string, id: string, input: unknown, options: { env?: Env; fetch?: typeof fetch; resolve?: (host: string) => Promise<string[]> } = {}): Promise<ApiKeyView> {
  z.uuid().parse(id)
  const parsed = updateApiKeyInput.parse(input)
  const env = options.env ?? process.env
  const { rows: [row] } = await query.query<Row>(`SELECT ${COLUMNS},to_jsonb(model_api_keys)->'daybreak' AS daybreak FROM model_api_keys WHERE id=$1 AND "ownerId"=$2`, [id, ownerId])
  if (!row) throw new WorkspaceError('apiKeyNotFound')
  const isCustom = row.provider === 'custom'
  if (!isCustom && (parsed.baseUrl !== undefined || parsed.protocol !== undefined || parsed.models !== undefined)) {
    throw new WorkspaceError('validationGeneric')
  }
  const nextName = parsed.name === undefined ? row.name : (parsed.name && parsed.name.trim() ? parsed.name.trim() : isCustom ? row.name : null)
  if (isCustom && !nextName) throw new WorkspaceError('validationGeneric')
  const nextProtocol: ApiKeyProtocol = isCustom && parsed.protocol !== undefined ? parsed.protocol : row.protocol
  const needsVerify = parsed.apiKey !== undefined || (isCustom && (parsed.baseUrl !== undefined || parsed.protocol !== undefined))
  // Always revalidate a custom endpoint against SSRF/DNS rebinding whenever contacting it or changing baseUrl.
  const nextBaseUrl = isCustom && (parsed.baseUrl !== undefined || needsVerify)
    ? await checkBaseUrl(parsed.baseUrl !== undefined ? parsed.baseUrl : row.baseUrl!, env, options.resolve)
    : row.baseUrl
  const endpointChanged = isCustom && (nextBaseUrl !== row.baseUrl || nextProtocol !== row.protocol)
  let nextModels = row.models
  let nextModelsError = row.modelsError ?? null
  let speedJson: string | null = null
  if (needsVerify) {
    const secretToVerify = parsed.apiKey ?? (await openKey(query, id, env)).apiKey
    const result = await verifyApiKey(modelsTarget({ provider: row.provider, baseUrl: nextBaseUrl, protocol: nextProtocol }), secretToVerify, options.fetch)
    if (!result.ok) throw new WorkspaceError(result.code === 'invalid' ? 'apiKeyInvalid' : 'apiKeyUnverifiable')
    nextModels = isCustom && parsed.models?.length ? [...new Set(parsed.models)] : (result.models.length || !isCustom ? result.models : row.models)
    nextModelsError = null
    speedJson = speedModesJson(result.speedModes)
  } else if (isCustom && parsed.models !== undefined) {
    nextModels = [...new Set(parsed.models)]
  }
  if (endpointChanged) {
    await stopRunsUsingApiKeys(query, { keyId: id, ownerId })
    await query.query('DELETE FROM model_api_key_shares WHERE "keyId"=$1', [id])
  }
  if (parsed.apiKey !== undefined) {
    let sealed: ReturnType<typeof sealSecret>
    try { sealed = sealSecret(parsed.apiKey, keyAad(id, ownerId), env) } catch (error) {
      if (error instanceof SecretsKeyMissingError) throw new WorkspaceError('secretsUnavailable', { cause: error })
      throw error
    }
    const { rows: [saved] } = await query.query<Row>(`UPDATE model_api_keys
      SET name=$3,"baseUrl"=$4,protocol=$5,ciphertext=$6,iv=$7,"keyVersion"=$8,last4=$9,models=$10::jsonb,"modelsError"=$11,"modelSettings"=${SURGICAL_SPEED_MODES_SQL('$12')},daybreak=NULL,"updatedAt"=now()
      WHERE id=$1 AND "ownerId"=$2 RETURNING ${COLUMNS},to_jsonb(model_api_keys)->'daybreak' AS daybreak`,
    [id, ownerId, nextName, nextBaseUrl, nextProtocol, sealed.ciphertext, sealed.iv, sealed.keyVersion, parsed.apiKey.slice(-4), JSON.stringify(nextModels), nextModelsError, speedJson])
    if (!saved) throw new WorkspaceError('apiKeyNotFound')
    return view(saved)
  }
  if (needsVerify) {
    const { rows: [saved] } = await query.query<Row>(`UPDATE model_api_keys
      SET name=$3,"baseUrl"=$4,protocol=$5,models=$6::jsonb,"modelsError"=$7,"modelSettings"=${SURGICAL_SPEED_MODES_SQL('$8')},"updatedAt"=now()
      WHERE id=$1 AND "ownerId"=$2 RETURNING ${COLUMNS},to_jsonb(model_api_keys)->'daybreak' AS daybreak`,
    [id, ownerId, nextName, nextBaseUrl, nextProtocol, JSON.stringify(nextModels), nextModelsError, speedJson])
    if (!saved) throw new WorkspaceError('apiKeyNotFound')
    return view(saved)
  }
  const { rows: [saved] } = await query.query<Row>(`UPDATE model_api_keys
    SET name=$3,"baseUrl"=$4,protocol=$5,models=$6::jsonb,"modelsError"=$7,"updatedAt"=now()
    WHERE id=$1 AND "ownerId"=$2 RETURNING ${COLUMNS},to_jsonb(model_api_keys)->'daybreak' AS daybreak`,
  [id, ownerId, nextName, nextBaseUrl, nextProtocol, JSON.stringify(nextModels), nextModelsError])
  if (!saved) throw new WorkspaceError('apiKeyNotFound')
  return view(saved)
}

/**
 * 重新获取模型: asks the provider's /models again with the stored key. A good
 * answer replaces the list (a custom provider that lists nothing keeps the
 * models it was added with); a failed one keeps the last list and records why,
 * for the key's row. Only the owner refreshes; the key is never returned.
 */
export async function refreshApiKeyModels(query: Query, ownerId: string, id: string, options: { env?: Env; fetch?: typeof fetch; resolve?: (host: string) => Promise<string[]> } = {}): Promise<ApiKeyView> {
  z.uuid().parse(id)
  const { rowCount } = await query.query('SELECT 1 FROM model_api_keys WHERE id=$1 AND "ownerId"=$2', [id, ownerId])
  if (!rowCount) throw new WorkspaceError('apiKeyNotFound')
  const env = options.env ?? process.env
  const { row, apiKey } = await openKey(query, id, env)
  // A custom provider's host is checked again on every refetch: its name may now point at a private address (DNS rebinding).
  const reachable = row.provider !== 'custom' || await checkBaseUrl(row.baseUrl!, env, options.resolve).then(() => true, () => false)
  const result: ApiKeyVerifyResult = reachable ? await verifyApiKey(modelsTarget(row), apiKey, options.fetch) : { ok: false, code: 'unavailable' }
  const models = result.ok ? (result.models.length || row.provider !== 'custom' ? result.models : row.models) : row.models
  const responsesApi = result.ok ? true : row.responsesApi
  if (result.ok) {
    const speedJson = speedModesJson(result.speedModes)
    const { rows: [saved] } = await query.query<Row>(`UPDATE model_api_keys SET models=$3::jsonb,"modelsError"=NULL,"responsesApi"=$4,"modelSettings"=${SURGICAL_SPEED_MODES_SQL('$5')},"updatedAt"=now() WHERE id=$1 AND "ownerId"=$2 RETURNING ${COLUMNS},to_jsonb(model_api_keys)->'daybreak' AS daybreak`,
      [id, ownerId, JSON.stringify(models), responsesApi, speedJson])
    if (!saved) throw new WorkspaceError('apiKeyNotFound')
    return view(saved)
  }
  const { rows: [saved] } = await query.query<Row>(`UPDATE model_api_keys SET models=$3::jsonb,"modelsError"=$4,"responsesApi"=$5,"updatedAt"=now() WHERE id=$1 AND "ownerId"=$2 RETURNING ${COLUMNS},to_jsonb(model_api_keys)->'daybreak' AS daybreak`,
    [id, ownerId, JSON.stringify(models), result.code, responsesApi])
  if (!saved) throw new WorkspaceError('apiKeyNotFound')
  return view(saved)
}

export interface ApiKeyDaybreakRefreshResult {
  access: DaybreakAccess
  failure?: 'invalid' | 'unavailable'
  key: ApiKeyView
}

const DAYBREAK_CYBER_MODEL_PATTERN = /(?:^|\/)gpt-[a-z0-9.-]+-cyber$/i
const DAYBREAK_PROBE_CANDIDATES = [
  'gpt-6.2-astra', 'gpt-6-astra', 'gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-sol',
  'gpt-6-luna', 'gpt-6.1-terra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5',
] as const

function extractCatalogueDaybreakTiers(item: unknown, id: string): { tiers: DaybreakTier[]; explicit: boolean } {
  const tiers = new Set<DaybreakTier>()
  let explicit = false
  if (item && typeof item === 'object') {
    const raw = (item as { available_access_programs?: unknown }).available_access_programs
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      explicit = true
      const programs = raw as { cyber?: unknown; daybreak_availability?: unknown }
      if (programs.daybreak_availability !== 'unavailable' && Array.isArray(programs.cyber)) {
        for (const entry of programs.cyber) {
          if (entry === 'daybreak_blue') tiers.add('blue')
          else if (entry === 'daybreak_red') tiers.add('red')
        }
      }
    }
  }
  if (DAYBREAK_CYBER_MODEL_PATTERN.test(id)) tiers.add('red')
  return { tiers: DAYBREAK_TIERS.filter(tier => tiers.has(tier)), explicit }
}

/**
 * Checks an owned OpenAI API key's Trusted Access for Cyber (Daybreak) grants
 * and persists the verified `DaybreakAccess` metadata on `model_api_keys.daybreak`
 * (#3315, matching Capy's per-credential Daybreak refresh).
 * Never logs or exposes the API key; non-OpenAI keys always have no Daybreak access.
 */
export async function refreshApiKeyDaybreak(
  query: Query,
  ownerId: string,
  id: string,
  options: { env?: Env; fetch?: typeof fetch; probeResponses?: boolean; probeModels?: readonly string[]; now?: Date } = {},
): Promise<ApiKeyDaybreakRefreshResult> {
  z.uuid().parse(id)
  const { rowCount } = await query.query('SELECT 1 FROM model_api_keys WHERE id=$1 AND "ownerId"=$2', [id, ownerId])
  if (!rowCount) throw new WorkspaceError('apiKeyNotFound')
  const env = options.env ?? process.env
  const now = options.now ?? new Date()
  const fetchImpl = options.fetch ?? fetch
  const { row, apiKey } = await openKey(query, id, env)
  const priorAccess = parseDaybreakAccess(row.daybreak) ?? { granted: [] }
  if (row.provider !== 'openai') {
    const access: DaybreakAccess = { granted: [], checkedAt: now.toISOString() }
    return { access, key: view(row) }
  }
  const preset = API_KEY_PRESET_ENDPOINTS.openai
  const headers = { authorization: `Bearer ${apiKey}`, accept: 'application/json' }
  let modelsBody: { data?: unknown }
  try {
    const response = await fetchImpl(preset.modelsUrl, { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000), cache: 'no-store' })
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => {})
      return { access: priorAccess, failure: 'invalid', key: view(row) }
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      return { access: priorAccess, failure: 'unavailable', key: view(row) }
    }
    const text = await response.text()
    if (text.length > MAX_BODY) return { access: priorAccess, failure: 'unavailable', key: view(row) }
    modelsBody = JSON.parse(text) as { data?: unknown }
    if (!Array.isArray(modelsBody.data)) return { access: priorAccess, failure: 'unavailable', key: view(row) }
  } catch {
    return { access: priorAccess, failure: 'unavailable', key: view(row) }
  }

  const blue = new Set<string>()
  const red = new Set<string>()
  const listedIds = new Set<string>()
  let sawExplicitCatalogue = false
  for (const item of modelsBody.data) {
    const rawId = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined
    if (typeof rawId !== 'string' || !modelId.safeParse(rawId).success) continue
    const trimmed = rawId.trim()
    listedIds.add(trimmed)
    const extracted = extractCatalogueDaybreakTiers(item, trimmed)
    if (extracted.explicit) sawExplicitCatalogue = true
    if (extracted.tiers.includes('blue')) blue.add(trimmed)
    if (extracted.tiers.includes('red')) red.add(trimmed)
  }

  // When OpenAI /v1/models omits `available_access_programs`, run bounded Responses capability
  // checks against listed Daybreak-candidate models for blue and red tiers.
  if (!sawExplicitCatalogue && options.probeResponses !== false) {
    const responsesUrl = preset.chatBaseUrl.replace(/\/+$/, '') + '/responses'
    const candidates = (options.probeModels?.length
      ? options.probeModels.filter(model => listedIds.has(model))
      : DAYBREAK_PROBE_CANDIDATES.filter(model => listedIds.has(model))).slice(0, 8)
    for (const model of candidates) {
      for (const tier of DAYBREAK_TIERS) {
        try {
          const response = await fetchImpl(responsesUrl, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
              model,
              input: '',
              max_output_tokens: 16,
              store: false,
              access_programs: { cyber: cyberAccessProgram(tier) },
            }),
            redirect: 'manual',
            signal: AbortSignal.timeout(10_000),
            cache: 'no-store',
          })
          void response.body?.cancel().catch(() => {})
          if (response.status === 401) return { access: priorAccess, failure: 'invalid', key: view(row) }
          if (response.ok) {
            if (tier === 'blue') blue.add(model)
            else red.add(model)
          } else if (response.status >= 500 || response.status === 429) {
            return { access: priorAccess, failure: 'unavailable', key: view(row) }
          }
        } catch {
          return { access: priorAccess, failure: 'unavailable', key: view(row) }
        }
      }
    }
  }

  const grants: { tier: DaybreakTier; granted: string[] }[] = []
  if (blue.size) grants.push({ tier: 'blue', granted: [...blue] })
  if (red.size) grants.push({ tier: 'red', granted: [...red] })
  const tiers = grants.map(grant => grant.tier)
  const granted = [...new Set([...blue, ...red])]
  const access: DaybreakAccess = {
    granted,
    ...(tiers.length ? { tiers } : {}),
    ...(grants.length ? { grants } : {}),
    checkedAt: now.toISOString(),
  }
  const { rows: [saved] } = await query.query<Row>(
    `UPDATE model_api_keys SET daybreak=$3::jsonb,"updatedAt"=now() WHERE id=$1 AND "ownerId"=$2 RETURNING ${COLUMNS},to_jsonb(model_api_keys)->'daybreak' AS daybreak`,
    [id, ownerId, JSON.stringify(access)],
  )
  if (!saved) throw new WorkspaceError('apiKeyNotFound')
  return { access, key: view(saved) }
}

/** The owner removes their key; its shares go with it. */
export async function removeApiKey(query: Query, ownerId: string, id: string): Promise<{ removed: boolean }> {
  z.uuid().parse(id)
  // Runs handed this key stop first; the key is gone for them too.
  await stopRunsUsingApiKeys(query, { keyId: id, ownerId })
  const { rowCount } = await query.query('DELETE FROM model_api_keys WHERE id=$1 AND "ownerId"=$2', [id, ownerId])
  return { removed: Boolean(rowCount) }
}

/**
 * 分享给团队成员 for one key in one team workspace. The caller has checked
 * that the owner is an active member of it. Turning it on needs the admin's
 * 团队权限 › 订阅与 API Key (sharing with teammates); turning it off always works.
 */
export async function setApiKeyShare(query: Query, ownerId: string, workspace: { id: string; kind: 'personal' | 'team' }, id: string, shared: boolean): Promise<void> {
  z.uuid().parse(id)
  if (workspace.kind !== 'team') throw new WorkspaceError('validationGeneric')
  const { rowCount } = await query.query('SELECT 1 FROM model_api_keys WHERE id=$1 AND "ownerId"=$2', [id, ownerId])
  if (!rowCount) throw new WorkspaceError('apiKeyNotFound')
  if (!shared) {
    await query.query('DELETE FROM model_api_key_shares WHERE "keyId"=$1 AND "workspaceId"=$2', [id, workspace.id])
    await stopRunsUsingApiKeys(query, { keyId: id, workspaceId: workspace.id, othersOnly: true })
    return
  }
  if (!(await memberSubscriptionsAllowed(query, workspace.id))) throw new WorkspaceError('workspaceAccessDenied')
  await assertOrganizationResourceShare(workspace.id, 'api_key', id, ownerId)
  await query.query('INSERT INTO model_api_key_shares ("keyId","workspaceId") VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, workspace.id])
}

/** A member leaves a team: their key shares there go at once (orchestration.md § 6). */
export async function removeMemberApiKeyShares(query: Query, ownerId: string, workspaceId: string) {
  await query.query('DELETE FROM model_api_key_shares s USING model_api_keys k WHERE k.id=s."keyId" AND k."ownerId"=$1 AND s."workspaceId"=$2', [ownerId, workspaceId])
  await stopRunsUsingApiKeys(query, { ownerId, workspaceId })
}

/** 订阅额度用完后，自动改用 API Key. On unless the person turned it off. */
export async function apiKeyAfterQuota(query: Query, ownerId: string): Promise<boolean> {
  const { rows: [row] } = await query.query<{ apiKeyAfterQuota: boolean }>('SELECT "apiKeyAfterQuota" FROM "user" WHERE id=$1', [ownerId])
  return row?.apiKeyAfterQuota ?? true
}
export async function setApiKeyAfterQuota(query: Query, ownerId: string, on: boolean) {
  await query.query('UPDATE "user" SET "apiKeyAfterQuota"=$2 WHERE id=$1', [ownerId, z.boolean().parse(on)])
}

/** A key a person's runs may use in a workspace, as the model picker lists it. */
export interface UsableApiKey extends ApiKeyView {
  ownerId: string
  /** The person's own key, or a teammate's shared with 分享给团队成员. */
  mine: boolean
  /** Server-discovered speed modes per model id (from the provider's /models capability response). */
  modelSpeedModes?: Record<string, readonly ModelSpeedMode[]>
}

/**
 * The API keys a person's bots may use in a workspace, in the order of
 * orchestration.md § 2: their own first (when their credentials are allowed
 * there), then other members' keys shared with 分享给团队成员, oldest share
 * first. The model picker's 「API Key」 group reads this.
 */
export async function usableApiKeys(query: Query, userId: string, workspaceId: string, selectedKeyId?: string): Promise<UsableApiKey[]> {
  // One after the other: a dispatch reads this on its transaction's client.
  // The person's own keys always (decision 2026-11-01-2240); others' only while the admin allows member credentials.
  const mine = (await query.query<Row>(`SELECT ${COLUMNS},to_jsonb(model_api_keys)->'modelSettings' AS "modelSettings",to_jsonb(model_api_keys)->'daybreak' AS daybreak FROM model_api_keys WHERE "ownerId"=$1${selectedKeyId ? ' AND id=$2' : ''} ORDER BY "createdAt",id`, [userId, ...(selectedKeyId ? [selectedKeyId] : [])])).rows
  const shared = (await query.query<Row>(`SELECT ${COLUMNS.split(',').map(column => `k.${column}`).join(',')},to_jsonb(k)->'modelSettings' AS "modelSettings",to_jsonb(k)->'daybreak' AS daybreak FROM model_api_key_shares s JOIN model_api_keys k ON k.id=s."keyId"
    WHERE s."workspaceId"=$1 AND k."ownerId"<>$2${selectedKeyId ? ' AND k.id=$3' : ''} ORDER BY s."createdAt",k.id`, [workspaceId, userId, ...(selectedKeyId ? [selectedKeyId] : [])])).rows
  // No borrowed key means no shared resource to authorize. Own keys retain
  // their original policy; every actual borrowed key still gets fresh gates.
  const others = shared.length && await memberSubscriptionsAllowed(query, workspaceId) ? shared : []
  const grants = await Promise.all(others.map(row => organizationResourceAllowed(workspaceId, 'api_key', row.id, row.ownerId)))
  const usable = (row: Row, mine: boolean) => {
    const modelSpeedModes = parseStoredSpeedModes(row.modelSettings)
    return {
      ...view(row), ownerId: row.ownerId, mine,
      models: row.models.filter(id => modelEnabled(row.modelSettings, id)),
      ...(modelSpeedModes ? { modelSpeedModes } : {}),
    }
  }
  return [...mine.map(row => usable(row, true)), ...others.filter((_, index) => grants[index]).map(row => usable(row, false))]
}

async function openKey(query: Query, keyId: string, env: Env, forRun = false) {
  const { rows: [row] } = await query.query<Row & { ciphertext: string; iv: string; keyVersion: number }>(`SELECT ${COLUMNS},to_jsonb(model_api_keys)->'modelSettings' AS "modelSettings",to_jsonb(model_api_keys)->'daybreak' AS daybreak,ciphertext,iv,"keyVersion" FROM model_api_keys WHERE id=$1`, [keyId])
  if (!row) throw new WorkspaceError('apiKeyNotFound')
  if (forRun && row.modelsError === 'invalid') throw new WorkspaceError('apiKeyInvalid')
  try { return { row, apiKey: openSecret(row, keyAad(row.id, row.ownerId), env) } } catch (error) {
    if (error instanceof SecretsKeyMissingError) throw new WorkspaceError('secretsUnavailable', { cause: error })
    console.error(`[model-api-keys] open_failed id=${row.id}`)
    throw new WorkspaceError('apiKeyNotFound', { cause: error })
  }
}

/**
 * A key opened for one request of the Mikka model gateway (decision
 * 2026-11-15-2000): the run that may use it was checked at claim
 * (`validateRunApiKey`) and is checked again by its gateway token.
 */
export async function openGatewayApiKey(query: Query, keyId: string, env: Env = process.env) {
  z.uuid().parse(keyId)
  const { row, apiKey } = await openKey(query, keyId, env, true)
  return { key: view(row), apiKey, features: parseGatewayFeatures(row.features) }
}

/** The owner turns request features off for a provider that rejects them (decision 2026-11-15-2000). */
export async function setApiKeyFeatures(query: Query, ownerId: string, id: string, features: GatewayFeatures): Promise<void> {
  z.uuid().parse(id)
  const parsed = gatewayFeaturesSchema.parse(features)
  const off = Object.fromEntries(Object.entries(parsed).filter(([, on]) => on === false))
  const { rowCount } = await query.query('UPDATE model_api_keys SET features=$3::jsonb WHERE id=$1 AND "ownerId"=$2',
    [id, ownerId, Object.keys(off).length ? JSON.stringify(off) : null])
  if (!rowCount) throw new WorkspaceError('apiKeyNotFound')
}

/** A bot's saved API key model (bot_model_choices), with the Agents its threads can run on (§ 3). */
export interface BotApiKeyChoice { keyId: string; model: string; harnesses: ApiKeyHarness[] }

export async function botApiKeyChoice(query: Query, scope: { ownerId: string; workspaceId: string }, botId: string | null): Promise<BotApiKeyChoice | undefined> {
  const { rows: [row] } = await query.query<{ apiKeyId: string; apiKeyModel: string; provider: ApiKeyProvider; protocol: ApiKeyProtocol; responsesApi: boolean; baseUrl: string | null }>(
    `SELECT c."apiKeyId",c."apiKeyModel",k.provider,k.protocol,k."responsesApi",k."baseUrl" FROM bot_model_choices c JOIN model_api_keys k ON k.id=c."apiKeyId"
    WHERE c."ownerId"=$1 AND c."workspaceId"=$2 AND c."botKey"=$3`, [scope.ownerId, scope.workspaceId, botId ?? 'coordinator'])
  return row && { keyId: row.apiKeyId, model: row.apiKeyModel, harnesses: gatewayKeyHarnesses(row) }
}

/**
 * Saves a bot's model as one an API key serves. The key must be usable by
 * the bot's owner here and reach bot chats, and the model one it lists as enabled. Saving a subscription model later replaces it.
 */
export async function setBotApiKeyChoice(query: Query, scope: { ownerId: string; workspaceId: string }, botId: string | null, keyId: string, model: string): Promise<BotApiKeyChoice> {
  z.uuid().parse(keyId)
  const modelName = modelId.parse(model)
  if (botId !== null) {
    if (!z.uuid().safeParse(botId).success) throw new WorkspaceError('botNotFound')
    const { rowCount } = await query.query('SELECT 1 FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3', [botId, scope.ownerId, scope.workspaceId])
    if (!rowCount) throw new WorkspaceError('botNotFound')
  }
  const key = (await usableApiKeys(query, scope.ownerId, scope.workspaceId)).find(item => item.id === keyId)
  if (!key || !apiKeyChatBaseUrl(key) || !key.models.includes(modelName)) throw new WorkspaceError('executionModelUnknown')
  if (key.modelsError === 'invalid') {
    if (!key.mine && !await executionMembersActive(scope.workspaceId, [scope.ownerId, key.ownerId])) throw new WorkspaceError('executionModelUnknown')
    throw new WorkspaceError('apiKeyInvalid')
  }
  await query.query(`INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId","apiKeyId","apiKeyModel") VALUES ($1,$2,$3,NULL,$4,$5)
    ON CONFLICT ("ownerId","workspaceId","botKey") DO UPDATE SET "bindingId"=NULL,"apiKeyId"=EXCLUDED."apiKeyId","apiKeyModel"=EXCLUDED."apiKeyModel","creditsModel"=NULL`,
  [scope.ownerId, scope.workspaceId, botId ?? 'coordinator', keyId, modelName])
  return { keyId, model: modelName, harnesses: gatewayKeyHarnesses(key) }
}

/**
 * The key and chat endpoint for one model call of a bot chat frozen on it.
 * Checked on every call, so a withdrawn share or a deleted key stops the
 * chat instead of switching (§ 2). Throws WorkspaceError('apiKeyNotFound').
 */
export async function openApiKeyForChat(query: Query, userId: string, workspaceId: string, keyId: string, env: Env = process.env): Promise<{ apiKey: string; baseUrl: string; keyOwnerId: string; provider: ApiKeyProvider; protocol: ApiKeyProtocol; modelSpeedModes?: Record<string, readonly ModelSpeedMode[]>; daybreak?: DaybreakAccess }> {
  await assertOrganizationModelProvider(workspaceId, 'api-key')
  const usable = (await usableApiKeys(query, userId, workspaceId)).find(key => key.id === keyId)
  const baseUrl = usable && apiKeyChatBaseUrl(usable)
  if (!usable || !baseUrl) throw new WorkspaceError('apiKeyNotFound')
  const { rows: [owner] } = await query.query<{ ownerId: string }>('SELECT "ownerId" FROM model_api_keys WHERE id=$1', [keyId])
  if (!owner || (owner.ownerId !== userId && !await executionMembersActive(workspaceId, [userId, owner.ownerId]))) throw new WorkspaceError('apiKeyNotFound')
  const { row, apiKey } = await openKey(query, keyId, env, true)
  const modelSpeedModes = parseStoredSpeedModes(row.modelSettings)
  const daybreak = parseDaybreakAccess(row.daybreak)
  return { apiKey, baseUrl, keyOwnerId: row.ownerId, provider: row.provider, protocol: row.protocol, ...(modelSpeedModes ? { modelSpeedModes } : {}), ...(daybreak ? { daybreak } : {}) }
}

const ACTIVE_RUN = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing']

/** Authorize and record a run's current key without disclosing it to the machine. */
export async function validateRunApiKey(query: Query, runId: string, keyId: string): Promise<{ ownerId: string; workspaceId: string | null }> {
  z.uuid().parse(runId); z.uuid().parse(keyId)
  const { rows: [run] } = await query.query<{ userId: string; botId: string | null; deviceId: string | null; agentDefinition: WorkerDefinitionSnapshot | null; workspaceId: string | null; status: string; stopRequestedAt: Date | null }>(
    'SELECT r."userId",r."botId",r."deviceId",r."agentDefinition",b."workspaceId"::text AS "workspaceId",r.status,r."stopRequestedAt" FROM agent_runs r LEFT JOIN bots b ON b.id=r."botId" WHERE r.id=$1', [runId])
  if (!run || run.stopRequestedAt || !ACTIVE_RUN.includes(run.status)) throw new WorkspaceError('apiKeyNotFound')
  if (run.workspaceId) await assertOrganizationModelProvider(run.workspaceId, 'api-key')
  if (run.agentDefinition && run.agentDefinition.apiKey?.keyId !== keyId) throw new WorkspaceError('apiKeyNotFound')
  try { await revalidateExecutionIdentity(query, run) }
  catch (error) { if (error instanceof ExecutionIdentityError) throw new WorkspaceError('apiKeyNotFound', { cause: error }); throw error }
  const usable = run.workspaceId
    ? (await usableApiKeys(query, run.userId, run.workspaceId)).some(key => key.id === keyId)
    : Boolean((await query.query('SELECT 1 FROM model_api_keys WHERE id=$1 AND "ownerId"=$2', [keyId, run.userId])).rowCount)
  if (!usable) throw new WorkspaceError('apiKeyNotFound')
  const { rows: [owner] } = await query.query<{ ownerId: string; modelsError: ApiKeyView['modelsError'] }>(
    `SELECT "ownerId",to_jsonb(k)->>'modelsError' AS "modelsError" FROM model_api_keys k WHERE id=$1`, [keyId])
  if (!owner || (owner.ownerId !== run.userId && (!run.agentDefinition?.apiKey || !run.workspaceId || !await executionMembersActive(run.workspaceId, [run.userId, owner.ownerId])))) throw new WorkspaceError('apiKeyNotFound')
  if (owner.modelsError === 'invalid') throw new WorkspaceError('apiKeyInvalid')
  // Recorded so withdrawing the key or its share stops this run (stopRunsUsingApiKeys).
  await query.query(`INSERT INTO model_api_key_runs ("runId","keyId","workspaceId") VALUES ($1,$2,$3)
    ON CONFLICT ("runId") DO UPDATE SET "keyId"=EXCLUDED."keyId","workspaceId"=EXCLUDED."workspaceId"`, [runId, keyId, run.workspaceId])
  return { ownerId: owner.ownerId, workspaceId: run.workspaceId }
}

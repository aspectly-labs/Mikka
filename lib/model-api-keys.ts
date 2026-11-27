import { modelEnabled, type ModelSettings } from './enabled-models-policy'
import 'server-only'
import { runtimeEnv } from '@/lib/env/server'
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
import { assertOrganizationModelProvider } from '@/lib/governance/resource-access'
import { stopRunsUsingApiKeys } from '@/lib/model-api-key-runs'
import { openSecret, sealSecret, SecretsKeyMissingError } from '@/lib/secrets/crypto'
import { WorkspaceError } from '@/lib/workspace-error'
import {
  API_KEY_PRESET_ENDPOINTS, API_KEY_PRESETS, apiKeyChatBaseUrl, apiKeyProtocols, customModelsUrl, gatewayKeyHarnesses,
  type ApiKeyHarness, type ApiKeyProtocol, type ApiKeyProvider, type ApiKeyView,
} from '@/lib/model-api-key-providers'

/**
 * 「模型与订阅」 API keys and custom providers (orchestration.md § 1, § 2, § 6;
 * conflict C22). A key belongs to one person (你的连接) or to one workspace
 * (工作区连接), never both, and is never shared from one to the other (decision
 * 2026-11-27-1740). A person's key serves that person's own runs; a workspace's
 * key serves every member's runs in that workspace and is managed by its
 * admins. A key is checked against the provider's read-only model list before
 * it is saved, sealed with WORKSPACE_SECRETS_KEY, and never returned: views
 * carry its last four characters only. Only the server opens it for each
 * authorized model request.
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

/** Whose key it is: one person's, or one workspace's (decision 2026-11-27-1740). Never both. */
export type ApiKeyOwner = { userId: string } | { workspaceId: string }
const asOwner = (owner: string | ApiKeyOwner): ApiKeyOwner => typeof owner === 'string' ? { userId: owner } : owner
/** The owner predicate's column and value; only these two closed column names are ever interpolated. */
const ownedBy = (owner: ApiKeyOwner) => 'userId' in owner
  ? { column: '"ownerId"', value: owner.userId }
  : { column: '"workspaceId"', value: z.uuid().parse(owner.workspaceId) }

/**
 * Binds a ciphertext to its row and owner: copied onto another row, or onto the
 * same row under another owner, it will not open. A person's key keeps the
 * original binding; a workspace key is bound to the workspace, never to whoever
 * added it.
 */
const keyAad = (id: string, owner: { ownerId: string | null; workspaceId: string | null }) => owner.workspaceId
  ? ['model_api_key_workspace', id.toLowerCase(), owner.workspaceId.toLowerCase()].join('\u0000')
  : ['model_api_key', id.toLowerCase(), owner.ownerId ?? ''].join('\u0000')
const aadOwner = (owner: ApiKeyOwner) => 'userId' in owner ? { ownerId: owner.userId, workspaceId: null } : { ownerId: null, workspaceId: owner.workspaceId }

/**
 * A custom provider's base URL: https on a public address. Loopback http is
 * allowed only for the browser tests' local provider (MIKKA_MODEL_KEY_LOOPBACK,
 * set by playwright.config.ts), never on Vercel.
 */
export async function checkBaseUrl(raw: string, env: Env = runtimeEnv(), resolve: (host: string) => Promise<string[]> = defaultResolve): Promise<string> {
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

interface Row { id: string; ownerId: string | null; workspaceId: string | null; provider: ApiKeyProvider; name: string | null; baseUrl: string | null; protocol: ApiKeyProtocol; last4: string; models: string[]; modelsError: ApiKeyView['modelsError']; responsesApi: boolean; modelSettings?: ModelSettings | null; features?: unknown }
const COLUMNS = 'id,"ownerId","workspaceId"::text AS "workspaceId",provider,name,"baseUrl",protocol,last4,models,"modelsError","responsesApi",features'
const view = (row: Row): ApiKeyView => ({ id: row.id, provider: row.provider, name: row.name, baseUrl: row.baseUrl, protocol: row.protocol, last4: row.last4, models: row.models, modelsError: row.modelsError ?? null, responsesApi: row.responsesApi,
  ...(row.features ? { features: parseGatewayFeatures(row.features) } : {}) })
/** Where a key's models are listed: the preset's list, or the custom provider's by its protocol. */
function modelsTarget(row: Pick<Row, 'provider' | 'baseUrl' | 'protocol'>): { modelsUrl: string; auth: ApiKeyProtocol } {
  if (row.provider === 'custom') return { modelsUrl: customModelsUrl(row.baseUrl!, row.protocol), auth: row.protocol }
  const preset = API_KEY_PRESET_ENDPOINTS[row.provider]
  return { modelsUrl: preset.modelsUrl, auth: preset.modelsAuth }
}
const uuidOrNull = (value: string) => z.uuid().safeParse(value).success ? value : null

/**
 * The page's list. `keys` are the person's own (`shared: false`) and, for an
 * admin of a team workspace, the workspace's keys (`shared: true`), which the
 * admin manages. A member who is not an admin gets the workspace's keys in
 * `sharedKeys`, read-only. `canShare` means "may add and manage workspace
 * connections" (a team workspace's admin). The `shared`/`sharedKeys`/`canShare`
 * names stay for one release so the hosted settings page keeps working
 * unchanged; nothing here shares a person's key (decision 2026-11-27-1740).
 */
export interface ApiKeysPage {
  keys: (ApiKeyView & { shared: boolean })[]
  /** The workspace's own keys for a member who cannot manage them (populated by workspace-aware callers). */
  sharedKeys?: (UsableApiKey & { ownerName: string })[]
  /** A team workspace's admin: 添加工作区连接 shows. */
  canShare: boolean
  apiKeyAfterQuota: boolean
}

export async function listApiKeys(query: Query, ownerId: string, workspace: { id: string; kind: 'personal' | 'team' }, options: { admin?: boolean } = {}): Promise<ApiKeysPage> {
  const manages = workspace.kind === 'team' && options.admin === true
  const [keys, workspaceKeys, fallback] = await Promise.all([
    query.query<Row>(`SELECT ${COLUMNS} FROM model_api_keys WHERE "ownerId"=$1 ORDER BY "createdAt",id`, [ownerId]),
    manages ? query.query<Row>(`SELECT ${COLUMNS} FROM model_api_keys WHERE "workspaceId"=$1 ORDER BY "createdAt",id`, [z.uuid().parse(workspace.id)]) : Promise.resolve({ rows: [] as Row[] }),
    apiKeyAfterQuota(query, ownerId),
  ])
  return {
    keys: [...keys.rows.map(row => ({ ...view(row), shared: false })), ...workspaceKeys.rows.map(row => ({ ...view(row), shared: true }))],
    canShare: manages, apiKeyAfterQuota: fallback,
  }
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
 * Checks the key with the provider, then saves it sealed to its owner: a
 * person (a string, or `{ userId }`) or a workspace (`{ workspaceId }`, with
 * `addedBy` recorded). The caller has checked that a workspace's key is added
 * by one of its admins. Multiple keys per preset or custom provider are
 * supported (decision 2026-11-23); pass `replaceId` to rotate a key of the same
 * owner in place.
 * Errors: apiKeyInvalid (401/403), apiKeyUnverifiable (anything else),
 * apiKeyBaseUrlInvalid, apiKeyNotFound, secretsUnavailable. The key is never logged.
 */
export async function addApiKey(query: Query, ownerInput: string | ApiKeyOwner, input: unknown, options: {
  env?: Env; fetch?: typeof fetch; resolve?: (host: string) => Promise<string[]>
  /** Who added a workspace's key; it stays the workspace's when they leave. */
  addedBy?: string
} = {}): Promise<ApiKeyView> {
  const owner = asOwner(ownerInput)
  const where = ownedBy(owner)
  const parsed = addApiKeyInput.parse(input)
  const env = options.env ?? runtimeEnv()
  const custom = parsed.provider === 'custom' ? parsed : null
  const baseUrl = custom ? await checkBaseUrl(custom.baseUrl, env, options.resolve) : null
  // A preset's own protocols are its endpoints (apiKeyProtocols); the column keeps its first, for older readers.
  const protocol: ApiKeyProtocol = custom ? custom.protocol : apiKeyProtocols({ provider: parsed.provider, protocol: 'anthropic' })[0]
  const target = modelsTarget({ provider: parsed.provider, baseUrl, protocol })
  let id: string
  let endpointChanged = false
  if (parsed.replaceId) {
    const existing = (await query.query<{ id: string; provider: ApiKeyProvider; baseUrl: string | null; protocol: ApiKeyProtocol }>(
      `SELECT id,provider,"baseUrl",protocol FROM model_api_keys WHERE id=$1 AND ${where.column}=$2`, [parsed.replaceId, where.value])).rows[0]
    if (!existing || existing.provider !== parsed.provider) throw new WorkspaceError('apiKeyNotFound')
    id = existing.id
    endpointChanged = existing.provider === 'custom' && (baseUrl !== existing.baseUrl || protocol !== existing.protocol)
  } else {
    id = randomUUID()
  }
  let sealed: ReturnType<typeof sealSecret>
  try { sealed = sealSecret(parsed.apiKey, keyAad(id, aadOwner(owner)), env) } catch (error) {
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
  const personal = 'userId' in owner
  // The conflict target is the row id; the WHERE keeps a rotation inside the same owner.
  const { rows: [row] } = await query.query<Row>(`INSERT INTO model_api_keys (id,"ownerId","workspaceId","addedBy",provider,name,"baseUrl",protocol,ciphertext,iv,"keyVersion",last4,models,"responsesApi","modelSettings")
    VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb)
    ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,"baseUrl"=EXCLUDED."baseUrl",protocol=EXCLUDED.protocol,ciphertext=EXCLUDED.ciphertext,iv=EXCLUDED.iv,"keyVersion"=EXCLUDED."keyVersion",last4=EXCLUDED.last4,models=EXCLUDED.models,"modelsError"=NULL,"responsesApi"=EXCLUDED."responsesApi","modelSettings"=${SURGICAL_SPEED_MODES_SQL('$16', 'model_api_keys.')},"updatedAt"=now()
    WHERE model_api_keys."ownerId" IS NOT DISTINCT FROM EXCLUDED."ownerId" AND model_api_keys."workspaceId" IS NOT DISTINCT FROM EXCLUDED."workspaceId"
    RETURNING ${COLUMNS}`,
  [id, personal ? owner.userId : null, personal ? null : owner.workspaceId, personal ? null : options.addedBy ?? null, parsed.provider, name, baseUrl, protocol,
    sealed.ciphertext, sealed.iv, sealed.keyVersion, parsed.apiKey.slice(-4), JSON.stringify(models), responsesApi, initialSettings, speedJson])
  if (!row) throw new WorkspaceError('apiKeyNotFound')
  if (endpointChanged) await stopRunsUsingApiKeys(query, { keyId: id })
  return view(row)
}

/**
 * Updates a key's label, custom endpoint settings, or secret key in place, for
 * its owner (a person, or a workspace through its admin). Preserves
 * enabled-model flags via surgical JSONB updates. When rotating the key or
 * changing a custom endpoint/protocol, revalidates DNS/SSRF and re-verifies
 * against the provider; changing a custom endpoint/protocol stops the runs on
 * the key so none continues against a target it did not start with.
 */
export async function updateApiKey(query: Query, ownerInput: string | ApiKeyOwner, id: string, input: unknown, options: { env?: Env; fetch?: typeof fetch; resolve?: (host: string) => Promise<string[]> } = {}): Promise<ApiKeyView> {
  z.uuid().parse(id)
  const where = ownedBy(asOwner(ownerInput))
  const parsed = updateApiKeyInput.parse(input)
  const env = options.env ?? runtimeEnv()
  const { rows: [row] } = await query.query<Row>(`SELECT ${COLUMNS} FROM model_api_keys WHERE id=$1 AND ${where.column}=$2`, [id, where.value])
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
  if (endpointChanged) await stopRunsUsingApiKeys(query, { keyId: id })
  if (parsed.apiKey !== undefined) {
    let sealed: ReturnType<typeof sealSecret>
    try { sealed = sealSecret(parsed.apiKey, keyAad(id, row), env) } catch (error) {
      if (error instanceof SecretsKeyMissingError) throw new WorkspaceError('secretsUnavailable', { cause: error })
      throw error
    }
    const { rows: [saved] } = await query.query<Row>(`UPDATE model_api_keys
      SET name=$3,"baseUrl"=$4,protocol=$5,ciphertext=$6,iv=$7,"keyVersion"=$8,last4=$9,models=$10::jsonb,"modelsError"=$11,"modelSettings"=${SURGICAL_SPEED_MODES_SQL('$12')},"updatedAt"=now()
      WHERE id=$1 AND ${where.column}=$2 RETURNING ${COLUMNS}`,
    [id, where.value, nextName, nextBaseUrl, nextProtocol, sealed.ciphertext, sealed.iv, sealed.keyVersion, parsed.apiKey.slice(-4), JSON.stringify(nextModels), nextModelsError, speedJson])
    if (!saved) throw new WorkspaceError('apiKeyNotFound')
    return view(saved)
  }
  if (needsVerify) {
    const { rows: [saved] } = await query.query<Row>(`UPDATE model_api_keys
      SET name=$3,"baseUrl"=$4,protocol=$5,models=$6::jsonb,"modelsError"=$7,"modelSettings"=${SURGICAL_SPEED_MODES_SQL('$8')},"updatedAt"=now()
      WHERE id=$1 AND ${where.column}=$2 RETURNING ${COLUMNS}`,
    [id, where.value, nextName, nextBaseUrl, nextProtocol, JSON.stringify(nextModels), nextModelsError, speedJson])
    if (!saved) throw new WorkspaceError('apiKeyNotFound')
    return view(saved)
  }
  const { rows: [saved] } = await query.query<Row>(`UPDATE model_api_keys
    SET name=$3,"baseUrl"=$4,protocol=$5,models=$6::jsonb,"modelsError"=$7,"updatedAt"=now()
    WHERE id=$1 AND ${where.column}=$2 RETURNING ${COLUMNS}`,
  [id, where.value, nextName, nextBaseUrl, nextProtocol, JSON.stringify(nextModels), nextModelsError])
  if (!saved) throw new WorkspaceError('apiKeyNotFound')
  return view(saved)
}

/**
 * 重新获取模型: asks the provider's /models again with the stored key. A good
 * answer replaces the list (a custom provider that lists nothing keeps the
 * models it was added with); a failed one keeps the last list and records why,
 * for the key's row. Only the key's owner refreshes (a workspace's, through its
 * admin); the key is never returned.
 */
export async function refreshApiKeyModels(query: Query, ownerInput: string | ApiKeyOwner, id: string, options: { env?: Env; fetch?: typeof fetch; resolve?: (host: string) => Promise<string[]> } = {}): Promise<ApiKeyView> {
  z.uuid().parse(id)
  const where = ownedBy(asOwner(ownerInput))
  const { rowCount } = await query.query(`SELECT 1 FROM model_api_keys WHERE id=$1 AND ${where.column}=$2`, [id, where.value])
  if (!rowCount) throw new WorkspaceError('apiKeyNotFound')
  const env = options.env ?? runtimeEnv()
  const { row, apiKey } = await openKey(query, id, env)
  // A custom provider's host is checked again on every refetch: its name may now point at a private address (DNS rebinding).
  const reachable = row.provider !== 'custom' || await checkBaseUrl(row.baseUrl!, env, options.resolve).then(() => true, () => false)
  const result: ApiKeyVerifyResult = reachable ? await verifyApiKey(modelsTarget(row), apiKey, options.fetch) : { ok: false, code: 'unavailable' }
  const models = result.ok ? (result.models.length || row.provider !== 'custom' ? result.models : row.models) : row.models
  const responsesApi = result.ok ? true : row.responsesApi
  if (result.ok) {
    const speedJson = speedModesJson(result.speedModes)
    const { rows: [saved] } = await query.query<Row>(`UPDATE model_api_keys SET models=$3::jsonb,"modelsError"=NULL,"responsesApi"=$4,"modelSettings"=${SURGICAL_SPEED_MODES_SQL('$5')},"updatedAt"=now() WHERE id=$1 AND ${where.column}=$2 RETURNING ${COLUMNS}`,
      [id, where.value, JSON.stringify(models), responsesApi, speedJson])
    if (!saved) throw new WorkspaceError('apiKeyNotFound')
    return view(saved)
  }
  const { rows: [saved] } = await query.query<Row>(`UPDATE model_api_keys SET models=$3::jsonb,"modelsError"=$4,"responsesApi"=$5,"updatedAt"=now() WHERE id=$1 AND ${where.column}=$2 RETURNING ${COLUMNS}`,
    [id, where.value, JSON.stringify(models), result.code, responsesApi])
  if (!saved) throw new WorkspaceError('apiKeyNotFound')
  return view(saved)
}

/** The owner removes their key (a workspace's, through its admin). Runs on it stop first. */
export async function removeApiKey(query: Query, ownerInput: string | ApiKeyOwner, id: string): Promise<{ removed: boolean }> {
  z.uuid().parse(id)
  const where = ownedBy(asOwner(ownerInput))
  const { rowCount: owned } = await query.query(`SELECT 1 FROM model_api_keys WHERE id=$1 AND ${where.column}=$2`, [id, where.value])
  if (!owned) return { removed: false }
  // Runs handed this key stop first; the key is gone for them too.
  await stopRunsUsingApiKeys(query, { keyId: id })
  const { rowCount } = await query.query(`DELETE FROM model_api_keys WHERE id=$1 AND ${where.column}=$2`, [id, where.value])
  return { removed: Boolean(rowCount) }
}

/** Which owner a key id has, for an action that names a key by id alone. Never the key. */
export async function apiKeyOwnerOf(query: Query, id: string): Promise<{ ownerId: string | null; workspaceId: string | null } | null> {
  if (!z.uuid().safeParse(id).success) return null
  const { rows: [row] } = await query.query<{ ownerId: string | null; workspaceId: string | null }>('SELECT "ownerId","workspaceId"::text AS "workspaceId" FROM model_api_keys WHERE id=$1', [id])
  return row ?? null
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
  /** The person's id for their own key; the workspace's id for a workspace key. */
  ownerId: string
  /** The person's own key. */
  mine: boolean
  /** The workspace's own key (工作区连接), usable by every member there. Optional so older fixtures still type-check. */
  workspace?: boolean
  /** Server-discovered speed modes per model id (from the provider's /models capability response). */
  modelSpeedModes?: Record<string, readonly ModelSpeedMode[]>
}

/**
 * The API keys a person's runs may use in a workspace, in the order of
 * orchestration.md § 2 (like Capy, a person's own keys come first, then the
 * workspace's): the person's own keys, then the workspace's own
 * keys. Never another member's personal key (decision 2026-11-27-1740). The
 * model picker's 「API Key」 group reads this.
 */
export async function usableApiKeys(query: Query, userId: string, workspaceId: string, selectedKeyId?: string): Promise<UsableApiKey[]> {
  const rows = (await query.query<Row>(`SELECT ${COLUMNS},to_jsonb(model_api_keys)->'modelSettings' AS "modelSettings" FROM model_api_keys
    WHERE ("ownerId"=$1 OR "workspaceId"=$2::uuid)${selectedKeyId ? ' AND id=$3' : ''} ORDER BY ("ownerId" IS NULL),"createdAt",id`,
  [userId, uuidOrNull(workspaceId), ...(selectedKeyId ? [selectedKeyId] : [])])).rows
  return rows.map(row => {
    const modelSpeedModes = parseStoredSpeedModes(row.modelSettings)
    const mine = row.ownerId === userId
    return {
      ...view(row), ownerId: mine ? userId : row.workspaceId!, mine, workspace: !mine,
      models: row.models.filter(id => modelEnabled(row.modelSettings, id)),
      ...(modelSpeedModes ? { modelSpeedModes } : {}),
    }
  })
}

async function openKey(query: Query, keyId: string, env: Env) {
  const { rows: [row] } = await query.query<Row & { ciphertext: string; iv: string; keyVersion: number }>(`SELECT ${COLUMNS},to_jsonb(model_api_keys)->'modelSettings' AS "modelSettings",ciphertext,iv,"keyVersion" FROM model_api_keys WHERE id=$1`, [keyId])
  if (!row) throw new WorkspaceError('apiKeyNotFound')
  try { return { row, apiKey: openSecret(row, keyAad(row.id, row), env) } } catch (error) {
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
export async function openGatewayApiKey(query: Query, keyId: string, env: Env = runtimeEnv()) {
  z.uuid().parse(keyId)
  const { row, apiKey } = await openKey(query, keyId, env)
  return { key: view(row), apiKey, features: parseGatewayFeatures(row.features) }
}

/** The owner turns request features off for a provider that rejects them (decision 2026-11-15-2000). */
export async function setApiKeyFeatures(query: Query, ownerInput: string | ApiKeyOwner, id: string, features: GatewayFeatures): Promise<void> {
  z.uuid().parse(id)
  const where = ownedBy(asOwner(ownerInput))
  const parsed = gatewayFeaturesSchema.parse(features)
  const off = Object.fromEntries(Object.entries(parsed).filter(([, on]) => on === false))
  const { rowCount } = await query.query(`UPDATE model_api_keys SET features=$3::jsonb WHERE id=$1 AND ${where.column}=$2`,
    [id, where.value, Object.keys(off).length ? JSON.stringify(off) : null])
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
  await query.query(`INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId","apiKeyId","apiKeyModel") VALUES ($1,$2,$3,NULL,$4,$5)
    ON CONFLICT ("ownerId","workspaceId","botKey") DO UPDATE SET "bindingId"=NULL,"apiKeyId"=EXCLUDED."apiKeyId","apiKeyModel"=EXCLUDED."apiKeyModel","creditsModel"=NULL`,
  [scope.ownerId, scope.workspaceId, botId ?? 'coordinator', keyId, modelName])
  return { keyId, model: modelName, harnesses: gatewayKeyHarnesses(key) }
}

/**
 * The key and chat endpoint for one model call of a bot chat frozen on it.
 * Checked on every call, so a deleted key, or leaving the workspace whose key it
 * is, stops the chat instead of switching (§ 2). Throws WorkspaceError('apiKeyNotFound').
 */
export async function openApiKeyForChat(query: Query, userId: string, workspaceId: string, keyId: string, env: Env = runtimeEnv()): Promise<{ apiKey: string; baseUrl: string; keyOwnerId: string; provider: ApiKeyProvider; protocol: ApiKeyProtocol; modelSpeedModes?: Record<string, readonly ModelSpeedMode[]> }> {
  await assertOrganizationModelProvider(workspaceId, 'api-key')
  z.uuid().parse(keyId)
  const [usable] = await usableApiKeys(query, userId, workspaceId, keyId)
  const baseUrl = usable && apiKeyChatBaseUrl(usable)
  if (!usable || !baseUrl) throw new WorkspaceError('apiKeyNotFound')
  // A workspace's key serves its active members only.
  if (usable.workspace && !await executionMembersActive(workspaceId, [userId])) throw new WorkspaceError('apiKeyNotFound')
  const { row, apiKey } = await openKey(query, keyId, env)
  const modelSpeedModes = parseStoredSpeedModes(row.modelSettings)
  return { apiKey, baseUrl, keyOwnerId: row.ownerId ?? row.workspaceId!, provider: row.provider, protocol: row.protocol, ...(modelSpeedModes ? { modelSpeedModes } : {}) }
}

const ACTIVE_RUN = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing']

/**
 * Authorize and record a run's current key without disclosing it to the
 * machine: the run owner's own key, or the key of the workspace the run is in
 * while the owner is an active member there. Never another member's key.
 */
export async function validateRunApiKey(query: Query, runId: string, keyId: string): Promise<{ ownerId: string; workspaceId: string | null }> {
  z.uuid().parse(runId); z.uuid().parse(keyId)
  const { rows: [run] } = await query.query<{ userId: string; botId: string | null; deviceId: string | null; agentDefinition: WorkerDefinitionSnapshot | null; workspaceId: string | null; status: string; stopRequestedAt: Date | null }>(
    `SELECT r."userId",r."botId",r."deviceId",r."agentDefinition",COALESCE(b."workspaceId"::text,r."workspaceId"::text) AS "workspaceId",r.status,r."stopRequestedAt"
      FROM agent_runs r LEFT JOIN bots b ON b.id=r."botId" WHERE r.id=$1`, [runId])
  if (!run || run.stopRequestedAt || !ACTIVE_RUN.includes(run.status)) throw new WorkspaceError('apiKeyNotFound')
  if (run.workspaceId) await assertOrganizationModelProvider(run.workspaceId, 'api-key')
  if (run.agentDefinition && run.agentDefinition.apiKey?.keyId !== keyId) throw new WorkspaceError('apiKeyNotFound')
  try { await revalidateExecutionIdentity(query, run) }
  catch (error) { if (error instanceof ExecutionIdentityError) throw new WorkspaceError('apiKeyNotFound', { cause: error }); throw error }
  const key = await apiKeyOwnerOf(query, keyId)
  const own = key?.ownerId === run.userId
  const workspaceKey = Boolean(key?.workspaceId && run.workspaceId && key.workspaceId === run.workspaceId && run.agentDefinition?.apiKey
    && await executionMembersActive(run.workspaceId, [run.userId]))
  if (!key || (!own && !workspaceKey)) throw new WorkspaceError('apiKeyNotFound')
  // Recorded so removing the key stops this run (stopRunsUsingApiKeys).
  await query.query(`INSERT INTO model_api_key_runs ("runId","keyId","workspaceId") VALUES ($1,$2,$3)
    ON CONFLICT ("runId") DO UPDATE SET "keyId"=EXCLUDED."keyId","workspaceId"=EXCLUDED."workspaceId"`, [runId, keyId, run.workspaceId])
  return { ownerId: own ? run.userId : key.workspaceId!, workspaceId: run.workspaceId }
}

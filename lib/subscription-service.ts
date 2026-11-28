import { captureRunFailure, type RunFailureContext } from '@mikka/protocol/run-failure'
import { WorkflowRunFailureError } from './workflow-run-failure'
import { APP_BUILD } from './app-build'
import { createSubscriptionChatModel, createSubscriptionSearchModel } from './model-gateway/litellm-client'
import { nativeWebSearchBackendForTools, type NativeWebSearchBackend } from './model-gateway/provider-config'
import { modelGatewayProtocolBody } from './model-gateway/protocol-fields.mjs'
import { workerSubscriptionMatches } from './agent-kit/worker'
import { SUBSCRIPTION_CHAT_MAX_BYTES } from './subscription-chat-ticket'
import { quotaSnapshotSchema, type QuotaSnapshot } from '@mikka/protocol'
import { authorizeSubscriptionUse, subscriptionQuotaState, SubscriptionRefusal, type SubscriptionAccess, type SubscriptionRoute, type SubscriptionUse } from '@mikka/protocol/subscription'
import { WorkerRefusal, type SubscriptionWorkerClient, type WorkerMetadata } from '../packages/daemon/src/subscription-worker-client'
import { readSubscriptionQuota } from '../packages/daemon/src/subscription-quota'
import { SubscriptionRepository } from './subscription-repository'
import { runMayUseCredentialSql } from './personal-policy'
import { resolveSubscriptionModel } from './subscription-model'
import { nativeBrokerContextSchema, type NativeBrokerRequest } from '@mikka/protocol/subscription'
import { accountLabel, failedUsage, parseSubscriptionUsage, type SubscriptionUsage, type WorkerUsage } from './subscription-usage'
import { BACKEND_FAILURES, GENERATION_FAILURES, PRIVATE_FAILURES, generationFailureDetails } from './subscription-generation-diagnostics'
import { stepIdentity } from './model-call-timing'
import { CLEANUP_DUE_SQL, expireSubscriptionAcquisitions } from './subscription-acquire-expiry'
import { ownerSettingsChanged } from './live/lists'
import { measureSubscriptionNative } from './subscription-native-timing'
import { claudeFastSupport, codexDaybreakSupport, codexPrioritySupport, codexUltrafastSupport, subscriptionModelRequestPolicySchema, subscriptionWebSearchSupported, type CodexPrioritySupport, type SubscriptionCatalogueModel, type SubscriptionModelRequestPolicy } from './subscription-service-tier'
import { daybreakTierFromProgram } from './model-capabilities'

// Matches modelRequestMaxBytes in the Go worker. The conversation's 100k
// compaction estimate excludes the system prompt and tool schemas.
const MODEL_REQUEST_MAX_BYTES = SUBSCRIPTION_CHAT_MAX_BYTES
// Used only to preserve the public refusal of inputs still over budget.
const LEGACY_HOST_CODE_UNIT_LIMIT = 262144
// Allowlisted upstream OpenAI ChatGPT/Codex quota tier strings (`plan_type`),
// distinct from Mikka workspace entitlement plans.
const UPSTREAM_CODEX_QUOTA_TIERS: ReadonlySet<string> = new Set(['plus', 'pro', 'free', 'team', 'business', 'enterprise', 'go'])

function isUpstreamCodexQuotaTier(tier: unknown): tier is string {
  return typeof tier === 'string' && UPSTREAM_CODEX_QUOTA_TIERS.has(tier)
}

/** A provider's reasoning level name, as the worker passes it on (short lowercase word). */
const EFFORT_NAME = /^[a-z][a-z0-9_-]{0,15}$/

export interface SubscriptionCapabilities {
  /** Whether the route runs for this subscription owner (lib/subscription-routes.ts). */
  ready(route: SubscriptionRoute, ownerId: string): boolean | Promise<boolean>
  nativeIsolation: 'verified_runtime' | 'none'
  oauth?: Partial<Record<'codex' | 'claude', boolean>>
}

export type SubscriptionChatTransport = (use: SubscriptionUse, modelId: string, payload: string, signal?: AbortSignal) => Promise<Response>

function subscriptionWireError(error: unknown) {
  if (!error || typeof error !== 'object' || !('type' in error) || error.type !== 'mikka_subscription_failure'
    || !('code' in error) || typeof error.code !== 'string') return error
  if (GENERATION_FAILURES.has(error.code) || BACKEND_FAILURES.has(error.code) || PRIVATE_FAILURES.has(error.code))
    return new WorkerRefusal(error.code)
  return error
}

export class SubscriptionService {
  private readonly modelRequestPolicy?: SubscriptionModelRequestPolicy
  constructor(readonly repository: SubscriptionRepository,
    readonly worker: (scope: ReturnType<SubscriptionRepository['scope']>) => SubscriptionWorkerClient,
    readonly capabilities: SubscriptionCapabilities,
    readonly quota: (provider: 'codex' | 'claude', result: {status: number; body: unknown}) => Promise<QuotaSnapshot> | QuotaSnapshot = readSubscriptionQuota,
    readonly workspace: (ownerId: string, workspaceId: string, consumerId?: string) => Promise<void> = async () => { throw new SubscriptionRefusal('account_unavailable', { detail: 'workspace_hook_absent' }) },
    readonly admitModel: (scope: { ownerId: string; workspaceId: string; runId?: string }, model: string, route: string, signal?: AbortSignal, auditAllowed?: boolean) => Promise<void> = async (...args) => {
      const { assertSubscriptionModelTransport } = await import('./model-admission/runtime')
      await assertSubscriptionModelTransport(...args)
    },
    /** Active membership in the workspace database; a teammate's shared subscription needs it for both people. */
    readonly member: (userId: string, workspaceId: string, borrowerId?: string) => Promise<void> = async () => { throw new SubscriptionRefusal('account_unavailable', { detail: 'membership_hook_absent' }) },
    modelRequestPolicy?: SubscriptionModelRequestPolicy,
    readonly chatTransport?: SubscriptionChatTransport) {
    this.modelRequestPolicy = modelRequestPolicy === undefined ? undefined : subscriptionModelRequestPolicySchema.parse(modelRequestPolicy)
  }

  async access(use: SubscriptionUse, signal?: AbortSignal, modelOverride?: string | null, includePrioritySupport = false): Promise<SubscriptionAccess & { codexPrioritySupport?: CodexPrioritySupport; codexUltrafastSupport?: CodexPrioritySupport; claudeFastSupport?: CodexPrioritySupport; codexDaybreakTiers?: ('blue' | 'red')[] }> {
    const { modelId: boundModelId, ...binding } = await this.repository.binding(use.ownerId, use.bindingId)
    if (binding.workspaceId !== use.workspaceId || binding.consumerId !== use.consumerId) throw new SubscriptionRefusal('binding_mismatch', { detail: 'scope_mismatch' })
    await this.workspace(use.ownerId, binding.workspaceId, binding.consumerId)
    const row = await this.repository.connection(use.ownerId, binding.connectionId)
    // Same cause at both read points: the subscription account was paused. error-cause: shared detail
    if (row.paused) throw new SubscriptionRefusal('account_unavailable', { detail: 'account_paused' })
    const revision = Number(row.epoch)
    const readiness = (await this.capabilities.ready(binding.route, use.ownerId)) ? 'ready' : 'unavailable'
    const baseQuota = { vendor: row.provider === 'codex' ? 'codex' : 'claude_code', status: 'unknown', source: 'local_credentials', plan: null, observedAt: new Date().toISOString(), windows: [] }
    let quota = quotaSnapshotSchema.safeParse(row.quota).data ?? quotaSnapshotSchema.parse(baseQuota)
    // Probe only after scope/state/revision and server-side capability checks.
    if ((use.execution !== 'native' || this.capabilities.nativeIsolation === 'verified_runtime') && readiness === 'ready' && row.state === 'connected' && revision === binding.connectionRevision && (subscriptionQuotaState(quota, binding.route, Date.now(), modelOverride === null ? undefined : modelOverride ?? boundModelId) === 'unknown' || Date.now() - Date.parse(quota.observedAt) > 45_000)) {
      const client = this.worker(this.repository.scope(row)).forUse(use)
      await client.call(use.execution === 'model' && !use.runId ? 'prepareStream' : 'prepare', { revision }, signal)
      const result = await client.call<{status: number; body: unknown}>('quota', { revision }, signal)
      quota = quotaSnapshotSchema.parse(await this.quota(row.provider, result))
      await this.repository.saveQuota(row, quota)
    }
    // Re-read after async quota probing: disconnect/reconnect must win.
    const current = await this.repository.connection(use.ownerId, row.id)
    if (current.paused) throw new SubscriptionRefusal('account_unavailable', { detail: 'account_paused' })
    return {
      binding,
      ...(includePrioritySupport ? {
        codexPrioritySupport: current.provider === 'codex' ? codexPrioritySupport(current.modelCatalog, Number(current.epoch), modelOverride ?? boundModelId) : 'unknown' as const,
        codexUltrafastSupport: current.provider === 'codex' ? codexUltrafastSupport(current.modelCatalog, Number(current.epoch), modelOverride ?? boundModelId) : 'unknown' as const,
        claudeFastSupport: current.provider === 'claude' ? claudeFastSupport(current.modelCatalog, Number(current.epoch), modelOverride ?? boundModelId) : 'unknown' as const,
        codexDaybreakTiers: current.provider === 'codex' ? codexDaybreakSupport(current.modelCatalog, Number(current.epoch), modelOverride ?? boundModelId) : [],
      } : {}),
      modelId: modelOverride === null ? undefined : modelOverride ?? boundModelId,
      credentialTransition: current.state === 'refreshing' ? 'refreshing' : current.state === 'publication_pending' ? 'publication_pending' : undefined,
      connection: { id: row.id, ownerId: row.ownerId, workspaceId: row.workspaceId, provider: row.provider === 'codex' ? 'openai' : 'anthropic', revision: Number(current.epoch), state: current.state === 'connected' ? 'connected' : current.state === 'disconnected' ? 'disconnected' : current.state === 'pending' ? 'pending' : 'reconnect_required', quota },
      backend: { connectionId: row.id, connectionRevision: revision, ownerId: row.ownerId, workspaceId: row.workspaceId, route: binding.route, readiness, billing: 'subscription_only', isolation: use.execution === 'native' ? this.capabilities.nativeIsolation : 'credential_broker' }
    }
  }
  async model(use: SubscriptionUse, signal?: AbortSignal) {
    const binding = await this.repository.binding(use.ownerId, use.bindingId)
    const admit = async (callSignal = signal) => {
      await this.admitModel({ workspaceId: binding.workspaceId, ownerId: use.ownerId, runId: use.runId }, binding.modelId, binding.route, callSignal, false)
    }
    await admit()
    return resolveSubscriptionModel(use, binding.modelId, {
      access: () => this.access(use, signal),
      model: async (modelId, { connection }) => {
        const model = createSubscriptionChatModel(modelId, async init => {
          if (typeof init?.body !== 'string') {
            await logRequestFailure('body_invalid', null)
            throw new SubscriptionRefusal('backend_unavailable', { detail: 'request_body_not_string' })
          }
          const bytes = Buffer.byteLength(init.body, 'utf8')
          if (bytes > MODEL_REQUEST_MAX_BYTES) {
            await logRequestFailure('payload_too_large', bytes)
            // Keep the old public mapping; the UTF-16 threshold is not the
            // new transport budget and does not decide whether to admit it.
            throw init.body.length > LEGACY_HOST_CODE_UNIT_LIMIT
              ? new SubscriptionRefusal('backend_unavailable', { detail: 'payload_over_transport_limit' })
              : new Error('subscription_generation_failed (payload_over_legacy_limit)')
          }
          const payload = JSON.parse(init.body)
          if (payload.model !== binding.modelId || payload.stream !== true) throw new SubscriptionRefusal('binding_mismatch', { detail: 'stream_request_mismatch' })
          const codexTierIntent = binding.route === 'codex_cpa' ? this.modelRequestPolicy?.codexServiceTier : undefined
          const codexCyberIntent = binding.route === 'codex_cpa' ? this.modelRequestPolicy?.codexCyberAccessProgram : undefined
          const claudeFastIntent = binding.route === 'claude_cpa' && this.modelRequestPolicy?.claudeSpeed === 'fast'
          const checkSpeedSupport = Boolean(codexTierIntent || claudeFastIntent || codexCyberIntent)
          const authorized = await this.check(use, signal, undefined, checkSpeedSupport)
          await admit(init.signal ?? signal ?? undefined)
          // Provider options are not an opt-in to a paid service tier or access program. Only
          // the internal server policy and this fresh epoch's catalogue can request them.
          delete payload.access_programs
          if (binding.route === 'codex_cpa') {
            delete payload.service_tier
            if (codexTierIntent === 'ultrafast' && authorized.codexUltrafastSupport === 'supported') payload.service_tier = 'ultrafast'
            else if (codexTierIntent === 'priority' && authorized.codexPrioritySupport === 'supported') payload.service_tier = 'priority'
            if (codexTierIntent) {
              const capability = codexTierIntent === 'ultrafast' ? (authorized.codexUltrafastSupport ?? 'unknown') : (authorized.codexPrioritySupport ?? 'unknown')
              try { console.info(JSON.stringify({ level: 'info', msg: 'subscription_service_tier_policy', intent: codexTierIntent, capability, requested: payload.service_tier === 'priority' || payload.service_tier === 'ultrafast' ? payload.service_tier : 'omitted', ...await stepIdentity() })) } catch { /* diagnostics cannot change authorization or the request */ }
            }
            const cyberTier = daybreakTierFromProgram(codexCyberIntent)
            if (codexCyberIntent && cyberTier && authorized.codexDaybreakTiers?.includes(cyberTier)) {
              payload.access_programs = { cyber: codexCyberIntent }
            }
          } else if (binding.route === 'claude_cpa') {
            delete payload.speed
            if (claudeFastIntent && authorized.claudeFastSupport === 'supported') payload.speed = 'fast'
          }
          const prepared = JSON.stringify(payload)
          if (Buffer.byteLength(prepared, 'utf8') > MODEL_REQUEST_MAX_BYTES)
            throw new SubscriptionRefusal('backend_unavailable', { detail: 'payload_over_transport_limit' })
          const callSignal = init.signal ?? signal ?? undefined
          if (this.chatTransport) return this.chatTransport(use, modelId, prepared, callSignal)
          const { streamSubscriptionChat } = await import('./subscription-chat-bridge')
          return streamSubscriptionChat(use, modelId, callSignal, () => this.openLiteLLMChat(use, modelId, payload, callSignal))
        })
        const doStream = model.doStream.bind(model)
        model.doStream = async options => {
          const failureContext: RunFailureContext = { credential: 'subscription', provider: connection.provider === 'openai' ? 'codex' : 'claude_code', appVersion: APP_BUILD, requestBodyValues: { prompt: options.prompt, tools: options.tools, providerOptions: options.providerOptions, headers: options.headers } }
          try {
            const search = nativeWebSearchBackendForTools(options.tools)
            const result = search ? await this.nativeSearchModel(use, modelId, search, options.abortSignal ?? signal).doStream(options)
              : await doStream(options)
            const reader = result.stream.getReader()
            let closed = false
            const stream: typeof result.stream = new ReadableStream({
              async pull(controller) {
                try {
                  const { value, done } = await reader.read()
                  if (closed) return
                  if (done) { closed = true; reader.releaseLock(); controller.close(); return }
                  if (value.type === 'error') {
                    const error = subscriptionWireError(value.error)
                    const cancelled = requestedCancellation(error, options.abortSignal, signal)
                    if (cancelled) {
                      closed = true; controller.error(cancelled)
                      try { await reader.cancel(cancelled) } finally { reader.releaseLock() }
                      return
                    }
                    await logGenerationFailure('stream_part', error)
                    controller.enqueue({ type: 'error', error: subscriptionGenerationError(error, failureContext) })
                  } else {
                    controller.enqueue(value)
                  }
                } catch (error) {
                  if (closed) return
                  const cancelled = requestedCancellation(error, options.abortSignal, signal)
                  if (cancelled) { closed = true; reader.releaseLock(); controller.error(cancelled); return }
                  await logGenerationFailure('stream', error)
                  closed = true; reader.releaseLock()
                  controller.enqueue({ type: 'error', error: subscriptionGenerationError(error, failureContext) }); controller.close()
                }
              },
              async cancel(reason) { closed = true; await reader.cancel(reason); reader.releaseLock() }
            })
            return { ...result, stream }
          } catch (error) {
            const cancelled = requestedCancellation(error, options.abortSignal, signal)
            if (cancelled) throw cancelled
            await logGenerationFailure('start', error); throw subscriptionGenerationError(error, failureContext)
          }
        }
        return model
      }
    })
  }

  async modelSearchBackend(use: SubscriptionUse, refresh = false): Promise<NativeWebSearchBackend | undefined> {
    if (use.execution !== 'model' || use.runId) return
    const binding = await this.repository.binding(use.ownerId, use.bindingId)
    if (binding.workspaceId !== use.workspaceId || binding.consumerId !== use.consumerId) return
    let row = await this.repository.connection(use.ownerId, binding.connectionId)
    const ready = () => !row.paused && row.state === 'connected' && binding.connectionRevision === Number(row.epoch)
    if (!ready() || binding.route !== `${row.provider}_cpa`) return
    if (refresh && row.modelCatalog?.webSearchVersion !== 1 && !row.modelCatalog?.webSearchSupport) {
      const [{ pool }, { ExecutionSettings }] = await Promise.all([import('./db'), import('./execution-settings')])
      try {
        await new ExecutionSettings(pool).refreshBotModels({ ownerId: use.ownerId, workspaceId: use.workspaceId }, row.id,
          (ownerId, connectionId) => this.models(ownerId, connectionId, AbortSignal.timeout(8000)))
      } catch { return }
      row = await this.repository.connection(use.ownerId, binding.connectionId)
    }
    if (!ready() || !subscriptionWebSearchSupported(row.modelCatalog, Number(row.epoch), binding.modelId)) return
    return row.provider === 'claude' ? 'anthropic' : 'openai'
  }

  private nativeSearchModel(use: SubscriptionUse, modelId: string, protocol: NativeWebSearchBackend, signal?: AbortSignal) {
    return createSubscriptionSearchModel(modelId, protocol, async init => {
      const callSignal = init?.signal ?? signal
      if (typeof init?.body !== 'string' || Buffer.byteLength(init.body, 'utf8') > MODEL_REQUEST_MAX_BYTES)
        throw new SubscriptionRefusal('backend_unavailable', { detail: 'payload_over_transport_limit' })
      const payload = JSON.parse(init.body)
      if (payload.model !== modelId || payload.stream !== true || await this.modelSearchBackend(use) !== protocol)
        throw new SubscriptionRefusal('binding_mismatch', { detail: 'native_search_unavailable' })
      const authorized = await this.check(use, callSignal, undefined, true)
      const route = authorized.binding.route
      await this.admitModel({ workspaceId: use.workspaceId, ownerId: use.ownerId }, modelId, route, callSignal)
      const row = await this.repository.connection(use.ownerId, authorized.binding.connectionId)
      const [{ pool }, { admitWebRequest }] = await Promise.all([import('./db'), import('./search/rate-limit')])
      if (!await admitWebRequest(pool, use.ownerId, callSignal)) throw new WorkerRefusal('subscription_rate_limited')
      const headers = new Headers(init.headers)
      const body: Record<string, unknown> = { ...modelGatewayProtocolBody(protocol, payload), model: modelId }
      delete body.metadata
      delete body.service_tier
      const codexTier = this.modelRequestPolicy?.codexServiceTier
      const daybreak = this.modelRequestPolicy?.codexCyberAccessProgram
      const tier = daybreakTierFromProgram(daybreak)
      const approvedFields = protocol === 'openai' ? {
        store: false,
        ...(codexTier === 'ultrafast' && authorized.codexUltrafastSupport === 'supported' ? { service_tier: codexTier }
          : codexTier === 'priority' && authorized.codexPrioritySupport === 'supported' ? { service_tier: codexTier } : {}),
        ...(tier && authorized.codexDaybreakTiers?.includes(tier) ? { access_programs: { cyber: daybreak } } : {}),
      } : this.modelRequestPolicy?.claudeSpeed === 'fast' && authorized.claudeFastSupport === 'supported' ? { speed: 'fast' } : {}
      const request = {
        path: protocol === 'anthropic' ? '/v1/messages' : '/responses',
        body: { ...body, ...approvedFields },
        headers: Object.fromEntries(['accept', 'anthropic-version', 'anthropic-beta'].flatMap(name => {
          const value = headers.get(name)
          return value ? [[name, value]] : []
        })),
      }
      if (protocol === 'anthropic' && 'speed' in approvedFields)
        request.headers['anthropic-beta'] = [request.headers['anthropic-beta'], 'fast-mode-2026-02-01'].filter(Boolean).join(',')
      const { streamSubscriptionModelSearch } = await import('./subscription-chat-bridge')
      return streamSubscriptionModelSearch(use, modelId, protocol, callSignal,
        () => this.worker(this.repository.scope(row)).forUse(use).modelSearchRequest(authorized.binding.connectionRevision, request, callSignal))
    })
  }
  /** Revalidate live custody before starting a CPA stream. */
  async openLiteLLMChat(use: SubscriptionUse, modelId: string, payload: unknown, signal?: AbortSignal) {
    const binding = await this.repository.binding(use.ownerId, use.bindingId)
    if (use.execution !== 'model' || binding.modelId !== modelId) throw new SubscriptionRefusal('binding_mismatch')
    const { connection } = await this.check(use, signal)
    await this.admitModel({ workspaceId: binding.workspaceId, ownerId: use.ownerId, runId: use.runId }, modelId, binding.route, signal)
    const client = this.worker({ ownerId: connection.ownerId, workspaceId: connection.workspaceId,
      connectionId: connection.id, provider: connection.provider === 'openai' ? 'codex' : 'claude' }).forUse(use)
    return { start: () => client.stream(binding.connectionRevision, modelId, payload, signal) }
  }
  async check(use: SubscriptionUse, signal?: AbortSignal, modelOverride?: string | null, includePrioritySupport = false) {
    const access = await this.access(use, signal, modelOverride, includePrioritySupport)
    const authorized = authorizeSubscriptionUse(use, access)
    return {
      ...authorized,
      ...(includePrioritySupport ? {
        codexPrioritySupport: access.codexPrioritySupport,
        codexUltrafastSupport: access.codexUltrafastSupport,
        claudeFastSupport: access.claudeFastSupport,
        codexDaybreakTiers: access.codexDaybreakTiers,
      } : {}),
    }
  }
  async nativeRun(ownerId: string, deviceId: string, runId: string) {
    const { rows } = await this.repository.pool.query(`select b.id,b."ownerId",b."workspaceId",b."consumerId",b.route,b."modelId",r."agentDefinition",a.harness from byos_native_runs n join agent_runs r on r.id=n."runId" join agents a on a.id=r."agentId" join devices d on d.id=r."deviceId" and d."ownerId"=r."userId" and d.enabled=true join byos_bindings b on b.id=n."bindingId" where r.id=$1 and r."userId"=$2 and r."deviceId"=$3 and a."userId"=$2 and ${runMayUseCredentialSql('b."ownerId"', '$2', 'b."workspaceId"')} and b."consumerId"=a.id::text and d.harnesses @> jsonb_build_array(jsonb_build_object('harness',coalesce(r."agentDefinition"->>'harness',a.harness),'installed',true,'subscriptionBroker',true))
      and not exists (select 1 from jsonb_array_elements(d.harnesses) info where info->>'harness'=coalesce(r."agentDefinition"->>'harness',a.harness) and info ? 'subscriptionPreflight')
      and r.status in ('preparing','running','paused','waiting_input') and r."leaseExpiresAt">now() and r."stopRequestedAt" is null`, [runId,ownerId,deviceId])
    if (!rows[0]) throw new SubscriptionRefusal('account_unavailable', { detail: 'native_run_not_found' })
    const row=rows[0]
    if (!workerSubscriptionMatches(row.agentDefinition,row.harness,row)) throw new SubscriptionRefusal('binding_mismatch', { detail: 'harness_contract_mismatch' })
    if (String(row.ownerId) !== ownerId) {
      try { await this.member(ownerId, row.workspaceId); await this.member(String(row.ownerId), row.workspaceId, ownerId) }
      catch (error) { throw new SubscriptionRefusal('account_unavailable', { detail: 'membership_check_failed', cause: error }) }
    }
    // The use belongs to the credential's owner, who is always the run owner (decision 2026-11-17-1400).
    return {ownerId:String(row.ownerId),workspaceId:row.workspaceId,consumerId:row.consumerId,bindingId:row.id,execution:'native',runId} as const
  }
  async nativeContext(use: SubscriptionUse, signal?: AbortSignal, requireModelCatalogue = false) {
    return measureSubscriptionNative('context', use.runId, async timing => {
      const binding=await timing.measure('binding', () => this.repository.binding(use.ownerId,use.bindingId))
      const selected = await timing.measure('selection', () => this.nativeRunSelection(use, binding.modelId))
      const scope = { ownerId: selected.executionOwnerId, workspaceId: binding.workspaceId, runId: use.runId }
      // Context probes enforce policy without recording a model generation.
      await timing.measure('admit_before', () => this.admitModel(scope, selected.modelId ?? binding.modelId, binding.route, signal, false))
      const authorized=await timing.measure('access', () => this.check(use,signal,selected.modelId ?? null))
      await timing.measure('admit_after', () => this.admitModel(scope, selected.modelId ?? binding.modelId, binding.route, signal, false))
      const row=await timing.measure('connection', () => this.repository.connection(use.ownerId,binding.connectionId))
      // Requested only by a daemon that could not resolve a full ID through its
      // shortcut menu. The evidence belongs to this exact authorized binding and
      // credential epoch; a different account's catalogue grants nothing.
      if (requireModelCatalogue && (binding.route !== 'claude_code_cli' || row.state !== 'connected'
        || row.paused || Number(row.epoch) !== authorized.binding.connectionRevision
        || !row.modelCatalog || Number(row.modelCatalog.revision) !== Number(row.epoch)
        || !Array.isArray(row.modelCatalog.models) || !row.modelCatalog.models.includes(binding.modelId))) {
        throw new SubscriptionRefusal('binding_mismatch', { detail: 'catalogue_out_of_epoch' })
      }
      const client=this.worker(this.repository.scope(row)).forUse(use)
      await timing.measure('prepare', () => client.call('prepare',{revision:authorized.binding.connectionRevision},signal))
      const info=await timing.measure('context', () => client.call<{accountId:string;plan?:string;expiresAt:string}>('nativeContext',{revision:authorized.binding.connectionRevision},signal))
      return nativeBrokerContextSchema.parse({ accountId: info.accountId, ...(info.plan ? { plan: info.plan } : {}),
        expiresAt: typeof info.expiresAt === 'string' ? new Date(info.expiresAt).toISOString() : info.expiresAt,
        route: binding.route, modelId: selected.modelId ?? binding.modelId, revision: authorized.binding.connectionRevision })
    })
  }
  async nativeRequest(use: SubscriptionUse, request: NativeBrokerRequest, signal?: AbortSignal) {
    return measureSubscriptionNative('request', use.runId, async timing => {
      const binding=await timing.measure('binding', () => this.repository.binding(use.ownerId,use.bindingId))
      if(!request.body || typeof request.body!=='object' || Array.isArray(request.body) || !('model' in request.body) || typeof request.body.model!=='string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.body.model))throw new SubscriptionRefusal('binding_mismatch', { detail: 'model_field_invalid' })
      const selected = await timing.measure('selection', () => this.nativeRunSelection(use, binding.modelId))
      if (selected.modelId !== undefined && request.body.model!==selected.modelId) throw new SubscriptionRefusal('binding_mismatch', { detail: 'model_not_selected' })
      if(binding.route==='codex_cli'?request.path!=='/responses':binding.route!=='claude_code_cli'||!['/v1/messages','/v1/messages?beta=true','/v1/messages/count_tokens'].includes(request.path))throw new SubscriptionRefusal('backend_unavailable', { detail: 'route_not_allowed_for_binding' })
      const scope = { ownerId: selected.executionOwnerId, workspaceId: binding.workspaceId, runId: use.runId }
      const model = request.body.model
      await timing.measure('admit_before', () => this.admitModel(scope, model, binding.route, signal))
      const authorized=await timing.measure('access', () => this.check(use,signal,model))
      await timing.measure('admit_after', () => this.admitModel(scope, model, binding.route, signal))
      const row=await timing.measure('connection', () => this.repository.connection(use.ownerId,binding.connectionId))
      let forwardedRequest = request
      if ('access_programs' in request.body) {
        const body = { ...(request.body as Record<string, unknown>) }
        const requestedCyber = body.access_programs && typeof body.access_programs === 'object' && !Array.isArray(body.access_programs)
          ? (body.access_programs as { cyber?: unknown }).cyber : undefined
        const tier = binding.route === 'codex_cli' ? daybreakTierFromProgram(requestedCyber) : undefined
        const supported = tier ? codexDaybreakSupport(row.modelCatalog, Number(row.epoch), model).includes(tier) : false
        delete body.access_programs
        if (supported && typeof requestedCyber === 'string') body.access_programs = { cyber: requestedCyber }
        forwardedRequest = { ...request, body }
      }
      return timing.measure('provider_headers', () => this.worker(this.repository.scope(row)).forUse(use).nativeRequest(authorized.binding.connectionRevision,forwardedRequest,signal))
    })
  }
  /** Run policy belongs to the executor; credential custody stays with its
   * lender. Both identities come from the authorized binding/run, never input. */
  private async nativeRunSelection(use: SubscriptionUse, boundModel: string) {
    let selectedModel: string | undefined = boundModel
    let executionOwnerId = use.ownerId
    if (use.runId) {
      const row=(await this.repository.pool.query(`SELECT r."userId",r."agentDefinition" FROM agent_runs r JOIN byos_native_runs n ON n."runId"=r.id JOIN byos_bindings b ON b.id=n."bindingId" WHERE r.id=$1 AND b."ownerId"=$2 AND ${runMayUseCredentialSql('$2', 'r."userId"', 'b."workspaceId"')} AND r."agentId"::text=$3 AND n."bindingId"=$4 AND r.status IN ('preparing','running','paused','waiting_input') AND r."leaseExpiresAt">now() AND r."stopRequestedAt" IS NULL`,[use.runId,use.ownerId,use.consumerId,use.bindingId])).rows[0]
      if (!row || typeof row.userId !== 'string' || !row.userId) throw new SubscriptionRefusal('binding_mismatch', { detail: 'owner_id_invalid' })
      executionOwnerId = row.userId
      if (executionOwnerId !== use.ownerId) await this.member(use.ownerId, use.workspaceId, executionOwnerId)
      if (row.agentDefinition?.cliModelSelection==='auto') selectedModel=undefined
      if (row.agentDefinition?.cliModelSelection==='explicit') selectedModel=row.agentDefinition.model
    }
    return { modelId: selectedModel, executionOwnerId }
  }
  /** Fresh allowance for model admission, under the same owner custody as Usage.
   * Settings-only account/profile reads and account writes stay in usage(). */
  async allowance(ownerId: string, id: string, signal?: AbortSignal): Promise<void> {
    const row = await this.repository.connection(ownerId, id)
    if (row.state !== 'connected') return
    try {
      const result = await this.worker(this.repository.scope(row)).call<Pick<WorkerUsage, 'status' | 'body'>>('allowance', { revision: Number(row.epoch) }, signal)
      const quota = quotaSnapshotSchema.parse(await this.quota(row.provider, result))
      const upstreamTier = result.body && typeof result.body === 'object' && 'plan_type' in result.body ? result.body.plan_type : undefined
      // Only the already-returned, allowlisted Codex quota tier is new metadata.
      // Claude and missing/unknown tiers keep the current DB value in the same
      // epoch-fenced UPDATE, including a Settings change during this await.
      const hasUpstreamTier = row.provider === 'codex' && result.status === 200
        && isUpstreamCodexQuotaTier(upstreamTier) && typeof quota.plan === 'string' && quota.plan.length > 0
      await this.repository.saveQuota(row, quota, hasUpstreamTier ? undefined : { preservePlan: true })
    } catch {
      const now = await this.repository.connection(ownerId, id).catch(() => null)
      if (now && now.state !== row.state) await (await import('./live/lists')).ownerSettingsChanged(this.repository.pool, ownerId)
    }
  }
  /** The owner's own Settings read: no binding, a connected revision only.
   * Never throws for a provider or worker failure: the row degrades instead,
   * keeping the last known email. */
  async usage(ownerId: string, id: string, signal?: AbortSignal): Promise<SubscriptionUsage> {
    const row = await this.repository.connection(ownerId, id)
    if (row.state !== 'connected') return failedUsage(row.id, 'unavailable', row.accountLabel)
    try {
      const result = await this.worker(this.repository.scope(row)).call<WorkerUsage>('usage', { revision: Number(row.epoch) }, signal)
      // The same safe provider projection drives Settings and the next Bot/Agent
      // use. saveQuota fences the read to this owner and connected revision.
      await this.repository.saveQuota(row, quotaSnapshotSchema.parse(await this.quota(row.provider, result)))
      const usage = parseSubscriptionUsage(row.id, row.provider, result)
      if (usage.account && usage.account !== row.accountLabel) await this.repository.saveAccountLabel(row, usage.account).catch(() => undefined)
      return { ...usage, account: usage.account ?? accountLabel(row.accountLabel) }
    } catch {
      // The list shows a connection the runtime itself moved to reconnect_required; open 模型与订阅 pages re-read it.
      const now = await this.repository.connection(ownerId, id).catch(() => null)
      if (now && now.state !== row.state) await (await import('./live/lists')).ownerSettingsChanged(this.repository.pool, ownerId)
      return failedUsage(row.id, 'unavailable', row.accountLabel)
    }
  }
  /** Account catalogue refresh; no inference, no static model names or binding required. */
  async models(ownerId: string, id: string, signal?: AbortSignal): Promise<(SubscriptionCatalogueModel & { name: string })[]> {
    // The owner's own account-level read: no workspace membership needed (decision 2026-10-31-2130).
    const row = await this.repository.connection(ownerId, id)
    if (row.state !== 'connected') throw new SubscriptionRefusal('account_unavailable', { detail: 'connection_not_connected' })
    const result = await this.worker(this.repository.scope(row)).call<unknown>('models', { revision: Number(row.epoch) }, signal)
    const current = await this.repository.connection(ownerId, id)
    if (current.state !== 'connected' || current.epoch !== row.epoch) throw new SubscriptionRefusal('stale_binding', { detail: 'connection_epoch_changed' })
    if (!Array.isArray(result) || result.length > 500) throw new SubscriptionRefusal('backend_unavailable', { detail: 'catalogue_response_invalid' })
    const options = new Map<string, SubscriptionCatalogueModel & { name: string }>()
    for (const item of result) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200 || Array.from(item.name as string).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new SubscriptionRefusal('backend_unavailable', { detail: 'catalogue_entry_invalid' })
      if (item.prioritySupported !== undefined && typeof item.prioritySupported !== 'boolean') throw new SubscriptionRefusal('backend_unavailable', { detail: 'catalogue_priority_flag_invalid' })
      if (item.ultrafastSupported !== undefined && typeof item.ultrafastSupported !== 'boolean') throw new SubscriptionRefusal('backend_unavailable', { detail: 'catalogue_priority_flag_invalid' })
      if (item.fastSupported !== undefined && typeof item.fastSupported !== 'boolean') throw new SubscriptionRefusal('backend_unavailable', { detail: 'catalogue_priority_flag_invalid' })
      if (item.webSearchSupported !== undefined && typeof item.webSearchSupported !== 'boolean') throw new SubscriptionRefusal('backend_unavailable', { detail: 'catalogue_web_search_flag_invalid' })
      if (item.efforts !== undefined && (!Array.isArray(item.efforts) || item.efforts.length > 12 || item.efforts.some((level: unknown) => typeof level !== 'string' || !EFFORT_NAME.test(level)))) throw new SubscriptionRefusal('backend_unavailable', { detail: 'catalogue_effort_invalid' })
      if (item.defaultEffort !== undefined && (typeof item.defaultEffort !== 'string' || !item.efforts?.includes(item.defaultEffort))) throw new SubscriptionRefusal('backend_unavailable', { detail: 'catalogue_effort_invalid' })
      if (item.daybreak !== undefined && (!Array.isArray(item.daybreak) || item.daybreak.length > 2 || item.daybreak.some((tier: unknown) => tier !== 'blue' && tier !== 'red'))) throw new SubscriptionRefusal('backend_unavailable', { detail: 'catalogue_daybreak_invalid' })
      if (!options.has(item.id)) options.set(item.id, {
        id: item.id,
        name: item.name,
        ...(row.provider === 'codex' && typeof item.prioritySupported === 'boolean' ? { prioritySupported: item.prioritySupported } : {}),
        ...(row.provider === 'codex' && typeof item.ultrafastSupported === 'boolean' ? { ultrafastSupported: item.ultrafastSupported } : {}),
        ...(row.provider === 'claude' && typeof item.fastSupported === 'boolean' ? { fastSupported: item.fastSupported } : {}),
        ...(typeof item.webSearchSupported === 'boolean' ? { webSearchSupported: item.webSearchSupported } : {}),
        ...(Array.isArray(item.efforts) ? { efforts: [...new Set(item.efforts as string[])] } : {}),
        ...(typeof item.defaultEffort === 'string' ? { defaultEffort: item.defaultEffort } : {}),
        ...(row.provider === 'codex' && Array.isArray(item.daybreak) && item.daybreak.length ? { daybreak: [...new Set(item.daybreak as ('blue' | 'red')[])] } : {}),
      })
    }
    return [...options.values()]
  }
  async status(ownerId: string, id: string, signal?: AbortSignal) {
    const row = await this.repository.connection(ownerId, id)
    const status = await this.worker(this.repository.scope(row)).call<WorkerMetadata>('status', {}, signal)
    return { id: row.id, provider: row.provider, state: status.state, revision: status.revision, cleanup: status.cleanup }
  }
  async cleanupBatch() {
    // Operator-authenticated caller only. Each worker remains fixed to one
    // owner/connection; this never lists or exports credential values.
    const expired = await expireSubscriptionAcquisitions(this.repository.pool)
    await Promise.all(expired.ownerIds.map(ownerId => ownerSettingsChanged(this.repository.pool, ownerId)))
    const { rows } = await this.repository.pool.query(`with due as(${CLEANUP_DUE_SQL}) select c.id,c."ownerId",c."workspaceId",c.provider from due d join byos_connections c on c.id=d."connectionId" group by c.id,c."ownerId",c."workspaceId",c.provider order by coalesce(max(d.attempted),'epoch'::timestamptz),c.id limit 2`)
    const results = []
    for (const row of rows) {
      try { results.push(await this.worker(this.repository.scope(row)).call<{pending: number; failed: number; providerRevocation: 'not_implemented'}>('cleanup')) }
      catch { results.push({ pending: null, failed: true }) }
    }
    return { expired: expired.expired, processed: results.length, results }
  }
}

/** The SDK recognizes a requested cancellation by AbortError, not an error
 * part. Preserve that control flow through its HTTP wrapper; an ordinary
 * provider error, unrequested cancellation, or deadline is still a failure. */
function requestedCancellation(error: unknown, ...signals: (AbortSignal | undefined)[]): Error | undefined {
  if (!signals.some(signal => signal?.aborted && !(signal.reason instanceof Error && signal.reason.name === 'TimeoutError'))) return
  let cause = error
  for (let depth = 0; depth < 4; depth++) {
    if ((cause instanceof WorkerRefusal && cause.code === 'subscription_cancelled') || (cause instanceof Error && cause.name === 'AbortError')) {
      return Object.assign(new Error('subscription_cancelled', { cause: error }), { name: 'AbortError' })
    }
    if (!(cause instanceof Error)) break
    cause = cause.cause
  }
}

/** Only fixed, typed refusal codes cross into persisted chat errors. SDK
 * wrappers may carry the original error in cause; raw provider text cannot. */
export function subscriptionGenerationError(error: unknown, context: RunFailureContext = {}): Error {
  const original = error
  let code = 'subscription_generation_failed'
  for (let depth = 0; depth < 4; depth++) {
    if (error instanceof SubscriptionRefusal || error instanceof WorkerRefusal) {
      if (GENERATION_FAILURES.has(error.code)) { code = error.code; break }
      if (error.code === 'invalid_credential_bundle') { code = 'reconnect_required'; break }
      if (BACKEND_FAILURES.has(error.code)) { code = 'backend_unavailable'; break }
    }
    if (!(error instanceof Error)) break
    error = error.cause
  }
  return new WorkflowRunFailureError(captureRunFailure(original, { credential: 'subscription', ...context }), { cause: original }, code)
}

/**
 * Why a subscription turn produced no answer, for the logs: the stage and the
 * fixed refusal code (SubscriptionRefusal, WorkerRefusal) or the error's class
 * name. Never a message, which can carry provider text.
 */
export function generationFailureCode(error: unknown): string {
  if ((error instanceof SubscriptionRefusal || error instanceof WorkerRefusal) && (GENERATION_FAILURES.has(error.code) || BACKEND_FAILURES.has(error.code) || PRIVATE_FAILURES.has(error.code))) return error.code
  return generationFailureDetails(error).errorClass
}
async function logGenerationFailure(stage: 'start' | 'stream' | 'stream_part', error: unknown) {
  try {
    const identity = await stepIdentity()
    console.warn(JSON.stringify({ level: 'warn', msg: 'subscription_generation_failed', stage, code: generationFailureCode(error), ...generationFailureDetails(error), workflowRunId: identity.workflowRunId ?? null, stepId: identity.stepId ?? null, attempt: identity.attempt ?? null }))
  } catch { /* diagnostics cannot change the model result */ }
}

async function logRequestFailure(reason: 'body_invalid' | 'payload_too_large', bytes: number | null) {
  try {
    const identity = await stepIdentity()
    console.warn(JSON.stringify({ level: 'warn', msg: 'subscription_request_failure', phase: 'host_input', reason, bytes, limit: MODEL_REQUEST_MAX_BYTES, workflowRunId: identity.workflowRunId ?? null, stepId: identity.stepId ?? null, attempt: identity.attempt ?? null }))
  } catch { /* diagnostics cannot change the model result */ }
}

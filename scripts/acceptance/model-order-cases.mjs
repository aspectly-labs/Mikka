/** Owner model-order, source and run-evidence checks shared by the smoke-owner
 * acceptance drivers (project-decisions.mjs, production-readiness.mjs). They read
 * only what a caller passes in and send nothing themselves. */

// The small models each case may select; the drivers name their own case ids.
const MODELS = Object.freeze([
  { model: 'deepseek-flash', harness: 'claude_code', kind: 'api_key' },
  { model: 'claude-haiku-5-5', harness: 'claude_code', kind: 'subscription' },
  { model: 'gpt-6-luna', harness: 'codex', kind: 'subscription' },
])
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
const runStatuses = new Set(['queued', 'preparing', 'running', 'waiting_input', 'paused', 'finishing', 'succeeded', 'failed', 'stopped', 'cancelled'])
const codes = new Set(['response_invalid', 'workspace_busy', 'source_missing', 'source_ambiguous', 'source_blocked',
  'cloud_unavailable', 'order_restore_unavailable', 'run_scope', 'run_model', 'run_credential', 'run_identity', 'checks_missing'])
/** Carries a closed code and a status; callers project it into their own reports. */
export class AcceptanceError extends Error {
  constructor(code, status = 'blocked', detail = {}) {
    super(codes.has(code) ? code : 'acceptance_failed')
    this.status = ['blocked', 'failed'].includes(status) ? status : 'failed'
    this.detail = detail
  }
}
const check = (condition, code, status = 'blocked') => { if (!condition) throw new AcceptanceError(code, status) }

const sourceId = entry => entry?.source?.kind === 'api_key' ? entry.source.keyId : entry?.source?.connectionId
const entryKey = entry => JSON.stringify([entry?.harness, entry?.model, entry?.source?.kind, sourceId(entry)])
export function orderFingerprint(order) {
  return JSON.stringify({ location: order.location, customized: order.customized, preferredHarness: order.preferredHarness,
    entries: order.entries.map(entry => ({ id: entry.id, harness: entry.harness, model: entry.model, source: entry.source })) })
}

/** Factory checks select from the order again, without the producer's explicit
 * model. The entire temporary order contains only this case's own sources. */
export function caseOrderPlan(order, wanted, ownerId) {
  check(wanted.length > 0 && wanted.length <= 2 && wanted.every(entry => entry.credentialOwnerId === ownerId
    && MODELS.some(item => item.model === entry.model && item.harness === entry.harness && item.kind === entry.source?.kind)), 'run_identity')
  const already = JSON.stringify(order.entries.map(entryKey)) === JSON.stringify(wanted.map(entryKey))
  if (!already) check(order.customized === true && Array.isArray(order.candidates)
    && order.entries.every(entry => order.candidates.some(candidate => entryKey(candidate) === entryKey(entry))), 'order_restore_unavailable')
  return { already, wanted }
}

export function ownedSource(item, { order, keys, connections, ownerId }) {
  check(Array.isArray(order?.candidates) && Array.isArray(keys?.keys) && Array.isArray(connections?.connections), 'response_invalid')
  const own = item.kind === 'api_key'
    ? keys.keys.filter(key => key.provider === item.provider).map(key => key.id)
    : connections.connections.filter(connection => connection.provider === item.provider && connection.state === 'connected' && !connection.paused).map(connection => connection.id)
  const choices = order.candidates.filter(entry => entry.model === item.model && entry.harness === item.harness
    && entry.source?.kind === item.kind && own.includes(sourceId(entry)) && entry.credentialOwnerId === ownerId)
  check(choices.length > 0, 'source_missing')
  // The public native receipt exposes its binding, not its connection id.
  // One eligible own account avoids claiming an unproved connection switch.
  check(new Set(choices.map(sourceId)).size === 1, 'source_ambiguous')
  const choice = choices[0]
  const row = order.entries.find(entry => entryKey(entry) === entryKey(choice))
  if (row?.block && row.block.reason !== 'checking') throw new AcceptanceError('source_blocked', 'blocked', { block: row.block.reason })
  check(order.location === 'cloud' && order.cloudReady === true, 'cloud_unavailable')
  if (row && order.cloudModels?.[row.id] !== 'ready') throw new AcceptanceError('cloud_unavailable')
  return choice
}

export function assertRunEvidence(found, { ownerId, workspaceId, botId, issueId, model, harness, kind, keyId }) {
  const run = found?.run, identity = run?.executionIdentity
  check(uuid(run?.id) && run.botId === botId && run.issueId === issueId && runStatuses.has(run.status), 'run_scope', 'failed')
  check(MODELS.some(item => item.model === run.model) && run.model === model && run.harness === harness, 'run_model', 'failed')
  check(run.credentialType === kind && (kind === 'api_key' ? !run.subscriptionRoute
    : run.subscriptionRoute === (harness === 'codex' ? 'codex_cli' : 'claude_code_cli')), 'run_credential', 'failed')
  check(identity?.version === 1 && identity.requester === ownerId && identity.executionPrincipal === ownerId
    && identity.outputOwner === ownerId && identity.botId === botId && identity.botOwner === ownerId
    && identity.workspaceId === workspaceId && identity.personalResourcePolicy === 'requester_only', 'run_identity', 'failed')
  const payer = identity.billingAccount?.model, runtime = identity.billingAccount?.runtime
  const resource = identity.resourceBindings?.find(item => item.kind === kind && item.id === payer?.resourceId)
  check(payer?.kind === kind && payer.ownerId === ownerId && resource?.ownerId === ownerId && resource.access === 'owner'
    && (kind !== 'api_key' || payer.resourceId === keyId)
    && runtime?.kind === 'e2b' && runtime.ownerId === ownerId, 'run_identity', 'failed')
  return { runId: run.id, status: run.status, harness: run.harness, model: run.model, credentialType: run.credentialType,
    subscriptionRoute: run.subscriptionRoute ?? null, ownModelAccount: true, ownRuntimeAccount: true, workspaceMatched: true }
}

/** A passed Factory check alone does not prove which account/model did it. */
export async function verifyCheckRuns(checks, scope, read) {
  check(checks.length === 2 && new Set(checks.map(attempt => attempt.stage)).size === 2
    && new Set(checks.map(attempt => attempt.runId)).size === 2, 'checks_missing', 'failed')
  const result = []
  for (const attempt of checks) {
    check(['review', 'verify'].includes(attempt.stage) && uuid(attempt.runId), 'checks_missing', 'failed')
    const found = await read(attempt.runId)
    const proof = assertRunEvidence(found, scope)
    check(proof.runId === attempt.runId && proof.status === 'succeeded', 'checks_missing', 'failed')
    result.push({ stage: attempt.stage, ...proof, runStatus: proof.status, status: 'passed' })
  }
  return result
}

const providerCodes = '(payment_required|insufficient_balance|insufficient_quota|billing_hard_limit|billing_error|authentication_failed|invalid_api_key|rate_limit|overloaded|server_error|timeout|connection_error)'
const providerError = new RegExp(`^Model provider failed \\((balance|auth|unavailable)(?:: ${providerCodes})?(?:; HTTP ([1-5][0-9]{2}))?\\)$`)
export function providerReceipt(detail) {
  for (const entry of (detail?.chunks ?? []).toReversed()) {
    const chunk = entry?.chunk
    if (chunk?.type !== 'data-run-state' || chunk.data?.state !== 'failed') continue
    if (chunk.data.stopReason === 'quota_exhausted') return { kind: 'quota' }
    if (chunk.data.stopReason !== 'provider_failure') continue
    const match = typeof chunk.data.error === 'string' && providerError.exec(chunk.data.error)
    if (match) return { kind: match[1], ...(match[2] ? { code: match[2] } : {}), ...(match[3] ? { status: Number(match[3]) } : {}) }
  }
  return null
}

/** The workspace read counts every unfinished Bot run, including other owners
 * and old queued/paused runs; the capped mobile list is only an extra check. */
export async function assertWorkspaceIdle(read) {
  const state = await read('/api/settings/workspace-bots')
  check(Array.isArray(state?.bots) && state.bots.every(bot => bot && ['idle', 'running'].includes(bot.status)
    && Number.isSafeInteger(bot.runningThreads) && bot.runningThreads >= 0), 'response_invalid')
  check(state.bots.every(bot => bot.status === 'idle' && bot.runningThreads === 0), 'workspace_busy')
  const own = await read('/api/mobile/threads')
  check(Array.isArray(own?.threads) && own.threads.every(thread => thread
    && ['running', 'waiting', 'paused', 'failed', 'done', 'stopped'].includes(thread.status)), 'response_invalid')
  check(own.threads.every(thread => !['running', 'waiting', 'paused'].includes(thread.status)), 'workspace_busy')
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { APIError, betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { CodedError } from '@mikka/protocol/coded-error'
import { captureRunFailure } from '@mikka/protocol/run-failure'
import {
  MIKKA_ERROR_ACTION_KINDS,
  MIKKA_ERROR_CATEGORIES,
  MIKKA_ERROR_CODES,
  MIKKA_ERROR_HTTP_STATUSES,
  attachErrorContract,
  isMikkaErrorContract,
  normalizeLegacyRefusal,
  normalizeResetAt,
  toMikkaErrorContract,
  type MikkaErrorContract,
} from './error-contract'
import { verifyTurnstile } from '../abuse/signup'
import { createAuthEmail, type AuthMailContext } from '../auth-email'
import { verificationNavigationResponse } from '../auth-verification-response'
import { authRecoveryErrorContract } from '../auth-recovery'
import { HOSTED_STATES, hostedRefusalErrorContract, type HostedUsage } from '../billing/hosted-usage'
import { chatFailure, chatFailureErrorContract } from '../chat-failure'
import { CLOUD_ERROR_CODES, CloudServiceError } from '../cloud-services/errors'
import { GovernanceError } from '../governance/errors'
import { PaidResourceError } from '../abuse/policy'
import { signInRefusalErrorContract, signupRefusalErrorContract } from '../signup-refusal'
import { subscriptionRefusalErrorContract } from '../subscription-refusal'
import { WorkspaceError } from '../workspace-error'

function assertSingleCtaContract(contract: MikkaErrorContract, label: string) {
  assert.equal(isMikkaErrorContract(contract), true, `${label}: passes runtime guard`)
  assert.equal(
    (MIKKA_ERROR_CODES as readonly string[]).includes(contract.code),
    true,
    `${label}: canonical code`,
  )
  assert.equal(
    (MIKKA_ERROR_CATEGORIES as readonly string[]).includes(contract.category),
    true,
    `${label}: canonical category`,
  )
  assert.equal(
    (MIKKA_ERROR_HTTP_STATUSES as readonly number[]).includes(contract.httpStatus),
    true,
    `${label}: canonical httpStatus`,
  )
  assert.equal(typeof contract.retryable, 'boolean', `${label}: boolean retryable`)
  assert.equal(Array.isArray(contract.primaryAction), false, `${label}: primaryAction is never an array`)
  assert.equal(
    (MIKKA_ERROR_ACTION_KINDS as readonly string[]).includes(contract.primaryAction.kind),
    true,
    `${label}: canonical primaryAction.kind`,
  )
  assert.equal('actions' in contract, false, `${label}: forbids multi-action array`)
  assert.equal('secondaryActions' in contract, false, `${label}: forbids secondaryActions`)
}

test('every canonical MikkaErrorCode round-trips cleanly and satisfies the single-CTA invariant', () => {
  const seenCategories = new Set<string>()
  const seenStatuses = new Set<number>()
  for (const code of MIKKA_ERROR_CODES) {
    const fromLegacy = normalizeLegacyRefusal(code)
    assert.ok(fromLegacy, `normalizeLegacyRefusal(${code}) must recognize canonical code`)
    assert.equal(fromLegacy.code, code)
    assertSingleCtaContract(fromLegacy, `canonical:${code}`)

    const fromTotal = toMikkaErrorContract(code)
    assert.deepEqual(fromTotal, fromLegacy, `toMikkaErrorContract(${code}) matches normalizeLegacyRefusal`)

    const idempotent = toMikkaErrorContract(fromTotal)
    assert.deepEqual(idempotent, fromTotal, `idempotent round-trip for ${code}`)

    seenCategories.add(fromTotal.category)
    seenStatuses.add(fromTotal.httpStatus)
  }
  for (const category of MIKKA_ERROR_CATEGORIES) {
    assert.equal(seenCategories.has(category), true, `category ${category} is covered`)
  }
  assert.ok(seenStatuses.has(400) && seenStatuses.has(401) && seenStatuses.has(403) && seenStatuses.has(404))
  assert.ok(seenStatuses.has(409) && seenStatuses.has(413) && seenStatuses.has(429) && seenStatuses.has(500) && seenStatuses.has(503))
})

test('single-CTA invariant is enforced at both type and runtime boundaries', () => {
  // Compile-time checks: forbidden multi-CTA fields and malformed actions fail typechecking.
  const valid: MikkaErrorContract = {
    code: 'QUOTA_EXHAUSTED',
    category: 'quota',
    httpStatus: 429,
    retryable: false,
    resetAt: '2026-11-24T21:00:00.000Z',
    primaryAction: { kind: 'switch_model', target: '/settings?section=models' },
  }
  assert.equal(isMikkaErrorContract(valid), true)

  // @ts-expect-error actions array is forbidden by MikkaErrorContract
  const withActions: MikkaErrorContract = { ...valid, actions: [{ kind: 'retry' }] }
  // @ts-expect-error secondaryActions is forbidden by MikkaErrorContract
  const withSecondary: MikkaErrorContract = { ...valid, secondaryActions: [{ kind: 'open_billing' }] }
  // @ts-expect-error none action cannot carry a target
  const noneWithTarget: MikkaErrorContract = { code: 'MESSAGE_TOO_LONG', category: 'validation', httpStatus: 413, retryable: false, primaryAction: { kind: 'none', target: '/settings' } }

  assert.equal(isMikkaErrorContract(withActions), false)
  assert.equal(isMikkaErrorContract(withSecondary), false)
  assert.equal(isMikkaErrorContract(noneWithTarget), false)
  assert.equal(isMikkaErrorContract({ ...valid, primaryAction: [{ kind: 'retry' }] }), false)
  assert.equal(isMikkaErrorContract({ ...valid, category: 'internal' }), false)
  assert.equal(isMikkaErrorContract({ ...valid, httpStatus: 200 }), false)
  assert.equal(isMikkaErrorContract({ ...valid, primaryAction: { kind: 'open_billing', target: 'https://evil.example/phish' } }), false)
  assert.equal(isMikkaErrorContract({ ...valid, resetAt: 'not-an-iso-timestamp' }), false)
  assert.equal(isMikkaErrorContract({ ...valid, sourceCode: 'sk_live_secret_1234567890' }), false)
  assert.equal(isMikkaErrorContract({ ...valid, stack: 'Error: boom\n at /app/secret.ts:1' }), false)
})

test('preserves and normalizes resetAt from ISO strings, Dates, Codex epoch seconds, ms, and Retry-After', () => {
  const fixedNow = Date.parse('2026-11-24T20:00:00.000Z')

  assert.equal(
    normalizeResetAt('2026-11-24T21:30:00Z'),
    '2026-11-24T21:30:00.000Z',
  )
  assert.equal(
    normalizeResetAt('2026-11-24T17:30:00-04:00'),
    '2026-11-24T21:30:00.000Z',
  )
  assert.equal(
    normalizeResetAt(new Date('2026-11-24T21:30:00.000Z')),
    '2026-11-24T21:30:00.000Z',
  )
  // Codex RateLimitWindow epoch seconds
  assert.equal(
    normalizeResetAt(Math.floor(Date.parse('2026-11-24T21:30:00.000Z') / 1000)),
    '2026-11-24T21:30:00.000Z',
  )
  // Epoch milliseconds
  assert.equal(
    normalizeResetAt(Date.parse('2026-11-24T21:30:00.000Z')),
    '2026-11-24T21:30:00.000Z',
  )
  // Retry-After seconds (number & string)
  assert.equal(
    normalizeResetAt(null, { retryAfter: 120, now: fixedNow }),
    '2026-11-24T20:02:00.000Z',
  )
  assert.equal(
    normalizeResetAt(undefined, { retryAfter: '45', now: fixedNow }),
    '2026-11-24T20:00:45.000Z',
  )
  // IMF-fixdate
  assert.equal(
    normalizeResetAt(undefined, { retryAfter: 'Tue, 24 Nov 2026 21:30:00 GMT' }),
    '2026-11-24T21:30:00.000Z',
  )

  // Rejects arbitrary / secret strings
  for (const garbage of [
    'soon',
    'Bearer sk-proj-secret123',
    '2026-11-24',
    'invalid',
    -5,
    0,
    Infinity,
    NaN,
    '99999999999999999',
  ]) {
    assert.equal(normalizeResetAt(garbage, { retryAfter: garbage, now: fixedNow }), null, String(garbage))
  }

  // End-to-end preservation on RATE_LIMITED and QUOTA_EXHAUSTED
  const rateLimited = toMikkaErrorContract(
    { code: 'SIGNUP_RATE_LIMITED', resetAt: '2026-11-24T21:00:00Z' },
  )
  assert.equal(rateLimited.code, 'RATE_LIMITED')
  assert.equal(rateLimited.resetAt, '2026-11-24T21:00:00.000Z')
  assert.equal(rateLimited.retryable, true)
  assert.deepEqual(rateLimited.primaryAction, { kind: 'retry' })

  const quotaPaused = normalizeLegacyRefusal({
    reason: 'quota_exhausted',
    provider: 'claude',
    resetsAt: '2026-11-24T22:15:00.000Z',
    why: 'noApiKey',
  })
  assert.ok(quotaPaused)
  assert.equal(quotaPaused.code, 'QUOTA_EXHAUSTED')
  assert.equal(quotaPaused.resetAt, '2026-11-24T22:15:00.000Z')
  assertSingleCtaContract(quotaPaused, 'quotaPaused')
})

test('zero raw stack traces, secrets, PII, URLs, or hostile getter payloads leak into MikkaErrorContract', () => {
  const secrets = [
    'sk-proj-superSecretKeyValue1234567890',
    'sk_live_999999999999999999999',
    'ghp_SecretGitHubToken12345678901234',
    'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    'postgres://admin:superpass@10.0.0.5:5432/mikka',
    'victim@internal.example.com',
    '/Users/alexjiang/secret/path.ts',
    'at sensitiveHandler',
  ]

  const leakyError = new Error(
    `Failed calling ${secrets[4]} for ${secrets[5]} with ${secrets[0]} and ${secrets[3]}`,
  )
  leakyError.stack = `Error: boom\n    at sensitiveHandler (${secrets[6]}:42:9)\n    at ${secrets[2]}`

  const leakyInputs: unknown[] = [
    leakyError,
    { code: secrets[1], message: leakyError.message, stack: leakyError.stack, resetAt: secrets[0], workspaceId: secrets[2] },
    { code: 'RATE_LIMITED', resetAt: `2026-11-24 ${secrets[0]}`, message: secrets[3], stack: leakyError.stack },
    { code: 'QUOTA_EXHAUSTED', workspaceId: `../${secrets[2]}`, primaryAction: { kind: 'open_billing', target: `https://evil.example/?t=${secrets[0]}` } },
    `Error: ${secrets[0]} ${secrets[2]} ${secrets[6]}`,
    null,
    undefined,
    42,
    true,
    Symbol('secret'),
    ['array', secrets[0]],
  ]

  // Circular objects (self, body, error, cross-nested, cause) & throwing getters
  const circularSelf: Record<string, unknown> = { code: 'RATE_LIMITED' }
  circularSelf.self = circularSelf
  const circularBody: Record<string, unknown> = {}
  circularBody.body = circularBody
  const circularError: Record<string, unknown> = {}
  circularError.error = circularError
  const circularNested: Record<string, unknown> = {}
  circularNested.error = { body: circularNested }
  const circularCause = new Error('unknown') as Error & { cause?: unknown }
  circularCause.cause = circularCause
  const hostile: Record<string, unknown> = {}
  Object.defineProperty(hostile, 'code', {
    get() {
      throw new Error(`getter-boom ${secrets[0]}`)
    },
  })
  Object.defineProperty(hostile, 'message', {
    get() {
      throw new Error(`getter-msg ${secrets[2]}`)
    },
  })
  leakyInputs.push(circularSelf, circularBody, circularError, circularNested, circularCause, hostile)

  for (const [index, input] of leakyInputs.entries()) {
    const contract = toMikkaErrorContract(input)
    assertSingleCtaContract(contract, `leaky[${index}]`)
    const serialized = JSON.stringify(contract)
    for (const secret of secrets) {
      assert.equal(serialized.includes(secret), false, `leaky[${index}] must never leak ${secret}`)
    }
    assert.equal(serialized.includes('stack'), false, `leaky[${index}] must never contain stack`)
  }
})

test('maps every hosted refusal state to one accurate single-CTA contract by workspace context', () => {
  const wsId = '11111111-1111-4111-8111-111111111111'
  const personalUsage: HostedUsage = {
    state: 'points_exhausted',
    balance: { verified: false, free: 0, purchased: 0 },
    personal: true,
    subscribed: false,
    workspaceId: wsId,
  }
  const teamUsage: HostedUsage = {
    ...personalUsage,
    personal: false,
    subscribed: true,
  }

  for (const state of HOSTED_STATES) {
    if (state === 'ready') {
      assert.equal(normalizeLegacyRefusal(state), null)
      assert.equal(normalizeLegacyRefusal({ state: 'ready' }), null)
      continue
    }
    const personalContract = hostedRefusalErrorContract(state, personalUsage)
    const teamContract = hostedRefusalErrorContract(state, teamUsage)
    const unloadedContract = hostedRefusalErrorContract(state, null)
    assertSingleCtaContract(personalContract, `hosted:personal:${state}`)
    assertSingleCtaContract(teamContract, `hosted:team:${state}`)
    assertSingleCtaContract(unloadedContract, `hosted:null:${state}`)
    assert.equal(personalContract.sourceCode, state)

    // PaidResourceError instance maps identically
    const fromErr = normalizeLegacyRefusal(new PaidResourceError(state as never), {
      personal: true,
      workspaceId: wsId,
    })
    assert.deepEqual(fromErr, personalContract, `PaidResourceError(${state})`)
  }

  assert.deepEqual(hostedRefusalErrorContract('points_exhausted', personalUsage).primaryAction, {
    kind: 'add_credits',
    target: `/settings?section=billing&workspace=${wsId}`,
  })
  assert.deepEqual(hostedRefusalErrorContract('points_exhausted', teamUsage).primaryAction, {
    kind: 'open_billing',
    target: `/settings?section=billing&workspace=${wsId}`,
  })
  assert.deepEqual(hostedRefusalErrorContract('usage_budget_exhausted', personalUsage).primaryAction, {
    kind: 'open_billing',
    target: `/settings?section=billing&workspace=${wsId}`,
  })
  assert.deepEqual(hostedRefusalErrorContract('platform_paused', personalUsage).primaryAction, {
    kind: 'connect_subscription',
    target: `/settings?section=models&workspace=${wsId}`,
  })
  assert.deepEqual(hostedRefusalErrorContract('platform_paused', teamUsage).primaryAction, {
    kind: 'switch_model',
    target: `/settings?section=models&workspace=${wsId}`,
  })
  assert.equal(hostedRefusalErrorContract('usage_in_progress', personalUsage).code, 'RESOURCE_CONFLICT')
  assert.equal(hostedRefusalErrorContract('usage_in_progress', personalUsage).retryable, true)
  assert.equal(hostedRefusalErrorContract('usage_concurrency_limit', personalUsage).code, 'UPSTREAM_UNAVAILABLE')
  assert.equal(hostedRefusalErrorContract('billing_authorization_revoked', personalUsage).code, 'WORKSPACE_ACCESS_DENIED')
})

test('maps every subscription refusal code and wrapped step/hook envelope', () => {
  const cases: readonly [string, MikkaErrorContract['code'], MikkaErrorContract['primaryAction']['kind']][] = [
    ['quota_exhausted', 'QUOTA_EXHAUSTED', 'switch_model'],
    ['subscription_rate_limited', 'RATE_LIMITED', 'retry'],
    ['reconnect_required', 'SUBSCRIPTION_EXPIRED', 'connect_subscription'],
    ['disconnected', 'SUBSCRIPTION_EXPIRED', 'connect_subscription'],
    ['pending_auth', 'SUBSCRIPTION_EXPIRED', 'connect_subscription'],
    ['invalid_credential_bundle', 'SUBSCRIPTION_EXPIRED', 'connect_subscription'],
    ['binding_required', 'SUBSCRIPTION_REFUSED', 'switch_model'],
    ['binding_mismatch', 'SUBSCRIPTION_REFUSED', 'switch_model'],
    ['stale_binding', 'SUBSCRIPTION_REFUSED', 'switch_model'],
    ['account_unavailable', 'SUBSCRIPTION_REFUSED', 'connect_subscription'],
    ['billing_unverified', 'SUBSCRIPTION_REFUSED', 'connect_subscription'],
    ['provider_approval_required', 'SUBSCRIPTION_REFUSED', 'switch_model'],
    ['isolation_required', 'SUBSCRIPTION_REFUSED', 'switch_model'],
    ['provider_access_denied', 'SUBSCRIPTION_REFUSED', 'switch_model'],
    ['provider_route_unavailable', 'SUBSCRIPTION_REFUSED', 'switch_model'],
    ['provider_request_rejected', 'MODEL_UNAVAILABLE', 'switch_model'],
    ['subscription_model_not_reported', 'MODEL_UNAVAILABLE', 'switch_model'],
    ['subscription_model_unavailable', 'MODEL_UNAVAILABLE', 'switch_model'],
    ['executionModelUnknown', 'MODEL_UNAVAILABLE', 'switch_model'],
    ['quota_unknown', 'UPSTREAM_UNAVAILABLE', 'retry'],
    ['backend_unavailable', 'UPSTREAM_UNAVAILABLE', 'retry'],
    ['provider_temporarily_unavailable', 'UPSTREAM_UNAVAILABLE', 'retry'],
    ['subscription_timeout', 'UPSTREAM_UNAVAILABLE', 'retry'],
    ['provider_operation_failed', 'RUN_EXECUTION_FAILED', 'retry'],
    ['subscription_generation_failed', 'RUN_EXECUTION_FAILED', 'retry'],
  ]

  for (const [code, expectedCode, expectedAction] of cases) {
    const direct = subscriptionRefusalErrorContract(code)
    assert.ok(direct, code)
    assertSingleCtaContract(direct, `sub:${code}`)
    assert.equal(direct.code, expectedCode, code)
    assert.equal(direct.primaryAction.kind, expectedAction, code)

    const wrapped = subscriptionRefusalErrorContract(
      `Step "step//./workflows/coordinator/agent-kit-steps//botRuntime" failed after 3 retries: ${code}`,
    )
    assert.deepEqual(wrapped, direct, `wrapped:${code}`)
  }

  const hookWrapped = subscriptionRefusalErrorContract('Hook "turn.started" failed: subscription_model_unavailable')
  assert.equal(hookWrapped?.code, 'MODEL_UNAVAILABLE')
  assert.equal(subscriptionRefusalErrorContract('Client network socket disconnected before secure TLS connection was established'), null)
})

test('maps chatFailure, CloudServiceError, RunFailure, WorkspaceError, and anti-spoofing cases', () => {
  // ChatFailure variants
  const balanceError =
    'Step "step//@ai-sdk/workflow@2.0.80//doStreamStep" failed after 0 retries: Insufficient Balance (request_id: 11111111-1111-4111-8111-111111111111)'
  const balanceChat = chatFailure({ working: false, error: balanceError })!
  const balanceContract = chatFailureErrorContract(balanceChat)
  assertSingleCtaContract(balanceContract, 'chat:balance')
  assert.equal(balanceContract.code, 'CREDITS_EXHAUSTED')
  assert.equal(balanceContract.primaryAction.kind, 'switch_model')
  assert.deepEqual(normalizeLegacyRefusal(balanceError), balanceContract)

  // Anti-spoofing: tool outputs quoting refusal words must NOT become billing/cloud refusals
  for (const spoof of [
    'Tool output: Insufficient Balance',
    'Tool output: cloud_quota_exhausted',
    'Step "step//tools//doStreamStep" failed after 0 retries: Insufficient Balance',
    'Step "step//@ai-sdk/workflow@2.0.80//runToolStep" failed after 0 retries: cloud_quota_exhausted',
  ]) {
    assert.equal(normalizeLegacyRefusal(spoof), null, `must not spoof refusal: ${spoof}`)
  }

  const modelReq = chatFailureErrorContract(chatFailure({ working: false, error: 'executionModelUnknown' })!)
  assert.equal(modelReq.code, 'MODEL_UNAVAILABLE')
  assert.equal(modelReq.primaryAction.kind, 'switch_model')

  const wakeExhausted = chatFailureErrorContract(chatFailure({ working: false, error: 'wake_exhausted' })!)
  assert.equal(wakeExhausted.code, 'RUN_EXECUTION_FAILED')
  assert.equal(wakeExhausted.retryable, true)
  assert.equal(wakeExhausted.primaryAction.kind, 'retry')

  const toolsFailed = chatFailureErrorContract(chatFailure({ working: false, error: 'model_tool_unavailable' })!)
  assert.equal(toolsFailed.code, 'RUN_EXECUTION_FAILED')
  assert.equal(toolsFailed.primaryAction.kind, 'retry')

  // All CloudServiceError codes
  for (const cloudCode of CLOUD_ERROR_CODES) {
    const contract = toMikkaErrorContract(new CloudServiceError(cloudCode))
    assertSingleCtaContract(contract, `cloud:${cloudCode}`)
    if (cloudCode === 'cloud_quota_exhausted') {
      assert.equal(contract.code, 'CREDITS_EXHAUSTED')
      assert.equal(contract.primaryAction.kind, 'add_credits')
    }
    if (cloudCode === 'cloud_rate_limited') {
      assert.equal(contract.code, 'RATE_LIMITED')
      assert.equal(contract.primaryAction.kind, 'retry')
    }
  }

  // RunFailure structured records
  const runQuota = toMikkaErrorContract(captureRunFailure({ statusCode: 402, error: { code: 'insufficient_quota' } }))
  assert.equal(runQuota.code, 'QUOTA_EXHAUSTED')
  assertSingleCtaContract(runQuota, 'runFailure:quota')

  const runCtx = toMikkaErrorContract(captureRunFailure({ statusCode: 400, error: { code: 'context_length_exceeded' } }))
  assert.equal(runCtx.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(runCtx.httpStatus, 400)
  assertSingleCtaContract(runCtx, 'runFailure:context')

  // Governance & Workspace & Validation errors
  const seatLimit = toMikkaErrorContract(new GovernanceError('seat_limit'))
  assert.equal(seatLimit.code, 'QUOTA_EXHAUSTED')
  assert.equal(seatLimit.httpStatus, 403)
  assert.equal(seatLimit.primaryAction.kind, 'upgrade_plan')

  const wsDenied = toMikkaErrorContract(new WorkspaceError('workspaceAccessDenied'))
  assert.equal(wsDenied.code, 'WORKSPACE_ACCESS_DENIED')
  assert.equal(wsDenied.httpStatus, 403)
  assert.deepEqual(wsDenied.primaryAction, { kind: 'none' })

  const wsSuspended = toMikkaErrorContract(new WorkspaceError('workspaceMembershipSuspended'))
  assert.equal(wsSuspended.code, 'WORKSPACE_SUSPENDED')
  assert.equal(wsSuspended.httpStatus, 403)

  const tooLong = toMikkaErrorContract(new Error('messageTooLong'))
  assert.equal(tooLong.code, 'MESSAGE_TOO_LONG')
  assert.equal(tooLong.httpStatus, 413)
  assert.deepEqual(tooLong.primaryAction, { kind: 'none' })

  const credQuota = toMikkaErrorContract(new CodedError('run_credentials_unavailable', { detail: 'quota_exhausted' }))
  assert.equal(credQuota.code, 'QUOTA_EXHAUSTED')

  const credExpired = toMikkaErrorContract(new CodedError('run_credentials_unavailable', { detail: 'credential_expired' }))
  assert.equal(credExpired.code, 'SUBSCRIPTION_EXPIRED')
})

test('maps Codex protocol enums (CodexErrorInfo, TurnError, RateLimitSnapshot, ModelProviderError)', () => {
  const resetEpochSec = Math.floor(Date.parse('2026-11-24T23:00:00.000Z') / 1000)

  const usageLimit = toMikkaErrorContract({
    message: 'usage limit',
    codexErrorInfo: 'usageLimitExceeded',
    additionalDetails: null,
  })
  assert.equal(usageLimit.code, 'QUOTA_EXHAUSTED')
  assertSingleCtaContract(usageLimit, 'codex:usageLimitExceeded')

  const modelMissing = toMikkaErrorContract({
    message: 'not found',
    codexErrorInfo: 'modelNotFound',
  })
  assert.equal(modelMissing.code, 'MODEL_UNAVAILABLE')
  assert.equal(modelMissing.httpStatus, 404)
  assert.equal(modelMissing.primaryAction.kind, 'switch_model')

  const overloaded = toMikkaErrorContract({
    codexErrorInfo: 'serverOverloaded',
  })
  assert.equal(overloaded.code, 'UPSTREAM_UNAVAILABLE')
  assert.equal(overloaded.retryable, true)
  assert.equal(overloaded.primaryAction.kind, 'retry')

  const streamFailed = toMikkaErrorContract({
    codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
  })
  assert.equal(streamFailed.code, 'UPSTREAM_UNAVAILABLE')
  assert.equal(streamFailed.httpStatus, 502)

  // Explicit provider statuses on Codex connection errors are preserved, never flattened to 502
  const connAuth = toMikkaErrorContract({
    codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
  })
  assert.equal(connAuth.code, 'AUTH_REQUIRED')
  assert.equal(connAuth.httpStatus, 401)
  assert.equal(connAuth.retryable, false)
  assert.equal(connAuth.primaryAction.kind, 'sign_in')

  const connRate = toMikkaErrorContract({
    codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } },
    resetAt: '2026-11-24T23:00:00Z',
  })
  assert.equal(connRate.code, 'RATE_LIMITED')
  assert.equal(connRate.httpStatus, 429)
  assert.equal(connRate.retryable, true)
  assert.equal(connRate.resetAt, '2026-11-24T23:00:00.000Z')

  const connUnavailable = toMikkaErrorContract({
    codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 503 } },
  })
  assert.equal(connUnavailable.code, 'UPSTREAM_UNAVAILABLE')
  assert.equal(connUnavailable.httpStatus, 503)
  assert.equal(connUnavailable.retryable, true)

  const ownerDepleted = toMikkaErrorContract({
    rateLimitReachedType: 'workspace_owner_credits_depleted',
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetEpochSec },
  })
  assert.equal(ownerDepleted.code, 'CREDITS_EXHAUSTED')
  assert.equal(ownerDepleted.primaryAction.kind, 'open_billing')
  assert.equal(ownerDepleted.resetAt, '2026-11-24T23:00:00.000Z')

  const memberLimited = toMikkaErrorContract({
    rateLimitReachedType: 'workspace_member_usage_limit_reached',
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetEpochSec },
  })
  assert.equal(memberLimited.code, 'QUOTA_EXHAUSTED')
  assert.deepEqual(memberLimited.primaryAction, { kind: 'none' })
  assert.equal(memberLimited.resetAt, '2026-11-24T23:00:00.000Z')

  const providerNotConfigured = toMikkaErrorContract({
    type: 'modelProviderNotConfigured',
    modelProvider: 'anthropic',
  })
  assert.equal(providerNotConfigured.code, 'MODEL_UNAVAILABLE')
  assert.equal(providerNotConfigured.primaryAction.kind, 'switch_model')
})

test('signup, sign-in, auth-recovery, lib/abuse/signup.ts, and lib/auth-email.ts attach additive errorContract without breaking legacy fields', async () => {
  // 1. lib/abuse/signup.ts: verifyTurnstile throws APIError with legacy code/message + errorContract
  await assert.rejects(
    verifyTurnstile(undefined, { MIKKA_DEPLOYMENT_STAGE: 'production' }),
    (error: unknown) => {
      assert.ok(error instanceof APIError)
      assert.equal(error.statusCode, 503)
      assert.equal(error.body?.code, 'SIGNUP_VERIFICATION_UNAVAILABLE')
      assert.equal(error.body?.message, 'SIGNUP_VERIFICATION_UNAVAILABLE')
      assert.equal(isMikkaErrorContract(error.body?.errorContract), true)
      assert.equal(error.body?.errorContract.code, 'SIGNUP_VERIFICATION_UNAVAILABLE')
      assert.equal(error.body?.errorContract.httpStatus, 503)
      assert.equal(error.body?.errorContract.retryable, true)
      assert.deepEqual(error.body?.errorContract.primaryAction, { kind: 'retry' })
      assert.deepEqual(toMikkaErrorContract(error), error.body?.errorContract)
      return true
    },
  )

  await assert.rejects(
    verifyTurnstile(undefined, { TURNSTILE_SECRET_KEY: 'fixture' }),
    (error: unknown) => {
      assert.ok(error instanceof APIError)
      assert.equal(error.statusCode, 400)
      assert.equal(error.body?.code, 'TURNSTILE_REQUIRED')
      assert.equal(isMikkaErrorContract(error.body?.errorContract), true)
      assert.equal(error.body?.errorContract.code, 'SIGNUP_VERIFICATION_FAILED')
      return true
    },
  )

  // 2. lib/auth-email.ts: createAuthEmail attaches errorContract on 503 / 403 / 400 APIError
  const dummyContext: AuthMailContext = {
    secret: 'synthetic-test-secret',
    internalAdapter: {
      reserveVerificationValue: async () => true,
      consumeVerificationValue: async () => null,
      findVerificationValue: async () => null,
      findUserById: async () => null,
      updateUser: async () => null,
    },
  }
  const savedSmtp = process.env.SMTP_URL
  const savedResend = process.env.RESEND_API_KEY
  delete process.env.SMTP_URL
  delete process.env.RESEND_API_KEY
  try {
    const authEmail = createAuthEmail({
      origin: 'https://auth.example.test',
      apiKey: () => undefined,
      context: async () => dummyContext,
    })

    await assert.rejects(
      authEmail.before({
        path: '/send-verification-email',
        body: { email: 'user@example.test' },
        context: { ...dummyContext, adapter: {} as never },
      }),
      (error: unknown) => {
        assert.ok(error instanceof APIError)
        assert.equal(error.statusCode, 503)
        assert.equal(error.body?.code, 'AUTH_EMAIL_DELIVERY_UNAVAILABLE')
        assert.equal(isMikkaErrorContract(error.body?.errorContract), true)
        assert.equal(error.body?.errorContract.code, 'AUTH_EMAIL_DELIVERY_UNAVAILABLE')
        assert.equal(error.body?.errorContract.primaryAction.kind, 'retry')
        return true
      },
    )

    await assert.rejects(
      authEmail.before({
        path: '/request-password-reset',
        body: { email: 'user@example.test' },
        request: new Request('https://auth.example.test/mikka/api/auth/request-password-reset', {
          method: 'POST',
          headers: { origin: 'https://evil.example' },
        }),
        context: { ...dummyContext, adapter: {} as never },
      }),
      (error: unknown) => {
        assert.ok(error instanceof APIError)
        assert.equal(error.statusCode, 403)
        assert.equal(error.body?.code, 'INVALID_ORIGIN')
        assert.equal(isMikkaErrorContract(error.body?.errorContract), true)
        assert.equal(error.body?.errorContract.code, 'WORKSPACE_ACCESS_DENIED')
        return true
      },
    )

    // Expired/invalid password reset links point to /forgot-password rather than /sign-in
    await assert.rejects(
      authEmail.before({
        path: '/reset-password',
        body: { token: '' },
        context: { ...dummyContext, adapter: {} as never },
      }),
      (error: unknown) => {
        assert.ok(error instanceof APIError)
        assert.equal(error.statusCode, 400)
        assert.equal(error.body?.code, 'INVALID_TOKEN')
        assert.equal(isMikkaErrorContract(error.body?.errorContract), true)
        assert.equal(error.body?.errorContract.code, 'VALIDATION_ERROR')
        assert.deepEqual(error.body?.errorContract.primaryAction, {
          kind: 'retry',
          target: '/forgot-password',
        })
        return true
      },
    )

    // Real Better Auth HTTP handler serialization & verification redirect compatibility
    const auth = betterAuth({
      baseURL: 'https://auth.example.test',
      basePath: '/mikka/api/auth',
      secret: 'synthetic-http-error-contract-secret-0123456789',
      trustedOrigins: ['https://auth.example.test'],
      emailAndPassword: authEmail.emailAndPassword,
      emailVerification: authEmail.emailVerification,
      logger: { disabled: true },
      hooks: {
        before: createAuthMiddleware(async (ctx) => authEmail.before(ctx as never)),
      },
    })
    const unavailableRes = await auth.handler(
      new Request('https://auth.example.test/mikka/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://auth.example.test' },
        body: JSON.stringify({ email: 'user@example.test' }),
      }),
    )
    assert.equal(unavailableRes.status, 503)
    const unavailableJson = (await unavailableRes.json()) as { code?: string; errorContract?: unknown }
    assert.equal(unavailableJson.code, 'AUTH_EMAIL_DELIVERY_UNAVAILABLE')
    assert.equal(isMikkaErrorContract(unavailableJson.errorContract), true)
    assert.equal(toMikkaErrorContract(unavailableJson).code, 'AUTH_EMAIL_DELIVERY_UNAVAILABLE')

    const resetBadRes = await auth.handler(
      new Request('https://auth.example.test/mikka/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://auth.example.test' },
        body: JSON.stringify({ token: '', newPassword: 'synthetic-password-123' }),
      }),
    )
    assert.equal(resetBadRes.status, 400)
    const resetBadJson = (await resetBadRes.json()) as { code?: string; errorContract?: unknown }
    assert.equal(resetBadJson.code, 'INVALID_TOKEN')
    assert.equal(isMikkaErrorContract(resetBadJson.errorContract), true)
    assert.deepEqual(toMikkaErrorContract(resetBadJson).primaryAction, {
      kind: 'retry',
      target: '/forgot-password',
    })

    const verifyReq = new Request(
      'https://auth.example.test/mikka/api/auth/verify-email?token=bad&nonce=short&callbackURL=https%3A%2F%2Fauth.example.test%2Fmikka%2Fsign-in',
    )
    const verifyRawRes = await auth.handler(verifyReq)
    assert.equal(verifyRawRes.status, 400)
    const verifyNavRes = verificationNavigationResponse(verifyReq, verifyRawRes, 'https://auth.example.test')
    assert.equal(verifyNavRes.status, 302)
    assert.equal(verifyNavRes.headers.get('location'), 'https://auth.example.test/mikka/verify-email?error=INVALID_TOKEN')
    assert.equal(await verifyNavRes.text(), '')
  } finally {
    if (savedSmtp !== undefined) process.env.SMTP_URL = savedSmtp
    if (savedResend !== undefined) process.env.RESEND_API_KEY = savedResend
  }

  // 3. lib/signup-refusal.ts & lib/auth-recovery.ts additive helpers
  const signupUnavail = signupRefusalErrorContract(503, 'SIGNUP_VERIFICATION_UNAVAILABLE')
  assert.equal(signupUnavail?.code, 'SIGNUP_VERIFICATION_UNAVAILABLE')
  const signupRate = signupRefusalErrorContract(429, 'SIGNUP_RATE_LIMITED', '2026-11-24T21:00:00Z')
  assert.equal(signupRate?.code, 'RATE_LIMITED')
  assert.equal(signupRate?.resetAt, '2026-11-24T21:00:00.000Z')
  assert.equal(signupRefusalErrorContract(500, undefined), null)

  const signInCreds = signInRefusalErrorContract(401, 'INVALID_EMAIL_OR_PASSWORD')
  assert.equal(signInCreds?.code, 'AUTH_REQUIRED')
  assert.equal(signInCreds?.primaryAction.kind, 'sign_in')
  assert.equal(signInRefusalErrorContract(500, undefined), null)

  const fixedNow = Date.parse('2026-11-24T20:00:00.000Z')
  const recoveryRate = authRecoveryErrorContract(429, undefined, '30', fixedNow)
  assert.equal(recoveryRate.code, 'RATE_LIMITED')
  assert.equal(recoveryRate.resetAt, '2026-11-24T20:00:30.000Z')

  const recoveryEmail = authRecoveryErrorContract(503, 'AUTH_EMAIL_DELIVERY_UNAVAILABLE', null, fixedNow)
  assert.equal(recoveryEmail.code, 'AUTH_EMAIL_DELIVERY_UNAVAILABLE')

  // 4. attachErrorContract preserves existing fields immutably
  const original = { ok: false as const, error: 'messageTooLong' }
  const wrapped = attachErrorContract(original, toMikkaErrorContract(original))
  assert.equal('errorContract' in original, false)
  assert.equal(wrapped.error, 'messageTooLong')
  assert.equal(wrapped.errorContract.code, 'MESSAGE_TOO_LONG')
})

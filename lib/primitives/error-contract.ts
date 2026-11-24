/**
 * Canonical backend → frontend error & quota recovery contract.
 *
 * Aligns Mikka's error payloads with Codex / Claude Code's typed single-CTA
 * recovery standard: every error resolves to a closed machine code, category,
 * HTTP status, retryability flag, optional normalized ISO-8601 `resetAt`, and
 * strictly at most ONE typed `primaryAction` (never a multi-button wall).
 *
 * Security invariants:
 * - Zero raw stack traces, provider prose, URLs, emails, tokens, or unknown
 *   caller strings ever leak into any field of `MikkaErrorContract`.
 * - `primaryAction` is a single object (never an array); `actions` and
 *   `secondaryActions` are forbidden at both type and runtime boundaries.
 * - Pure TypeScript with zero runtime imports so Web, Desktop, iOS, Workers,
 *   and API routes share one authoritative primitive.
 */

export const MIKKA_ERROR_CODES = [
  'QUOTA_EXHAUSTED',
  'CREDITS_EXHAUSTED',
  'USAGE_BUDGET_EXHAUSTED',
  'RATE_LIMITED',
  'MODEL_UNAVAILABLE',
  'CONTEXT_WINDOW_EXCEEDED',
  'SUBSCRIPTION_EXPIRED',
  'SUBSCRIPTION_REFUSED',
  'AUTH_REQUIRED',
  'SIGNUP_VERIFICATION_UNAVAILABLE',
  'SIGNUP_VERIFICATION_FAILED',
  'AUTH_EMAIL_DELIVERY_UNAVAILABLE',
  'WORKSPACE_ACCESS_DENIED',
  'WORKSPACE_SUSPENDED',
  'RESOURCE_NOT_FOUND',
  'RESOURCE_CONFLICT',
  'MESSAGE_TOO_LONG',
  'VALIDATION_ERROR',
  'UPSTREAM_UNAVAILABLE',
  'RUN_EXECUTION_FAILED',
  'INTERNAL_ERROR',
] as const

export type MikkaErrorCode = (typeof MIKKA_ERROR_CODES)[number]

export const MIKKA_ERROR_CATEGORIES = [
  'quota',
  'rate_limit',
  'model',
  'auth',
  'permission',
  'validation',
  'upstream',
  'internal',
] as const

export type MikkaErrorCategory = (typeof MIKKA_ERROR_CATEGORIES)[number]

export const MIKKA_ERROR_HTTP_STATUSES = [
  400,
  401,
  403,
  404,
  409,
  413,
  429,
  500,
  502,
  503,
] as const

export type MikkaErrorHttpStatus = (typeof MIKKA_ERROR_HTTP_STATUSES)[number]

export const MIKKA_ERROR_ACTION_KINDS = [
  'none',
  'retry',
  'add_credits',
  'switch_model',
  'connect_subscription',
  'open_billing',
  'sign_in',
  'upgrade_plan',
] as const

export type MikkaErrorActionKind = (typeof MIKKA_ERROR_ACTION_KINDS)[number]

/** Strictly one typed recovery CTA (or `'none'` when no action is appropriate). */
export type MikkaErrorPrimaryAction<K extends MikkaErrorActionKind = MikkaErrorActionKind> =
  K extends 'none'
    ? { readonly kind: 'none'; readonly target?: undefined }
    : { readonly kind: K; readonly target?: string }

interface MikkaErrorContractBase {
  readonly code: MikkaErrorCode
  readonly category: MikkaErrorCategory
  readonly httpStatus: MikkaErrorHttpStatus
  readonly retryable: boolean
  readonly resetAt?: string | null
  readonly primaryAction: MikkaErrorPrimaryAction
  /**
   * Closed-set legacy/source machine code preserved for diagnostics or
   * localized copy routing. Never carries arbitrary strings, stack traces, or
   * provider prose.
   */
  readonly sourceCode?: string
  /** Forbidden by contract: Mikka errors expose strictly at most ONE CTA. */
  readonly actions?: never
  readonly secondaryActions?: never
}

export type MikkaErrorContract =
  | (MikkaErrorContractBase & {
      readonly code: 'QUOTA_EXHAUSTED'
      readonly category: 'quota'
      readonly httpStatus: 429 | 403
      readonly retryable: boolean
      readonly primaryAction: MikkaErrorPrimaryAction<
        'switch_model' | 'add_credits' | 'open_billing' | 'upgrade_plan' | 'connect_subscription' | 'none'
      >
    })
  | (MikkaErrorContractBase & {
      readonly code: 'CREDITS_EXHAUSTED'
      readonly category: 'quota'
      readonly httpStatus: 429 | 403
      readonly retryable: false
      readonly primaryAction: MikkaErrorPrimaryAction<
        'add_credits' | 'open_billing' | 'upgrade_plan' | 'switch_model' | 'connect_subscription'
      >
    })
  | (MikkaErrorContractBase & {
      readonly code: 'USAGE_BUDGET_EXHAUSTED'
      readonly category: 'quota'
      readonly httpStatus: 403 | 429
      readonly retryable: false
      readonly primaryAction: MikkaErrorPrimaryAction<'open_billing' | 'upgrade_plan' | 'none'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'RATE_LIMITED'
      readonly category: 'rate_limit'
      readonly httpStatus: 429
      readonly retryable: true
      readonly primaryAction: MikkaErrorPrimaryAction<'retry' | 'upgrade_plan' | 'switch_model'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'MODEL_UNAVAILABLE'
      readonly category: 'model'
      readonly httpStatus: 400 | 404 | 503
      readonly retryable: boolean
      readonly primaryAction: MikkaErrorPrimaryAction<'switch_model' | 'connect_subscription' | 'retry'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'CONTEXT_WINDOW_EXCEEDED'
      readonly category: 'model'
      readonly httpStatus: 413 | 400
      readonly retryable: false
      readonly primaryAction: MikkaErrorPrimaryAction<'switch_model' | 'none'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'SUBSCRIPTION_EXPIRED'
      readonly category: 'auth'
      readonly httpStatus: 401
      readonly retryable: false
      readonly primaryAction: MikkaErrorPrimaryAction<'connect_subscription'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'SUBSCRIPTION_REFUSED'
      readonly category: 'permission'
      readonly httpStatus: 403
      readonly retryable: false
      readonly primaryAction: MikkaErrorPrimaryAction<'switch_model' | 'connect_subscription' | 'none'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'AUTH_REQUIRED'
      readonly category: 'auth'
      readonly httpStatus: 401
      readonly retryable: false
      readonly primaryAction: MikkaErrorPrimaryAction<'sign_in'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'SIGNUP_VERIFICATION_UNAVAILABLE'
      readonly category: 'upstream'
      readonly httpStatus: 503
      readonly retryable: true
      readonly primaryAction: MikkaErrorPrimaryAction<'retry'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'SIGNUP_VERIFICATION_FAILED'
      readonly category: 'validation'
      readonly httpStatus: 400
      readonly retryable: true
      readonly primaryAction: MikkaErrorPrimaryAction<'retry'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'AUTH_EMAIL_DELIVERY_UNAVAILABLE'
      readonly category: 'upstream'
      readonly httpStatus: 503
      readonly retryable: true
      readonly primaryAction: MikkaErrorPrimaryAction<'retry'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'WORKSPACE_ACCESS_DENIED'
      readonly category: 'permission'
      readonly httpStatus: 403
      readonly retryable: false
      readonly primaryAction: MikkaErrorPrimaryAction<'none' | 'open_billing' | 'sign_in'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'WORKSPACE_SUSPENDED'
      readonly category: 'permission'
      readonly httpStatus: 403
      readonly retryable: false
      readonly primaryAction: MikkaErrorPrimaryAction<'none' | 'open_billing'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'RESOURCE_NOT_FOUND'
      readonly category: 'validation'
      readonly httpStatus: 404
      readonly retryable: false
      readonly primaryAction: MikkaErrorPrimaryAction<'none'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'RESOURCE_CONFLICT'
      readonly category: 'validation'
      readonly httpStatus: 409
      readonly retryable: boolean
      readonly primaryAction: MikkaErrorPrimaryAction<'none' | 'retry' | 'sign_in'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'MESSAGE_TOO_LONG'
      readonly category: 'validation'
      readonly httpStatus: 413
      readonly retryable: false
      readonly primaryAction: MikkaErrorPrimaryAction<'none'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'VALIDATION_ERROR'
      readonly category: 'validation'
      readonly httpStatus: 400
      readonly retryable: false
      readonly primaryAction: MikkaErrorPrimaryAction<'none' | 'sign_in' | 'retry'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'UPSTREAM_UNAVAILABLE'
      readonly category: 'upstream'
      readonly httpStatus: 502 | 503
      readonly retryable: boolean
      readonly primaryAction: MikkaErrorPrimaryAction<'retry' | 'connect_subscription' | 'switch_model'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'RUN_EXECUTION_FAILED'
      readonly category: 'internal'
      readonly httpStatus: 500
      readonly retryable: boolean
      readonly primaryAction: MikkaErrorPrimaryAction<'retry' | 'switch_model' | 'none'>
    })
  | (MikkaErrorContractBase & {
      readonly code: 'INTERNAL_ERROR'
      readonly category: 'internal'
      readonly httpStatus: 500
      readonly retryable: false
      readonly primaryAction: MikkaErrorPrimaryAction<'none' | 'retry'>
    })

export interface MikkaErrorContractOptions {
  /** Workspace context used to choose a single accurate billing/model CTA. */
  personal?: boolean
  admin?: boolean
  subscribed?: boolean
  upgradeAvailable?: boolean
  workspaceId?: string | null
  /** Explicit reset timestamp (ISO string, Date, or epoch seconds/ms). */
  resetAt?: string | number | Date | null
  /** Explicit Retry-After value (seconds or HTTP-date) when `resetAt` is absent. */
  retryAfter?: string | number | null
  /** Explicit HTTP status hint when classifying generic/status-only errors. */
  status?: number
  /** Clock override for deterministic tests when converting `retryAfter` seconds. */
  now?: number
}

export interface MikkaErrorEnvelope {
  readonly errorContract: MikkaErrorContract
}

const CODE_SET = new Set<string>(MIKKA_ERROR_CODES)
const CATEGORY_SET = new Set<string>(MIKKA_ERROR_CATEGORIES)
const HTTP_STATUS_SET = new Set<number>(MIKKA_ERROR_HTTP_STATUSES)
const ACTION_KIND_SET = new Set<string>(MIKKA_ERROR_ACTION_KINDS)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const SAFE_RELATIVE_TARGET_RE = /^\/[a-z0-9/_-]{0,120}(?:\?[a-z0-9_=&-]{1,160})?$/i
const SAFE_SOURCE_CODE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/

interface CodeConstraint {
  readonly category: MikkaErrorCategory
  readonly statuses: readonly MikkaErrorHttpStatus[]
  readonly actions: readonly MikkaErrorActionKind[]
  readonly retryable?: boolean
}

const CODE_CONSTRAINTS: Record<MikkaErrorCode, CodeConstraint> = {
  QUOTA_EXHAUSTED: {
    category: 'quota',
    statuses: [429, 403],
    actions: ['switch_model', 'add_credits', 'open_billing', 'upgrade_plan', 'connect_subscription', 'none'],
  },
  CREDITS_EXHAUSTED: {
    category: 'quota',
    statuses: [429, 403],
    actions: ['add_credits', 'open_billing', 'upgrade_plan', 'switch_model', 'connect_subscription'],
    retryable: false,
  },
  USAGE_BUDGET_EXHAUSTED: {
    category: 'quota',
    statuses: [403, 429],
    actions: ['open_billing', 'upgrade_plan', 'none'],
    retryable: false,
  },
  RATE_LIMITED: {
    category: 'rate_limit',
    statuses: [429],
    actions: ['retry', 'upgrade_plan', 'switch_model'],
    retryable: true,
  },
  MODEL_UNAVAILABLE: {
    category: 'model',
    statuses: [400, 404, 503],
    actions: ['switch_model', 'connect_subscription', 'retry'],
  },
  CONTEXT_WINDOW_EXCEEDED: {
    category: 'model',
    statuses: [413, 400],
    actions: ['switch_model', 'none'],
    retryable: false,
  },
  SUBSCRIPTION_EXPIRED: {
    category: 'auth',
    statuses: [401],
    actions: ['connect_subscription'],
    retryable: false,
  },
  SUBSCRIPTION_REFUSED: {
    category: 'permission',
    statuses: [403],
    actions: ['switch_model', 'connect_subscription', 'none'],
    retryable: false,
  },
  AUTH_REQUIRED: {
    category: 'auth',
    statuses: [401],
    actions: ['sign_in'],
    retryable: false,
  },
  SIGNUP_VERIFICATION_UNAVAILABLE: {
    category: 'upstream',
    statuses: [503],
    actions: ['retry'],
    retryable: true,
  },
  SIGNUP_VERIFICATION_FAILED: {
    category: 'validation',
    statuses: [400],
    actions: ['retry'],
    retryable: true,
  },
  AUTH_EMAIL_DELIVERY_UNAVAILABLE: {
    category: 'upstream',
    statuses: [503],
    actions: ['retry'],
    retryable: true,
  },
  WORKSPACE_ACCESS_DENIED: {
    category: 'permission',
    statuses: [403],
    actions: ['none', 'open_billing', 'sign_in'],
    retryable: false,
  },
  WORKSPACE_SUSPENDED: {
    category: 'permission',
    statuses: [403],
    actions: ['none', 'open_billing'],
    retryable: false,
  },
  RESOURCE_NOT_FOUND: {
    category: 'validation',
    statuses: [404],
    actions: ['none'],
    retryable: false,
  },
  RESOURCE_CONFLICT: {
    category: 'validation',
    statuses: [409],
    actions: ['none', 'retry', 'sign_in'],
  },
  MESSAGE_TOO_LONG: {
    category: 'validation',
    statuses: [413],
    actions: ['none'],
    retryable: false,
  },
  VALIDATION_ERROR: {
    category: 'validation',
    statuses: [400],
    actions: ['none', 'sign_in', 'retry'],
    retryable: false,
  },
  UPSTREAM_UNAVAILABLE: {
    category: 'upstream',
    statuses: [502, 503],
    actions: ['retry', 'connect_subscription', 'switch_model'],
  },
  RUN_EXECUTION_FAILED: {
    category: 'internal',
    statuses: [500],
    actions: ['retry', 'switch_model', 'none'],
  },
  INTERNAL_ERROR: {
    category: 'internal',
    statuses: [500],
    actions: ['none', 'retry'],
    retryable: false,
  },
}

const ALLOWED_CONTRACT_KEYS = new Set([
  'code',
  'category',
  'httpStatus',
  'retryable',
  'resetAt',
  'primaryAction',
  'sourceCode',
])

/** Read an own data property without invoking getters or proxies. */
function own(value: unknown, key: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function safeString(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function safeTarget(target: unknown): string | undefined {
  if (typeof target !== 'string') return undefined
  return SAFE_RELATIVE_TARGET_RE.test(target) ? target : undefined
}

function settingsTarget(section: 'billing' | 'models', workspaceId?: string | null): string {
  const workspace =
    typeof workspaceId === 'string' && UUID_RE.test(workspaceId) ? workspaceId.toLowerCase() : null
  return `/settings?section=${section}${workspace ? `&workspace=${workspace}` : ''}`
}

/**
 * Normalize a timestamp or Retry-After hint into a strict ISO-8601 UTC string.
 * Rejects arbitrary/untrusted strings so secrets or prose can never pass through.
 */
export function normalizeResetAt(
  value: unknown,
  options: { retryAfter?: unknown; now?: number } = {},
): string | null {
  const fromAbsolute = parseAbsoluteResetAt(value)
  if (fromAbsolute) return fromAbsolute
  const fromRetryAfter = parseRetryAfter(options.retryAfter, options.now)
  if (fromRetryAfter) return fromRetryAfter
  return null
}

function parseAbsoluteResetAt(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Codex RateLimitWindow uses Unix epoch seconds; JS timestamps use milliseconds.
    if (value >= 1_000_000_000 && value < 1_000_000_000_000) {
      return new Date(Math.trunc(value * 1000)).toISOString()
    }
    if (value >= 1_000_000_000_000 && value < 100_000_000_000_000) {
      return new Date(Math.trunc(value)).toISOString()
    }
    return null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length > 64 || !ISO_DATETIME_RE.test(trimmed)) return null
    const ms = Date.parse(trimmed)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
  }
  return null
}

function parseRetryAfter(value: unknown, now = Date.now()): string | null {
  if (value === null || value === undefined) return null
  const base = Number.isFinite(now) ? now : Date.now()
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || value > 365 * 86_400) return null
    return new Date(base + Math.round(value * 1000)).toISOString()
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > 64) return null
    if (/^\d{1,8}$/.test(trimmed)) {
      const seconds = Number.parseInt(trimmed, 10)
      if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 365 * 86_400) return null
      return new Date(base + seconds * 1000).toISOString()
    }
    if (ISO_DATETIME_RE.test(trimmed)) {
      const ms = Date.parse(trimmed)
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null
    }
    // RFC 9110 IMF-fixdate (e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
    if (/^[A-Za-z]{3},\s+\d{2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT$/.test(trimmed)) {
      const ms = Date.parse(trimmed)
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null
    }
  }
  return null
}

function makeAction<K extends MikkaErrorActionKind>(
  kind: K,
  target?: string,
): MikkaErrorPrimaryAction<K> {
  if (kind === 'none') return { kind: 'none' } as MikkaErrorPrimaryAction<K>
  const validated = safeTarget(target)
  return (validated ? { kind, target: validated } : { kind }) as MikkaErrorPrimaryAction<K>
}

function withOptionalFields(
  contract: MikkaErrorContract,
  resetAt: string | null,
  sourceCode?: string,
): MikkaErrorContract {
  const safeSource =
    sourceCode && KNOWN_SAFE_SOURCE_CODES.has(sourceCode) ? sourceCode : undefined
  return {
    ...contract,
    ...(resetAt !== null ? { resetAt } : {}),
    ...(safeSource ? { sourceCode: safeSource } : {}),
  } as MikkaErrorContract
}

/**
 * Runtime contract guard: verifies closed enum values, exact category match,
 * strictly single `primaryAction`, valid ISO `resetAt` if present, and zero
 * extra/leaked properties.
 */
export function isMikkaErrorContract(value: unknown): value is MikkaErrorContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  let keys: (string | symbol)[]
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    return false
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_CONTRACT_KEYS.has(key)) return false
  }
  const code = own(value, 'code')
  const category = own(value, 'category')
  const httpStatus = own(value, 'httpStatus')
  const retryable = own(value, 'retryable')
  const resetAt = own(value, 'resetAt')
  const primaryAction = own(value, 'primaryAction')
  const sourceCode = own(value, 'sourceCode')

  if (typeof code !== 'string' || !CODE_SET.has(code)) return false
  const constraint = CODE_CONSTRAINTS[code as MikkaErrorCode]
  if (typeof category !== 'string' || !CATEGORY_SET.has(category)) return false
  if (constraint.category !== category) return false
  if (typeof httpStatus !== 'number' || !HTTP_STATUS_SET.has(httpStatus)) return false
  if (!constraint.statuses.includes(httpStatus as MikkaErrorHttpStatus)) return false
  if (typeof retryable !== 'boolean') return false
  if (constraint.retryable !== undefined && retryable !== constraint.retryable) return false
  if (resetAt !== undefined && resetAt !== null) {
    if (typeof resetAt !== 'string' || !ISO_DATETIME_RE.test(resetAt) || !Number.isFinite(Date.parse(resetAt))) {
      return false
    }
  }
  if (sourceCode !== undefined) {
    if (typeof sourceCode !== 'string' || !SAFE_SOURCE_CODE_RE.test(sourceCode)) return false
    if (!KNOWN_SAFE_SOURCE_CODES.has(sourceCode)) return false
  }
  if (!primaryAction || typeof primaryAction !== 'object' || Array.isArray(primaryAction)) return false
  let actionKeys: (string | symbol)[]
  try {
    actionKeys = Reflect.ownKeys(primaryAction)
  } catch {
    return false
  }
  for (const key of actionKeys) {
    if (key !== 'kind' && key !== 'target') return false
  }
  const kind = own(primaryAction, 'kind')
  const target = own(primaryAction, 'target')
  if (typeof kind !== 'string' || !ACTION_KIND_SET.has(kind)) return false
  if (!constraint.actions.includes(kind as MikkaErrorActionKind)) return false
  if (kind === 'none' && target !== undefined) return false
  if (target !== undefined && (typeof target !== 'string' || !SAFE_RELATIVE_TARGET_RE.test(target))) return false
  return true
}

/** Additively attach `errorContract` metadata to an existing payload without mutating it. */
export function attachErrorContract<T extends Record<string, unknown>>(
  payload: T,
  contract: MikkaErrorContract,
): T & MikkaErrorEnvelope {
  return { ...payload, errorContract: contract }
}

// ---------------------------------------------------------------------------
// Closed allowlist of recognized legacy / protocol / canonical source codes.
// Only codes from this closed set can ever be echoed in `sourceCode`.
// ---------------------------------------------------------------------------

const HOSTED_REFUSAL_CODES = [
  'verification_required',
  'free_allowance_used',
  'points_exhausted',
  'platform_paused',
  'usage_in_progress',
  'usage_concurrency_limit',
  'usage_cost_unavailable',
  'usage_budget_exhausted',
  'billing_authorization_revoked',
  'billing_scope_missing',
  'billing_owner_missing',
] as const

const SUBSCRIPTION_REFUSAL_CODES = [
  'binding_required',
  'account_unavailable',
  'binding_mismatch',
  'stale_binding',
  'disconnected',
  'provider_approval_required',
  'isolation_required',
  'billing_unverified',
  'pending_auth',
  'reconnect_required',
  'quota_exhausted',
  'quota_unknown',
  'backend_unavailable',
  'subscription_rate_limited',
  'provider_access_denied',
  'provider_request_rejected',
  'provider_temporarily_unavailable',
  'provider_route_unavailable',
  'invalid_credential_bundle',
  'subscription_timeout',
  'provider_operation_failed',
  'subscription_generation_failed',
  'subscription_model_not_reported',
  'subscription_model_unavailable',
  'executionModelUnknown',
] as const

const SUBSCRIPTION_NOTICE_CODES = [
  'selectionChanged',
  'unavailable',
  'reconnect',
  'runtimeUnavailable',
  'quotaUsed',
  'quotaChecking',
  'retry',
  'rateLimited',
  'accessDenied',
  'modelRejected',
  'modelNotReported',
  'modelRequired',
] as const

const SIGNUP_AUTH_CODES = [
  'DISPOSABLE_EMAIL',
  'SIGNUP_RATE_LIMITED',
  'TURNSTILE_INVALID',
  'TURNSTILE_REQUIRED',
  'SIGNUP_VERIFICATION_UNAVAILABLE',
  'EMAIL_ALREADY_REGISTERED',
  'USER_ALREADY_EXISTS',
  'EMAIL_NOT_VERIFIED',
  'INVALID_EMAIL_OR_PASSWORD',
  'USER_EMAIL_NOT_FOUND',
  'INVALID_PASSWORD',
  'CREDENTIAL_ACCOUNT_NOT_FOUND',
  'AUTH_EMAIL_DELIVERY_UNAVAILABLE',
  'INVALID_TOKEN',
  'INVALID_ORIGIN',
  'PASSWORD_TOO_SHORT',
  'PASSWORD_TOO_LONG',
  'SESSION_NOT_FRESH',
  'disposableEmail',
  'signupRateLimited',
  'turnstileFailed',
  'turnstileUnavailable',
  'emailRegistered',
  'invalidCredentials',
  'emailNotVerified',
  'signInRateLimited',
  'invalid_token',
  'password_length',
  'rate_limited',
  'turnstile_failed',
  'turnstile_unavailable',
  'invalid_request',
  'authRequired',
  'emailUnavailable',
  'emailDeliveryFailed',
  'mail_delivery_unavailable',
  'passwordTooShort',
  'passwordTooLong',
  'passwordIncorrect',
] as const

const CLOUD_AND_WAKE_CODES = [
  'cloud_not_connected',
  'cloud_scope_missing',
  'cloud_server_revoked',
  'cloud_invalid_request',
  'cloud_rate_limited',
  'cloud_access_denied',
  'cloud_unavailable',
  'cloud_quota_exhausted',
  'cloud_machine_unfunded',
  'wake_failed',
  'wake_start_unconfirmed',
  'wake_exhausted',
  'model_tool_unavailable',
] as const

const WORKSPACE_ACTION_AND_RUN_CODES = [
  'workspaceAccessDenied',
  'workspaceMembershipSuspended',
  'workspaceNotFound',
  'governance_denied',
  'messageTooLong',
  'messageRequired',
  'personalInstructionsTooLong',
  'deviceNameTooLong',
  'botNameTooLong',
  'avatarTooLarge',
  'validationGeneric',
  'usageLimitReached',
  'usageCreditsExhausted',
  'threadModelUnavailable',
  'runModelMissing',
  'executionAccountUnavailable',
  'executionHarnessUnavailable',
  'apiKeyNotFound',
  'dataExportRateLimited',
  'runAlreadyActive',
  'runNotFound',
  'runNotActive',
  'runInvalid',
  'issueNotFound',
  'issueStale',
  'botNotFound',
  'agentNotFound',
  'deviceNotFound',
  'projectNotFound',
  'projectStale',
  'teamNotFound',
  'threadWorking',
  'submissionConflict',
  'scheduleVersionConflict',
  'coordinatorUnavailable',
  'memberOwnerOnly',
  'scheduleAdminRequired',
  'scheduleWorkspaceAccessDenied',
  'teamIssueAccessDenied',
  'modelRouteDenied',
  'modelPolicyRevoked',
  'modelRegionUnverified',
  'modelPrincipalUnavailable',
  'modelPolicyChanged',
  'modelPolicyInvalid',
  'modelTransportActive',
  'model_gateway_token_invalid',
  'model_gateway_protocol_mismatch',
  'model_gateway_body_too_large',
  'model_gateway_body_invalid',
  'run_subscription_expired',
  'run_api_key_invalid',
  'run_quota_exceeded',
  'run_rate_limited',
  'run_invalid_request',
  'run_access_denied',
  'run_model_unavailable',
  'run_context_length_exceeded',
  'run_timeout',
  'run_network_error',
  'run_provider_error',
  'run_mcp_unavailable',
  'run_failed',
  'run_credentials_unavailable',
  'subscription_local_runtime_unavailable',
  'subscription_hosted_runtime_unavailable',
  'desktop_session_expired',
  'desktop_session_changed',
  'web_connection_session_expired',
  'web_connection_sign_in_required',
  'web_auth_session_expired',
  'web_auth_forbidden',
  'review_auth_required',
  'review_not_found',
  'map_auth_required',
  'map_not_found',
  'map_too_large',
  'map_source_too_large',
  'terminal_input_too_large',
  'interop_not_found',
  'interop_invalid_request',
  'interop_scope_required',
  'interop_drive_unavailable',
  'workspace_not_found',
] as const

const CODEX_AND_PROVIDER_CODES = [
  'contextWindowExceeded',
  'sessionBudgetExceeded',
  'usageLimitExceeded',
  'rateLimitExceeded',
  'flexUnavailable',
  'serverOverloaded',
  'modelNotFound',
  'policyCapacityUnavailable',
  'inferenceHookDenied',
  'cyberPolicy',
  'bioPolicy',
  'misalignmentPolicyViolation',
  'tooManyDenials',
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
  'internalServerError',
  'unauthorized',
  'badRequest',
  'threadRollbackFailed',
  'sandboxError',
  'activeTurnNotSteerable',
  'modelProviderMismatch',
  'modelProviderNotConfigured',
  'modelProviderPolicyConflict',
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
  'insufficient_quota',
  'quota_exceeded',
  'usage_limit_reached',
  'usage_limit_exceeded',
  'credit_balance_too_low',
  'insufficient_balance',
  'billing_hard_limit',
  'billing_hard_limit_reached',
  'billing_not_active',
  'billing_error',
  'payment_required',
  'resource_exhausted',
  'rate_limit',
  'rate_limit_error',
  'rate_limit_exceeded',
  'too_many_requests',
  'overloaded',
  'overloaded_error',
  'server_error',
  'internal_server_error',
  'api_error',
  'provider_error',
  'model_not_found',
  'model_not_available',
  'model_unavailable',
  'model_deprecated',
  'model_retired',
  'not_found',
  'not_found_error',
  'context_length_exceeded',
  'context_window_exceeded',
  'max_tokens_exceeded',
  'prompt_too_long',
  'request_too_large',
  'authentication_error',
  'authentication_failed',
  'invalid_api_key',
  'invalid_authentication',
  'permission_error',
  'permission_denied',
  'access_denied',
  'forbidden',
  'invalid_request_error',
  'bad_request',
  'timeout',
  'timeout_error',
  'request_timeout',
  'connection_error',
  'network_error',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'ABORT_ERR',
] as const

const KNOWN_SAFE_SOURCE_CODES = new Set<string>([
  ...MIKKA_ERROR_CODES,
  ...HOSTED_REFUSAL_CODES,
  ...SUBSCRIPTION_REFUSAL_CODES,
  ...SUBSCRIPTION_NOTICE_CODES,
  ...SIGNUP_AUTH_CODES,
  ...CLOUD_AND_WAKE_CODES,
  ...WORKSPACE_ACTION_AND_RUN_CODES,
  ...CODEX_AND_PROVIDER_CODES,
])

// ---------------------------------------------------------------------------
// Strict string-envelope parsing (mirrors lib/chat-failure.ts & lib/chat-balance.ts
// so tool outputs and arbitrary prose can never spoof a billing/cloud refusal).
// ---------------------------------------------------------------------------

const REF_SUFFIX_RE = /\s*·\s*ref\s+[A-Za-z0-9_-]{1,128}$/
const KNOWN_ERROR_PREFIX_RE =
  /^(?:Error|PaidResourceError|SubscriptionRefusal|CodedError|WorkspaceError|ActionFailureError|CloudServiceError|GovernanceError|ModelAdmissionError|RunFailureError|APIError):\s*/
const AI_SDK_STREAM_STEP_RE =
  /^Step "step\/\/@ai-sdk\/workflow@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?\/\/doStreamStep" failed after \d+ retries:\s*/i
const COORDINATOR_STEP_RE =
  /^Step "step\/\/\.\/workflows\/coordinator\/[A-Za-z0-9_./-]+" failed after \d+ retries:\s*/
const HOOK_FAILED_RE = /^Hook "[a-z][a-z0-9_.-]*" failed:\s*/
const BALANCE_REFUSAL_RE =
  /^Insufficient Balance(?: \(request_id:\s*[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\))?$/i
const CODE_WITH_DETAIL_RE = /^([A-Za-z][A-Za-z0-9_.:-]{0,63})(?: \(([a-z][a-z0-9_]{0,63})\))?$/

interface ParsedStringCode {
  code: string
  detail?: string
  isApiBalance?: boolean
}

function parseRefusalString(raw: string): ParsedStringCode | null {
  const firstLine = raw.split('\n').find((part) => part.trim())?.trim()
  if (!firstLine || firstLine.length > 512) return null
  const withoutRef = firstLine.replace(REF_SUFFIX_RE, '').trim()
  // Check exact AI SDK stream step balance refusal first (never loose substring match).
  const afterStreamStep = withoutRef.replace(AI_SDK_STREAM_STEP_RE, '').trim()
  if (BALANCE_REFUSAL_RE.test(afterStreamStep)) {
    return { code: 'insufficient_balance', isApiBalance: true }
  }
  const stripped = afterStreamStep
    .replace(COORDINATOR_STEP_RE, '')
    .replace(HOOK_FAILED_RE, '')
    .replace(KNOWN_ERROR_PREFIX_RE, '')
    .trim()
  const match = CODE_WITH_DETAIL_RE.exec(stripped)
  if (!match) return null
  const candidate = match[1]
  if (!KNOWN_SAFE_SOURCE_CODES.has(candidate)) return null
  return { code: candidate, ...(match[2] ? { detail: match[2] } : {}) }
}

// ---------------------------------------------------------------------------
// Context extraction & canonical code classification
// ---------------------------------------------------------------------------

interface ResolvedContext {
  personal?: boolean
  admin?: boolean
  subscribed?: boolean
  upgradeAvailable?: boolean
  workspaceId?: string | null
  resetAt: string | null
  status?: number
}

function resolveContext(input: unknown, options: MikkaErrorContractOptions = {}): ResolvedContext {
  const personal = options.personal ?? safeBoolean(own(input, 'personal'))
  const admin = options.admin ?? safeBoolean(own(input, 'admin'))
  const subscribed = options.subscribed ?? safeBoolean(own(input, 'subscribed'))
  const upgradeAvailable = options.upgradeAvailable ?? safeBoolean(own(input, 'upgradeAvailable'))
  const workspaceId =
    options.workspaceId ?? safeString(own(input, 'workspaceId'), 64) ?? null

  const primaryWindow = own(input, 'primary')
  const secondaryWindow = own(input, 'secondary')
  const paused = own(input, 'paused')
  const rawReset =
    options.resetAt ??
    own(input, 'resetAt') ??
    own(input, 'resetsAt') ??
    own(input, 'quotaResetsAt') ??
    own(paused, 'resetsAt') ??
    own(primaryWindow, 'resetsAt') ??
    own(secondaryWindow, 'resetsAt')

  const rawRetryAfter =
    options.retryAfter ??
    own(input, 'retryAfter') ??
    own(input, 'retryAfterSeconds')

  const resetAt = normalizeResetAt(rawReset, {
    retryAfter: rawRetryAfter,
    now: options.now,
  })

  const status =
    options.status ??
    safeNumber(own(input, 'httpStatus')) ??
    safeNumber(own(input, 'statusCode')) ??
    safeNumber(own(input, 'status'))

  return { personal, admin, subscribed, upgradeAvailable, workspaceId, resetAt, status }
}

function classifyCanonicalCode(
  code: MikkaErrorCode,
  ctx: ResolvedContext,
  sourceCode?: string,
): MikkaErrorContract {
  const billing = settingsTarget('billing', ctx.workspaceId)
  const models = settingsTarget('models', ctx.workspaceId)
  switch (code) {
    case 'QUOTA_EXHAUSTED': {
      const action = ctx.upgradeAvailable
        ? makeAction('upgrade_plan', billing)
        : ctx.personal === false
          ? makeAction('open_billing', billing)
          : makeAction('switch_model', models)
      return withOptionalFields(
        {
          code: 'QUOTA_EXHAUSTED',
          category: 'quota',
          httpStatus: ctx.status === 403 ? 403 : 429,
          retryable: false,
          primaryAction: action,
        },
        ctx.resetAt,
        sourceCode,
      )
    }
    case 'CREDITS_EXHAUSTED': {
      const action =
        ctx.personal === false
          ? makeAction('open_billing', billing)
          : makeAction('add_credits', billing)
      return withOptionalFields(
        {
          code: 'CREDITS_EXHAUSTED',
          category: 'quota',
          httpStatus: ctx.status === 403 ? 403 : 429,
          retryable: false,
          primaryAction: action,
        },
        ctx.resetAt,
        sourceCode,
      )
    }
    case 'USAGE_BUDGET_EXHAUSTED':
      return withOptionalFields(
        {
          code: 'USAGE_BUDGET_EXHAUSTED',
          category: 'quota',
          httpStatus: ctx.status === 429 ? 429 : 403,
          retryable: false,
          primaryAction: makeAction('open_billing', billing),
        },
        ctx.resetAt,
        sourceCode,
      )
    case 'RATE_LIMITED':
      return withOptionalFields(
        {
          code: 'RATE_LIMITED',
          category: 'rate_limit',
          httpStatus: 429,
          retryable: true,
          primaryAction: ctx.upgradeAvailable ? makeAction('upgrade_plan', billing) : makeAction('retry'),
        },
        ctx.resetAt,
        sourceCode,
      )
    case 'MODEL_UNAVAILABLE': {
      const httpStatus: 400 | 404 | 503 =
        ctx.status === 404 ? 404 : ctx.status === 400 ? 400 : 503
      return withOptionalFields(
        {
          code: 'MODEL_UNAVAILABLE',
          category: 'model',
          httpStatus,
          retryable: false,
          primaryAction: makeAction('switch_model', models),
        },
        null,
        sourceCode,
      )
    }
    case 'CONTEXT_WINDOW_EXCEEDED':
      return withOptionalFields(
        {
          code: 'CONTEXT_WINDOW_EXCEEDED',
          category: 'model',
          httpStatus: ctx.status === 400 ? 400 : 413,
          retryable: false,
          primaryAction: makeAction('switch_model', models),
        },
        null,
        sourceCode,
      )
    case 'SUBSCRIPTION_EXPIRED':
      return withOptionalFields(
        {
          code: 'SUBSCRIPTION_EXPIRED',
          category: 'auth',
          httpStatus: 401,
          retryable: false,
          primaryAction: makeAction('connect_subscription', models),
        },
        null,
        sourceCode,
      )
    case 'SUBSCRIPTION_REFUSED':
      return withOptionalFields(
        {
          code: 'SUBSCRIPTION_REFUSED',
          category: 'permission',
          httpStatus: 403,
          retryable: false,
          primaryAction: makeAction('switch_model', models),
        },
        null,
        sourceCode,
      )
    case 'AUTH_REQUIRED':
      return withOptionalFields(
        {
          code: 'AUTH_REQUIRED',
          category: 'auth',
          httpStatus: 401,
          retryable: false,
          primaryAction: makeAction('sign_in', '/sign-in'),
        },
        null,
        sourceCode,
      )
    case 'SIGNUP_VERIFICATION_UNAVAILABLE':
      return withOptionalFields(
        {
          code: 'SIGNUP_VERIFICATION_UNAVAILABLE',
          category: 'upstream',
          httpStatus: 503,
          retryable: true,
          primaryAction: makeAction('retry'),
        },
        null,
        sourceCode,
      )
    case 'SIGNUP_VERIFICATION_FAILED':
      return withOptionalFields(
        {
          code: 'SIGNUP_VERIFICATION_FAILED',
          category: 'validation',
          httpStatus: 400,
          retryable: true,
          primaryAction: makeAction('retry'),
        },
        null,
        sourceCode,
      )
    case 'AUTH_EMAIL_DELIVERY_UNAVAILABLE':
      return withOptionalFields(
        {
          code: 'AUTH_EMAIL_DELIVERY_UNAVAILABLE',
          category: 'upstream',
          httpStatus: 503,
          retryable: true,
          primaryAction: makeAction('retry'),
        },
        null,
        sourceCode,
      )
    case 'WORKSPACE_ACCESS_DENIED':
      return withOptionalFields(
        {
          code: 'WORKSPACE_ACCESS_DENIED',
          category: 'permission',
          httpStatus: 403,
          retryable: false,
          primaryAction: makeAction('none'),
        },
        null,
        sourceCode,
      )
    case 'WORKSPACE_SUSPENDED':
      return withOptionalFields(
        {
          code: 'WORKSPACE_SUSPENDED',
          category: 'permission',
          httpStatus: 403,
          retryable: false,
          primaryAction: makeAction('none'),
        },
        null,
        sourceCode,
      )
    case 'RESOURCE_NOT_FOUND':
      return withOptionalFields(
        {
          code: 'RESOURCE_NOT_FOUND',
          category: 'validation',
          httpStatus: 404,
          retryable: false,
          primaryAction: makeAction('none'),
        },
        null,
        sourceCode,
      )
    case 'RESOURCE_CONFLICT':
      return withOptionalFields(
        {
          code: 'RESOURCE_CONFLICT',
          category: 'validation',
          httpStatus: 409,
          retryable: false,
          primaryAction: makeAction('none'),
        },
        null,
        sourceCode,
      )
    case 'MESSAGE_TOO_LONG':
      return withOptionalFields(
        {
          code: 'MESSAGE_TOO_LONG',
          category: 'validation',
          httpStatus: 413,
          retryable: false,
          primaryAction: makeAction('none'),
        },
        null,
        sourceCode,
      )
    case 'VALIDATION_ERROR':
      return withOptionalFields(
        {
          code: 'VALIDATION_ERROR',
          category: 'validation',
          httpStatus: 400,
          retryable: false,
          primaryAction: makeAction('none'),
        },
        null,
        sourceCode,
      )
    case 'UPSTREAM_UNAVAILABLE':
      return withOptionalFields(
        {
          code: 'UPSTREAM_UNAVAILABLE',
          category: 'upstream',
          httpStatus: ctx.status === 502 ? 502 : 503,
          retryable: true,
          primaryAction: makeAction('retry'),
        },
        ctx.resetAt,
        sourceCode,
      )
    case 'RUN_EXECUTION_FAILED':
      return withOptionalFields(
        {
          code: 'RUN_EXECUTION_FAILED',
          category: 'internal',
          httpStatus: 500,
          retryable: true,
          primaryAction: makeAction('retry'),
        },
        null,
        sourceCode,
      )
    case 'INTERNAL_ERROR':
      return withOptionalFields(
        {
          code: 'INTERNAL_ERROR',
          category: 'internal',
          httpStatus: 500,
          retryable: false,
          primaryAction: makeAction('none'),
        },
        null,
        sourceCode,
      )
  }
}

function classifyKnownCode(
  code: string,
  detail: string | undefined,
  ctx: ResolvedContext,
): MikkaErrorContract | null {
  const billing = settingsTarget('billing', ctx.workspaceId)
  const models = settingsTarget('models', ctx.workspaceId)

  if (CODE_SET.has(code)) {
    return classifyCanonicalCode(code as MikkaErrorCode, ctx, code)
  }

  // --- Governance details ---
  if (code === 'governance_denied') {
    if (detail === 'seat_limit' || detail === 'feature_unavailable' || detail === 'template_limit') {
      return withOptionalFields(
        {
          code: 'QUOTA_EXHAUSTED',
          category: 'quota',
          httpStatus: 403,
          retryable: false,
          primaryAction: makeAction('upgrade_plan', billing),
        },
        ctx.resetAt,
        code,
      )
    }
    if (detail === 'not_found') return classifyCanonicalCode('RESOURCE_NOT_FOUND', ctx, code)
    if (detail === 'invalid_request') return classifyCanonicalCode('VALIDATION_ERROR', ctx, code)
    return classifyCanonicalCode('WORKSPACE_ACCESS_DENIED', ctx, code)
  }

  // --- run_credentials_unavailable details ---
  if (code === 'run_credentials_unavailable') {
    if (detail === 'quota_exhausted') {
      return classifyCanonicalCode('QUOTA_EXHAUSTED', ctx, code)
    }
    if (
      detail === 'credential_expired' ||
      detail === 'credential_missing' ||
      detail === 'native_credentials'
    ) {
      return classifyCanonicalCode('SUBSCRIPTION_EXPIRED', ctx, code)
    }
    return classifyCanonicalCode('UPSTREAM_UNAVAILABLE', ctx, code)
  }

  // --- interop_drive_unavailable detail ---
  if (code === 'interop_drive_unavailable') {
    if (detail === 'file_too_large') {
      return classifyCanonicalCode('MESSAGE_TOO_LONG', ctx, code)
    }
    return classifyCanonicalCode('UPSTREAM_UNAVAILABLE', ctx, code)
  }

  // --- Quota / usage limits ---
  switch (code) {
    case 'quota_exhausted':
    case 'quotaUsed':
    case 'run_quota_exceeded':
    case 'usageLimitReached':
    case 'usage_limit_reached':
    case 'usage_limit_exceeded':
    case 'usageLimitExceeded':
      return classifyCanonicalCode('QUOTA_EXHAUSTED', ctx, code)

    case 'workspace_owner_usage_limit_reached':
      return withOptionalFields(
        {
          code: 'QUOTA_EXHAUSTED',
          category: 'quota',
          httpStatus: 429,
          retryable: false,
          primaryAction: makeAction('open_billing', billing),
        },
        ctx.resetAt,
        code,
      )

    case 'workspace_member_usage_limit_reached':
      return withOptionalFields(
        {
          code: 'QUOTA_EXHAUSTED',
          category: 'quota',
          httpStatus: 429,
          retryable: false,
          primaryAction: makeAction('none'),
        },
        ctx.resetAt,
        code,
      )

    // --- Credits / Mikka points / API balance ---
    case 'points_exhausted':
    case 'free_allowance_used':
    case 'verification_required':
    case 'usageCreditsExhausted':
    case 'cloud_quota_exhausted':
    case 'cloud_machine_unfunded':
    case 'insufficient_quota':
    case 'quota_exceeded':
    case 'payment_required':
    case 'billing_not_active':
    case 'billing_error':
      return classifyCanonicalCode('CREDITS_EXHAUSTED', ctx, code)

    case 'workspace_owner_credits_depleted':
    case 'workspace_member_credits_depleted':
      return withOptionalFields(
        {
          code: 'CREDITS_EXHAUSTED',
          category: 'quota',
          httpStatus: 429,
          retryable: false,
          primaryAction: makeAction('open_billing', billing),
        },
        ctx.resetAt,
        code,
      )

    case 'insufficient_balance':
    case 'credit_balance_too_low':
      return withOptionalFields(
        {
          code: 'CREDITS_EXHAUSTED',
          category: 'quota',
          httpStatus: 429,
          retryable: false,
          primaryAction: makeAction('switch_model', models),
        },
        ctx.resetAt,
        code,
      )

    case 'usage_budget_exhausted':
    case 'billing_hard_limit':
    case 'billing_hard_limit_reached':
    case 'sessionBudgetExceeded':
      return classifyCanonicalCode('USAGE_BUDGET_EXHAUSTED', ctx, code)

    // --- Rate limits ---
    case 'SIGNUP_RATE_LIMITED':
    case 'signupRateLimited':
    case 'signInRateLimited':
    case 'subscription_rate_limited':
    case 'rateLimited':
    case 'run_rate_limited':
    case 'cloud_rate_limited':
    case 'dataExportRateLimited':
    case 'rateLimitExceeded':
    case 'rate_limit':
    case 'rate_limit_error':
    case 'rate_limit_exceeded':
    case 'rate_limit_reached':
    case 'too_many_requests':
    case 'resource_exhausted':
    case 'rate_limited':
      return classifyCanonicalCode('RATE_LIMITED', ctx, code)

    // --- Model unavailable & context length ---
    case 'modelNotFound':
    case 'model_not_found':
      return classifyCanonicalCode('MODEL_UNAVAILABLE', { ...ctx, status: 404 }, code)

    case 'executionModelUnknown':
    case 'subscription_model_unavailable':
    case 'modelRequired':
    case 'modelRejected':
    case 'provider_request_rejected':
    case 'modelProviderMismatch':
    case 'modelProviderPolicyConflict':
      return classifyCanonicalCode('MODEL_UNAVAILABLE', { ...ctx, status: 400 }, code)

    case 'run_model_unavailable':
    case 'threadModelUnavailable':
    case 'runModelMissing':
    case 'executionHarnessUnavailable':
    case 'model_not_available':
    case 'model_unavailable':
    case 'model_deprecated':
    case 'model_retired':
    case 'subscription_model_not_reported':
    case 'modelNotReported':
    case 'modelRouteDenied':
    case 'modelPolicyRevoked':
    case 'modelRegionUnverified':
    case 'modelPrincipalUnavailable':
    case 'modelPolicyChanged':
    case 'modelPolicyInvalid':
    case 'modelTransportActive':
    case 'modelProviderNotConfigured':
      return classifyCanonicalCode('MODEL_UNAVAILABLE', { ...ctx, status: 503 }, code)

    case 'contextWindowExceeded':
    case 'run_context_length_exceeded':
    case 'context_length_exceeded':
    case 'context_window_exceeded':
    case 'max_tokens_exceeded':
    case 'prompt_too_long':
      return classifyCanonicalCode('CONTEXT_WINDOW_EXCEEDED', ctx, code)

    // --- Subscription expired / reconnect ---
    case 'run_subscription_expired':
    case 'reconnect_required':
    case 'reconnect':
    case 'disconnected':
    case 'pending_auth':
    case 'invalid_credential_bundle':
      return classifyCanonicalCode('SUBSCRIPTION_EXPIRED', ctx, code)

    // --- Subscription refused / account or key misconfigured ---
    case 'account_unavailable':
    case 'unavailable':
    case 'billing_unverified':
    case 'apiKeyNotFound':
    case 'run_api_key_invalid':
    case 'invalid_api_key':
      return withOptionalFields(
        {
          code: 'SUBSCRIPTION_REFUSED',
          category: 'permission',
          httpStatus: 403,
          retryable: false,
          primaryAction: makeAction('connect_subscription', models),
        },
        null,
        code,
      )

    case 'binding_required':
    case 'binding_mismatch':
    case 'stale_binding':
    case 'selectionChanged':
    case 'provider_approval_required':
    case 'isolation_required':
    case 'provider_route_unavailable':
    case 'runtimeUnavailable':
    case 'provider_access_denied':
    case 'accessDenied':
    case 'subscription_local_runtime_unavailable':
    case 'subscription_hosted_runtime_unavailable':
      return classifyCanonicalCode('SUBSCRIPTION_REFUSED', ctx, code)

    // --- Auth / session required ---
    case 'authRequired':
    case 'SESSION_NOT_FRESH':
    case 'unauthorized':
    case 'authentication_error':
    case 'authentication_failed':
    case 'invalid_authentication':
    case 'invalidCredentials':
    case 'emailNotVerified':
    case 'EMAIL_NOT_VERIFIED':
    case 'INVALID_EMAIL_OR_PASSWORD':
    case 'USER_EMAIL_NOT_FOUND':
    case 'INVALID_PASSWORD':
    case 'CREDENTIAL_ACCOUNT_NOT_FOUND':
    case 'desktop_session_expired':
    case 'desktop_session_changed':
    case 'web_connection_session_expired':
    case 'web_connection_sign_in_required':
    case 'web_auth_session_expired':
    case 'review_auth_required':
    case 'map_auth_required':
    case 'cloud_not_connected':
    case 'cloud_server_revoked':
    case 'model_gateway_token_invalid':
      return classifyCanonicalCode('AUTH_REQUIRED', ctx, code)

    case 'INVALID_TOKEN':
    case 'invalid_token':
      if (ctx.status === 401) return classifyCanonicalCode('AUTH_REQUIRED', ctx, code)
      return withOptionalFields(
        {
          code: 'VALIDATION_ERROR',
          category: 'validation',
          httpStatus: 400,
          retryable: false,
          primaryAction:
            detail === 'password_reset'
              ? makeAction('retry', '/forgot-password')
              : makeAction('none'),
        },
        null,
        code,
      )

    // --- Turnstile / Signup verification ---
    case 'turnstileUnavailable':
    case 'turnstile_unavailable':
      return classifyCanonicalCode('SIGNUP_VERIFICATION_UNAVAILABLE', ctx, code)

    case 'TURNSTILE_REQUIRED':
    case 'TURNSTILE_INVALID':
    case 'turnstileFailed':
    case 'turnstile_failed':
      return classifyCanonicalCode('SIGNUP_VERIFICATION_FAILED', ctx, code)

    // --- Auth email delivery ---
    case 'emailUnavailable':
    case 'emailDeliveryFailed':
    case 'mail_delivery_unavailable':
      return classifyCanonicalCode('AUTH_EMAIL_DELIVERY_UNAVAILABLE', ctx, code)

    // --- Workspace access denied / suspended / billing permissions ---
    case 'workspaceMembershipSuspended':
      return classifyCanonicalCode('WORKSPACE_SUSPENDED', ctx, code)

    case 'billing_authorization_revoked':
    case 'billing_scope_missing':
    case 'billing_owner_missing':
      return withOptionalFields(
        {
          code: 'WORKSPACE_ACCESS_DENIED',
          category: 'permission',
          httpStatus: 403,
          retryable: false,
          primaryAction: makeAction('open_billing', billing),
        },
        null,
        code,
      )

    case 'workspaceAccessDenied':
    case 'run_access_denied':
    case 'cloud_access_denied':
    case 'cloud_scope_missing':
    case 'INVALID_ORIGIN':
    case 'permission_error':
    case 'permission_denied':
    case 'access_denied':
    case 'forbidden':
    case 'executionAccountUnavailable':
    case 'memberOwnerOnly':
    case 'scheduleAdminRequired':
    case 'scheduleWorkspaceAccessDenied':
    case 'teamIssueAccessDenied':
    case 'web_auth_forbidden':
    case 'interop_scope_required':
    case 'model_gateway_protocol_mismatch':
    case 'inferenceHookDenied':
    case 'cyberPolicy':
    case 'bioPolicy':
    case 'misalignmentPolicyViolation':
    case 'tooManyDenials':
      return classifyCanonicalCode('WORKSPACE_ACCESS_DENIED', ctx, code)

    // --- Not found ---
    case 'workspaceNotFound':
    case 'workspace_not_found':
    case 'runNotFound':
    case 'issueNotFound':
    case 'botNotFound':
    case 'agentNotFound':
    case 'deviceNotFound':
    case 'projectNotFound':
    case 'teamNotFound':
    case 'not_found':
    case 'not_found_error':
    case 'review_not_found':
    case 'map_not_found':
    case 'interop_not_found':
      return classifyCanonicalCode('RESOURCE_NOT_FOUND', ctx, code)

    // --- Conflicts ---
    case 'EMAIL_ALREADY_REGISTERED':
    case 'USER_ALREADY_EXISTS':
    case 'emailRegistered':
      return withOptionalFields(
        {
          code: 'RESOURCE_CONFLICT',
          category: 'validation',
          httpStatus: 409,
          retryable: false,
          primaryAction: makeAction('sign_in', '/sign-in'),
        },
        null,
        code,
      )

    case 'usage_in_progress':
      return withOptionalFields(
        {
          code: 'RESOURCE_CONFLICT',
          category: 'validation',
          httpStatus: 409,
          retryable: true,
          primaryAction: makeAction('retry'),
        },
        null,
        code,
      )

    case 'runAlreadyActive':
    case 'runNotActive':
    case 'threadWorking':
    case 'issueStale':
    case 'projectStale':
    case 'submissionConflict':
    case 'scheduleVersionConflict':
    case 'activeTurnNotSteerable':
      return classifyCanonicalCode('RESOURCE_CONFLICT', ctx, code)

    // --- Payload / message length validation ---
    case 'messageTooLong':
    case 'personalInstructionsTooLong':
    case 'deviceNameTooLong':
    case 'botNameTooLong':
    case 'avatarTooLarge':
    case 'terminal_input_too_large':
    case 'map_too_large':
    case 'map_source_too_large':
    case 'model_gateway_body_too_large':
    case 'request_too_large':
      return classifyCanonicalCode('MESSAGE_TOO_LONG', ctx, code)

    // --- General validation ---
    case 'DISPOSABLE_EMAIL':
    case 'disposableEmail':
    case 'PASSWORD_TOO_SHORT':
    case 'PASSWORD_TOO_LONG':
    case 'password_length':
    case 'passwordTooShort':
    case 'passwordTooLong':
    case 'passwordIncorrect':
    case 'messageRequired':
    case 'validationGeneric':
    case 'badRequest':
    case 'bad_request':
    case 'invalid_request':
    case 'invalid_request_error':
    case 'run_invalid_request':
    case 'runInvalid':
    case 'cloud_invalid_request':
    case 'interop_invalid_request':
    case 'model_gateway_body_invalid':
      return classifyCanonicalCode('VALIDATION_ERROR', ctx, code)

    // --- Upstream / transient / provider unavailable ---
    case 'platform_paused':
      return withOptionalFields(
        {
          code: 'UPSTREAM_UNAVAILABLE',
          category: 'upstream',
          httpStatus: 503,
          retryable: false,
          primaryAction: ctx.subscribed
            ? makeAction('switch_model', models)
            : makeAction('connect_subscription', models),
        },
        ctx.resetAt,
        code,
      )

    case 'run_network_error':
    case 'run_provider_error':
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
    case 'responseTooManyFailedAttempts':
    case 'connection_error':
    case 'network_error':
    case 'provider_error':
    case 'api_error':
    case 'ECONNRESET':
    case 'ECONNREFUSED':
    case 'ECONNABORTED':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
    case 'EPIPE':
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
    case 'UND_ERR_SOCKET':
    case 'ABORT_ERR':
      return classifyCanonicalCode('UPSTREAM_UNAVAILABLE', { ...ctx, status: 502 }, code)

    case 'backend_unavailable':
    case 'provider_temporarily_unavailable':
    case 'quota_unknown':
    case 'quotaChecking':
    case 'retry':
    case 'usage_concurrency_limit':
    case 'usage_cost_unavailable':
    case 'serverOverloaded':
    case 'overloaded':
    case 'overloaded_error':
    case 'flexUnavailable':
    case 'policyCapacityUnavailable':
    case 'cloud_unavailable':
    case 'run_timeout':
    case 'run_mcp_unavailable':
    case 'subscription_timeout':
    case 'timeout':
    case 'timeout_error':
    case 'request_timeout':
    case 'wake_failed':
    case 'wake_start_unconfirmed':
    case 'coordinatorUnavailable':
      return classifyCanonicalCode('UPSTREAM_UNAVAILABLE', { ...ctx, status: 503 }, code)

    // --- Run execution failures ---
    case 'run_failed':
    case 'wake_exhausted':
    case 'model_tool_unavailable':
    case 'subscription_generation_failed':
    case 'provider_operation_failed':
    case 'sandboxError':
    case 'threadRollbackFailed':
      return classifyCanonicalCode('RUN_EXECUTION_FAILED', ctx, code)

    // --- Internal errors ---
    case 'internalServerError':
    case 'internal_server_error':
    case 'server_error':
      return classifyCanonicalCode('INTERNAL_ERROR', ctx, code)

    default:
      return null
  }
}

function extractCodexErrorInfo(value: unknown, ctx: ResolvedContext): MikkaErrorContract | null {
  if (typeof value === 'string') {
    return classifyKnownCode(value, undefined, ctx)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  // Tagged union variant like { httpConnectionFailed: { httpStatusCode: 503 } }
  for (const variant of [
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts',
    'activeTurnNotSteerable',
  ] as const) {
    const inner = own(value, variant)
    if (inner !== undefined) {
      const innerStatus = safeNumber(own(inner, 'httpStatusCode'))
      if (variant !== 'activeTurnNotSteerable' && innerStatus !== undefined) {
        const byStatus = classifyHttpStatus(innerStatus, { ...ctx, status: innerStatus }, variant)
        if (byStatus) return byStatus
      }
      return classifyKnownCode(variant, undefined, { ...ctx, status: innerStatus ?? ctx.status })
    }
  }
  // ModelProviderError tagged union: { type: 'modelProviderNotConfigured', ... }
  const type = safeString(own(value, 'type'), 80)
  if (type) return classifyKnownCode(type, undefined, ctx)
  return null
}

function classifyChatFailureShape(input: unknown, ctx: ResolvedContext): MikkaErrorContract | null {
  const kind = safeString(own(input, 'kind'), 32)
  if (!kind) return null
  if (kind === 'hosted') {
    const code = safeString(own(input, 'code'), 64)
    return code ? classifyKnownCode(code, undefined, ctx) : null
  }
  if (kind === 'subscription') {
    const notice = safeString(own(input, 'notice'), 64)
    return notice ? classifyKnownCode(notice, undefined, ctx) : null
  }
  if (kind === 'wake') {
    const code = safeString(own(input, 'code'), 64)
    return code ? classifyKnownCode(code, undefined, ctx) : null
  }
  if (kind === 'failed') {
    const cloudCode = safeString(own(input, 'cloudCode'), 64)
    if (cloudCode) {
      const mapped = classifyKnownCode(cloudCode, undefined, ctx)
      if (mapped) return mapped
    }
    const reason = safeString(own(input, 'reason'), 32)
    if (reason === 'balance') {
      return classifyKnownCode('insufficient_balance', undefined, ctx)
    }
    if (reason === 'modelRequired') {
      return classifyKnownCode('modelRequired', undefined, ctx)
    }
    if (reason === 'tools') {
      return classifyKnownCode('model_tool_unavailable', undefined, ctx)
    }
    // Check structured failureDetails if attached on ChatFailure
    const details = own(input, 'failureDetails')
    if (details) {
      const fromDetails = classifyRunFailureShape(details, ctx)
      if (fromDetails) return fromDetails
    }
    return classifyCanonicalCode('RUN_EXECUTION_FAILED', ctx)
  }
  return null
}

function classifyRunFailureShape(input: unknown, ctx: ResolvedContext): MikkaErrorContract | null {
  if (own(input, 'schemaVersion') !== 1) return null
  const code = safeString(own(input, 'code'), 80)
  const detail = safeString(own(input, 'detail'), 80)
  const status = safeNumber(own(input, 'status')) ?? ctx.status
  const nextCtx = { ...ctx, status }
  if (code) {
    const byCode = classifyKnownCode(code, detail, nextCtx)
    if (byCode) return byCode
  }
  const category = safeString(own(input, 'category'), 32)
  switch (category) {
    case 'subscription':
      return classifyCanonicalCode('SUBSCRIPTION_EXPIRED', nextCtx)
    case 'api_key':
      return classifyKnownCode('run_api_key_invalid', undefined, nextCtx)
    case 'quota':
      return classifyCanonicalCode('QUOTA_EXHAUSTED', nextCtx)
    case 'rate_limit':
      return classifyCanonicalCode('RATE_LIMITED', nextCtx)
    case 'invalid_request':
      return classifyCanonicalCode('VALIDATION_ERROR', nextCtx)
    case 'access_denied':
      return classifyCanonicalCode('WORKSPACE_ACCESS_DENIED', nextCtx)
    case 'model_unavailable':
      return classifyCanonicalCode('MODEL_UNAVAILABLE', nextCtx)
    case 'context_length':
      return classifyCanonicalCode('CONTEXT_WINDOW_EXCEEDED', nextCtx)
    case 'timeout':
    case 'network':
    case 'provider':
      return classifyCanonicalCode('UPSTREAM_UNAVAILABLE', nextCtx)
    case 'internal':
      return classifyCanonicalCode('RUN_EXECUTION_FAILED', nextCtx)
    default:
      return null
  }
}

function classifyAuthRecoveryShape(input: unknown, ctx: ResolvedContext): MikkaErrorContract | null {
  if (own(input, 'ok') !== false) return null
  const error = safeString(own(input, 'error'), 64)
  if (!error) return null
  switch (error) {
    case 'rate_limited':
      return classifyCanonicalCode('RATE_LIMITED', ctx, 'rate_limited')
    case 'invalid_token':
      return classifyKnownCode('invalid_token', undefined, ctx)
    case 'password_length':
      return classifyKnownCode('password_length', undefined, ctx)
    case 'unavailable':
      return classifyCanonicalCode('AUTH_EMAIL_DELIVERY_UNAVAILABLE', ctx, 'AUTH_EMAIL_DELIVERY_UNAVAILABLE')
    case 'turnstile_failed':
      return classifyCanonicalCode('SIGNUP_VERIFICATION_FAILED', ctx, 'turnstile_failed')
    case 'turnstile_unavailable':
      return classifyCanonicalCode('SIGNUP_VERIFICATION_UNAVAILABLE', ctx, 'turnstile_unavailable')
    case 'invalid_request':
      return classifyCanonicalCode('VALIDATION_ERROR', ctx, 'invalid_request')
    case 'failed':
      return classifyCanonicalCode('INTERNAL_ERROR', ctx)
    default:
      return null
  }
}

function classifyQuotaViewOrEventShape(input: unknown, ctx: ResolvedContext): MikkaErrorContract | null {
  // run_quota_paused coordinator event payload or ThreadQuotaView.paused or UsageLimit
  const reason = safeString(own(input, 'reason'), 64)
  if (reason === 'quota_exhausted') {
    return classifyCanonicalCode('QUOTA_EXHAUSTED', ctx, 'quota_exhausted')
  }
  const paused = own(input, 'paused')
  if (paused && typeof paused === 'object' && !Array.isArray(paused) && safeString(own(paused, 'runId'), 128)) {
    return classifyCanonicalCode('QUOTA_EXHAUSTED', ctx, 'quota_exhausted')
  }
  const pausedThreadIds = own(input, 'pausedThreadIds')
  const provider = safeString(own(input, 'provider'), 32)
  if (Array.isArray(pausedThreadIds) && (provider === 'claude' || provider === 'codex')) {
    return classifyCanonicalCode('QUOTA_EXHAUSTED', ctx, 'quota_exhausted')
  }
  // Codex RateLimitSnapshot
  const reachedType = safeString(own(input, 'rateLimitReachedType'), 64)
  if (reachedType) {
    return classifyKnownCode(reachedType, undefined, ctx)
  }
  return null
}

function cloneValidContract(
  contract: MikkaErrorContract,
  resetAtOverride: string | null,
): MikkaErrorContract {
  const effectiveResetAt =
    contract.resetAt !== undefined && contract.resetAt !== null ? contract.resetAt : resetAtOverride
  const action =
    contract.primaryAction.kind === 'none'
      ? { kind: 'none' as const }
      : contract.primaryAction.target
        ? { kind: contract.primaryAction.kind, target: contract.primaryAction.target }
        : { kind: contract.primaryAction.kind }
  return {
    code: contract.code,
    category: contract.category,
    httpStatus: contract.httpStatus,
    retryable: contract.retryable,
    ...(effectiveResetAt !== null ? { resetAt: effectiveResetAt } : {}),
    primaryAction: action,
    ...(contract.sourceCode ? { sourceCode: contract.sourceCode } : {}),
  } as MikkaErrorContract
}

const MAX_ENVELOPE_DEPTH = 6

/**
 * Normalize an existing Mikka or Codex refusal payload onto `MikkaErrorContract`.
 * Returns `null` when the input is not a recognized refusal (e.g. `null`,
 * `'ready'`, `{ ok: true }`, `{ working: true }`, or unrecognized free text).
 */
export function normalizeLegacyRefusal(
  input: unknown,
  options: MikkaErrorContractOptions = {},
): MikkaErrorContract | null {
  return normalizeLegacyRefusalInternal(input, options, 0, new Set())
}

function normalizeLegacyRefusalInternal(
  input: unknown,
  options: MikkaErrorContractOptions,
  depth: number,
  seen: Set<object>,
): MikkaErrorContract | null {
  if (input === null || input === undefined || depth > MAX_ENVELOPE_DEPTH) return null

  const ctx = resolveContext(input, options)

  // Already a valid MikkaErrorContract
  if (isMikkaErrorContract(input)) {
    return cloneValidContract(input, ctx.resetAt)
  }

  // Raw string refusal/code
  if (typeof input === 'string') {
    const parsed = parseRefusalString(input)
    if (!parsed) return null
    if (parsed.isApiBalance) return classifyKnownCode('insufficient_balance', undefined, ctx)
    return classifyKnownCode(parsed.code, parsed.detail, ctx)
  }

  if (typeof input !== 'object' || Array.isArray(input)) return null
  if (seen.has(input)) return null
  seen.add(input)

  // Working / healthy states are never refusals
  if (own(input, 'working') === true || own(input, 'ok') === true) return null

  // Embedded additive errorContract (e.g. APIError.body.errorContract or response envelope)
  const embedded = own(input, 'errorContract')
  if (isMikkaErrorContract(embedded)) {
    return cloneValidContract(embedded, ctx.resetAt)
  }

  // Better Auth APIError / HTTP wrapper with `.body`
  const body = own(input, 'body')
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const bodyContract = own(body, 'errorContract')
    if (isMikkaErrorContract(bodyContract)) {
      return cloneValidContract(bodyContract, ctx.resetAt)
    }
    const fromBody = normalizeLegacyRefusalInternal(
      body,
      {
        ...options,
        status: ctx.status,
        resetAt: ctx.resetAt ?? options.resetAt,
      },
      depth + 1,
      seen,
    )
    if (fromBody) return fromBody
  }

  // ChatFailure shape (`{ kind: 'hosted' | 'subscription' | 'wake' | 'failed', ... }`)
  const fromChat = classifyChatFailureShape(input, ctx)
  if (fromChat) return fromChat

  // RunFailure shape (`schemaVersion: 1`) or RunFailureError (`failureDetails`)
  const fromRunFailure = classifyRunFailureShape(input, ctx)
  if (fromRunFailure) return fromRunFailure
  const nestedDetails = own(input, 'failureDetails')
  if (nestedDetails) {
    const fromNestedDetails = classifyRunFailureShape(nestedDetails, ctx)
    if (fromNestedDetails) return fromNestedDetails
  }

  // AuthRecoveryResult failure (`{ ok: false, error, retryAfter? }`)
  const fromAuthRecovery = classifyAuthRecoveryShape(input, ctx)
  if (fromAuthRecovery) return fromAuthRecovery

  // Quota paused event / ThreadQuotaView / UsageLimit / Codex RateLimitSnapshot
  const fromQuota = classifyQuotaViewOrEventShape(input, ctx)
  if (fromQuota) return fromQuota

  // Codex TurnError / ErrorNotification (`{ codexErrorInfo }` or `{ error: TurnError }`)
  const codexInfo = own(input, 'codexErrorInfo')
  if (codexInfo !== undefined) {
    const fromCodex = extractCodexErrorInfo(codexInfo, ctx)
    if (fromCodex) return fromCodex
  }
  const directCodex = extractCodexErrorInfo(input, ctx)
  if (directCodex) return directCodex

  // Direct coded object: CodedError, PaidResourceError, SubscriptionRefusal,
  // WorkspaceError, ActionFailureError, CloudServiceError, GovernanceError,
  // ModelAdmissionError, ActionFailure `{ error: ActionErrorCode }`, JSON `{ code }`
  const detail = safeString(own(input, 'detail'), 64)
  const directCode =
    safeString(own(input, 'code'), 80) ??
    (typeof own(input, 'error') === 'string' ? safeString(own(input, 'error'), 80) : undefined)
  if (directCode) {
    const parsedDirect = parseRefusalString(directCode)
    if (parsedDirect) {
      const mapped = classifyKnownCode(parsedDirect.code, detail ?? parsedDirect.detail, ctx)
      if (mapped) return mapped
    }
  }

  // Nested `{ error: { ... } }` envelope (e.g. ErrorNotification / API JSON error)
  const nestedError = own(input, 'error')
  if (nestedError && typeof nestedError === 'object' && !Array.isArray(nestedError)) {
    const fromNested = normalizeLegacyRefusalInternal(
      nestedError,
      {
        ...options,
        status: ctx.status,
        resetAt: ctx.resetAt ?? options.resetAt,
      },
      depth + 1,
      seen,
    )
    if (fromNested) return fromNested
  }

  // Error.message carrying a recognized refusal/coded string (never copies prose)
  const message = safeString(own(input, 'message'), 512)
  if (message) {
    const parsedMessage = parseRefusalString(message)
    if (parsedMessage) {
      if (parsedMessage.isApiBalance) return classifyKnownCode('insufficient_balance', undefined, ctx)
      const mapped = classifyKnownCode(parsedMessage.code, detail ?? parsedMessage.detail, ctx)
      if (mapped) return mapped
    }
  }

  // HostedUsage `{ state: HostedRefusal }` (ignore `'ready'`)
  const state = safeString(own(input, 'state'), 64)
  if (state && state !== 'ready') {
    const mapped = classifyKnownCode(state, undefined, ctx)
    if (mapped) return mapped
  }

  return null
}

function classifyHttpStatus(
  status: number,
  ctx: ResolvedContext,
  sourceCode?: string,
): MikkaErrorContract | null {
  switch (status) {
    case 400:
    case 422:
      return classifyCanonicalCode('VALIDATION_ERROR', ctx, sourceCode)
    case 401:
      return classifyCanonicalCode('AUTH_REQUIRED', ctx, sourceCode)
    case 402:
      return classifyCanonicalCode('CREDITS_EXHAUSTED', ctx, sourceCode)
    case 403:
      return classifyCanonicalCode('WORKSPACE_ACCESS_DENIED', ctx, sourceCode)
    case 404:
      return classifyCanonicalCode('RESOURCE_NOT_FOUND', ctx, sourceCode)
    case 408:
    case 504:
      return classifyCanonicalCode('UPSTREAM_UNAVAILABLE', { ...ctx, status: 503 }, sourceCode)
    case 409:
      return classifyCanonicalCode('RESOURCE_CONFLICT', ctx, sourceCode)
    case 413:
      return classifyCanonicalCode('MESSAGE_TOO_LONG', ctx, sourceCode)
    case 429:
      return classifyCanonicalCode('RATE_LIMITED', ctx, sourceCode)
    case 502:
      return classifyCanonicalCode('UPSTREAM_UNAVAILABLE', { ...ctx, status: 502 }, sourceCode)
    case 503:
      return classifyCanonicalCode('UPSTREAM_UNAVAILABLE', { ...ctx, status: 503 }, sourceCode)
    case 500:
      return classifyCanonicalCode('INTERNAL_ERROR', ctx, sourceCode)
    default:
      if (status >= 500 && status <= 599) {
        return classifyCanonicalCode('INTERNAL_ERROR', ctx, sourceCode)
      }
      return null
  }
}

/**
 * Convert any Mikka error, legacy refusal, Codex protocol error, HTTP error
 * payload, or unknown thrown exception into a guaranteed-safe `MikkaErrorContract`.
 *
 * Never throws and never leaks raw stack traces, messages, or secrets.
 */
export function toMikkaErrorContract(
  input: unknown,
  options: MikkaErrorContractOptions = {},
): MikkaErrorContract {
  const seen = new Set<object>()
  const recognized = normalizeLegacyRefusalInternal(input, options, 0, seen)
  if (recognized) return recognized

  const ctx = resolveContext(input, options)

  // Check error cause chain (bounded depth + cycle protection) before HTTP status fallback.
  let cursor: unknown = own(input, 'cause')
  for (let depth = 0; depth < 4 && cursor !== undefined && cursor !== null; depth++) {
    if (typeof cursor === 'object' && seen.has(cursor)) break
    const fromCause = normalizeLegacyRefusalInternal(
      cursor,
      {
        ...options,
        resetAt: ctx.resetAt ?? options.resetAt,
        status: ctx.status,
      },
      depth + 1,
      seen,
    )
    if (fromCause) return fromCause
    cursor = own(cursor, 'cause')
  }

  // Known Error subclass names without an explicit code (read own or prototype data property safely)
  const protoName =
    input instanceof Error ? own(Object.getPrototypeOf(input), 'name') : undefined
  const errorName = safeString(own(input, 'name'), 80) ?? safeString(protoName, 80)
  if (errorName === 'AI_NoSuchModelError' || errorName === 'NoSuchModelError') {
    return classifyCanonicalCode('MODEL_UNAVAILABLE', { ...ctx, status: 404 })
  }
  if (errorName === 'RateLimitError') {
    return classifyCanonicalCode('RATE_LIMITED', ctx)
  }
  if (errorName === 'AuthenticationError' || errorName === 'AI_LoadAPIKeyError') {
    return classifyCanonicalCode('AUTH_REQUIRED', ctx)
  }
  if (errorName === 'PermissionDeniedError') {
    return classifyCanonicalCode('WORKSPACE_ACCESS_DENIED', ctx)
  }
  if (errorName === 'NotFoundError') {
    return classifyCanonicalCode('RESOURCE_NOT_FOUND', ctx)
  }
  if (errorName === 'BadRequestError' || errorName === 'ValidationError') {
    return classifyCanonicalCode('VALIDATION_ERROR', ctx)
  }
  if (
    errorName === 'TimeoutError' ||
    errorName === 'APIConnectionTimeoutError' ||
    errorName === 'APIConnectionError' ||
    errorName === 'NetworkError' ||
    errorName === 'FetchError'
  ) {
    return classifyCanonicalCode('UPSTREAM_UNAVAILABLE', { ...ctx, status: 502 })
  }

  if (ctx.status !== undefined) {
    const byStatus = classifyHttpStatus(ctx.status, ctx)
    if (byStatus) return byStatus
  }

  return classifyCanonicalCode('INTERNAL_ERROR', ctx)
}

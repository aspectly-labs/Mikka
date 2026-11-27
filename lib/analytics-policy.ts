import { scrubLocalString } from '@mikka/protocol/tracing'
import { safeDomain, safeLabel, safeLanding } from './first-touch.ts'

const allowedEvents = new Set(['$pageview', '$identify', '$feature_flag_called', 'mikka_team_created', 'mikka_team_updated', 'mikka_live_socket', 'mikka_live_received', 'mikka_live_skipped', 'mikka_live_read'])
const allowedProperties = new Set([
  'token', 'distinct_id', '$device_id', '$user_id', '$session_id', '$window_id',
  '$lib', '$lib_version', '$browser', '$browser_version', '$os', '$os_version', '$device_type',
  '$screen_width', '$screen_height', '$viewport_width', '$viewport_height', '$is_identified', '$process_person_profile',
  '$feature_flag', '$feature_flag_response', '$feature_flag_request_id', '$feature_flag_reason', '$feature_flag_error', '$active_feature_flags',
  'app', 'environment', 'runtime', 'section', 'test_account',
  'live_state', 'live_reason', 'live_kind', 'live_entity_id', 'live_revision', 'read_key', 'read_key_hash',
  // A heartbeat's round trip in whole milliseconds: a bounded integer from a
  // monotonic clock, carrying no user data, message text or identifier.
  'live_rtt_ms',
])

/** Replay also uses this callback for its navigation metadata. Keep the
 * sanitized route, while request/response content and credentials stay out. */
export function redactReplayRequest<T extends { name: string }>(request: T): T | null {
  try {
    const url = new URL(request.name)
    const sanitized = { ...request, name: `${url.origin}${analyticsPath(url.pathname)}` }
    for (const key of ['requestBody', 'responseBody', 'requestHeaders', 'responseHeaders']) Reflect.deleteProperty(sanitized, key)
    return sanitized
  } catch { return null }
}

/** Pages whose next segment is a credential, wherever they sit in the path
 * (after a base path or locale): an artifact, thread or capture share link and
 * the two invitations. Its holder can open what it names, so it never leaves. */
const CREDENTIAL_PREFIXES = [['a'], ['invite'], ['organization-invite'], ['threads', 'shared'], ['share']]
/** Pages whose next segment names a workspace (`/w/acme`) rather than a page. */
const SLUG_PREFIXES = [['w']]
/** A segment that is a page's own name (`settings`, `forgot-password`): lower-case
 * words, no digits, so a lower-case hex id or token is never mistaken for one. */
const ROUTE_WORD = /^(?=.{1,40}$)[a-z]+(?:-[a-z]+)*$/
const LOCALE_SEGMENT = /^(?:en|zh-CN)$/

function follows(previous: string[], prefix: string[]) {
  return previous.length >= prefix.length && prefix.every((word, index) => previous[previous.length - prefix.length + index] === word)
}

/**
 * A page path with every dynamic segment replaced by a placeholder. Only a
 * page's own words and the locale stay; a share or invitation token becomes
 * `:token` after its page word, a UUID or number `:id`, an email `:redacted`,
 * and anything else that is not a route word (`SPOT-4`, a token on a page this
 * list does not name yet) `:token`. The query and hash are the caller's to drop.
 */
export function analyticsPath(pathname: string) {
  const previous: string[] = []
  const segments = pathname.split('/').map(raw => {
    if (!raw) return raw
    const word = raw.toLowerCase()
    let clean: string
    if (CREDENTIAL_PREFIXES.some(prefix => follows(previous, prefix))) clean = ':token'
    else if (SLUG_PREFIXES.some(prefix => follows(previous, prefix))) clean = ':slug'
    else if (EMAIL_LIKE_SEGMENT.test(raw)) clean = ':redacted'
    else if (UUID_SEGMENT.test(raw) || /^\d+$/.test(raw)) clean = ':id'
    else if (ROUTE_WORD.test(raw) || LOCALE_SEGMENT.test(raw)) clean = raw
    else clean = ':token'
    previous.push(clean === raw ? word : clean)
    return clean
  })
  return segments.join('/')
}

/** Error levels an exception event may carry, from a closed set. */
const exceptionLevels = new Set(['error', 'warning', 'info', 'debug', 'log', 'fatal'])
/** A class name (`TypeError`, `DOMException`), never a message or a path. */
const EXCEPTION_TYPE = /^[A-Za-z_$][\w$.-]{0,63}$/
const SAFE_BOUNDARY_NAME = /^[a-zA-Z0-9._:-]{1,64}$/
const SAFE_BUILD_SHA = /^[a-zA-Z0-9._-]{0,64}$/
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LONG_TOKEN_SEGMENT = /^(?=.*\d)[A-Za-z0-9_-]{16,}$/
const NUMERIC_ID_SEGMENT = /^\d{5,}$/
const EMAIL_LIKE_SEGMENT = /@/
const viewportBuckets = new Set(['mobile', 'tablet', 'desktop', 'wide'])
const runtimeErrorSources = new Set(['window_error', 'unhandled_rejection'])
const rumFlushReasons = new Set(['visibility_hidden', 'pagehide', 'route_change'])
const frontendRumEvents = new Set(['frontend_render_error', 'frontend_runtime_error', 'frontend_web_vitals'])
/** Bounds a hostile payload, not a real one: the SDK sends one entry and at
 * most 50 frames for an exception. */
const EXCEPTION_LIST_LIMIT = 5
const EXCEPTION_FRAME_LIMIT = 32
/** A credential echoed into a message. `scrubLocalString` masks URLs, webhook
 * keys, emails, IPs and home paths, but not a bare `Bearer …` or `sk-…`. */
const CREDENTIAL = /(\b(?:authorization|bearer|token|secret|password|api[_-]?key|cookie)\b\s*[:=]?\s*["']?)[\w.~+/=-]{8,}|\b(?:sk|pk|rk|ghp|gho|ghs|ghu|phc|xox[abpsr])[-_][\w-]{8,}|\beyJ[\w-]{8,}\.[\w-]{8,}(?:\.[\w-]*)?/gi

/** Which client and build sent an event: the desktop adds these in its main
 * process (apps/desktop/src/main/telemetry.ts). Closed words, a version and
 * two commit SHAs, never anything a person wrote. */
const releaseTagPatterns: Record<string, RegExp> = {
  platform: /^(?:desktop|web)$/,
  app_version: /^\d{1,6}\.\d{1,8}\.\d{1,8}(?:[-+][0-9A-Za-z.-]{1,32})?$/,
  public_sha: /^[0-9a-f]{7,40}$/,
  overlay_sha: /^[0-9a-f]{7,40}$/,
}
function releaseTags(properties: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(releaseTagPatterns).flatMap(([key, pattern]) => {
    const value = properties[key]
    return typeof value === 'string' && pattern.test(value) ? [[key, value]] : []
  }))
}

/** The SDK's bot classification, which is the only browser detail that stays:
 * its user agent, platform and screen never do. */
function browserClassification(properties: Record<string, unknown>) {
  const type = properties.$browser_type
  return type === 'bot' || type === 'browser' ? { $browser_type: type } : {}
}

/** Where an event happened, as its route: never the query string, the hash or
 * a document identifier, and never an unparseable URL's raw text. */
function route(properties: Record<string, unknown>) {
  if (typeof properties.$current_url !== 'string') return {}
  try {
    const url = new URL(properties.$current_url)
    // The desktop's own scheme (mikka://app) has no WHATWG origin; its host still names the app, never a person.
    const origin = url.origin === 'null' && url.protocol === 'mikka:' && url.host === 'app' ? 'mikka://app' : url.origin
    return { $current_url: `${origin}${analyticsPath(url.pathname)}`, $pathname: analyticsPath(url.pathname) }
  } catch { return {} }
}

/** Sanitized acquisition fields: bounded UTM labels and referring domains
 * only — never a full URL, query string, fragment or free-form value. Covers
 * the SDK's `$session_entry_*` names and the marketing site's `first_touch_*`
 * props alongside bare `utm_*`/`$referring_domain`. */
function source(properties: Record<string, unknown>) {
  const out: Record<string, string> = {}
  for (const key of ['$referring_domain', '$session_entry_referring_domain', 'first_touch_referrer_domain']) {
    const domain = safeDomain(properties[key])
    if (domain) out[key] = domain
  }
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    '$session_entry_utm_source', '$session_entry_utm_medium', '$session_entry_utm_campaign', '$session_entry_utm_content', '$session_entry_utm_term',
    'first_touch_source',
    'first_touch_utm_source', 'first_touch_utm_medium', 'first_touch_utm_campaign', 'first_touch_utm_content', 'first_touch_utm_term']) {
    const label = safeLabel(properties[key])
    if (label) out[key] = label
  }
  const landing = safeLanding(properties.first_touch_landing)
  if (landing && landing !== '/') out.first_touch_landing = landing
  return out
}

/** The allowlisted properties plus the classification and the route, so a
 * `$set` riding on the event cannot add person properties either. */
function narrow<T extends { event: string; properties: Record<string, unknown> }>(event: T, kept: Record<string, unknown> = {}): T {
  const properties = {
    ...Object.fromEntries(Object.entries(event.properties).filter(([key]) => allowedProperties.has(key))),
    ...browserClassification(event.properties), ...route(event.properties), ...source(event.properties), ...releaseTags(event.properties), ...kept,
  }
  const narrowed = { ...event, properties }
  for (const key of ['$set', '$set_once', '$unset']) Reflect.deleteProperty(narrowed, key)
  return narrowed
}

/** A message from this app, not the user's data: any credential it echoes is
 * masked, and so is everything `scrubLocalString` already covers. */
function scrubMessage(value: unknown): string {
  return typeof value === 'string' ? scrubLocalString(value).replace(CREDENTIAL, '$1[redacted]') : ''
}

/** One frame this app can act on: the bundle the browser loaded, its line and
 * column, and the function name. Frames the SDK cannot attribute to this app's
 * own code (extensions, other origins) are dropped rather than guessed at, and
 * so is every other frame field the SDK attaches. */
function scrubbedFrame(frame: unknown) {
  if (!frame || typeof frame !== 'object') return null
  const record = frame as Record<string, unknown>
  if (record.in_app !== true) return null
  const filename = typeof record.filename === 'string' ? scrubLocalString(record.filename) : ''
  if (!filename) return null
  return {
    platform: 'web:javascript', in_app: true, filename,
    function: typeof record.function === 'string' ? scrubLocalString(record.function).slice(0, 128) : '?',
    ...(Number.isSafeInteger(record.lineno) ? { lineno: record.lineno } : {}),
    ...(Number.isSafeInteger(record.colno) ? { colno: record.colno } : {}),
  }
}

/** One entry of PostHog's own `$exception_list`: what an issue groups by (type
 * and message), whether the SDK called it handled, and the in-app stack. Chain
 * identifiers, breadcrumbs and coercion context (`cause`, `errors`) are not
 * kept: they echo the values that made the error. */
function scrubbedException(entry: unknown) {
  if (!entry || typeof entry !== 'object') return null
  const record = entry as Record<string, unknown>
  const type = typeof record.type === 'string' && EXCEPTION_TYPE.test(record.type) ? record.type : 'Error'
  const mechanism = record.mechanism && typeof record.mechanism === 'object' ? record.mechanism as Record<string, unknown> : {}
  const stacktrace = record.stacktrace && typeof record.stacktrace === 'object' ? record.stacktrace as Record<string, unknown> : {}
  const frames = (Array.isArray(stacktrace.frames) ? stacktrace.frames : []).map(scrubbedFrame).filter(frame => frame !== null).slice(0, EXCEPTION_FRAME_LIMIT)
  return {
    type,
    value: scrubMessage(record.value) || type,
    mechanism: {
      type: typeof mechanism.type === 'string' && EXCEPTION_TYPE.test(mechanism.type) ? mechanism.type : 'generic',
      handled: mechanism.handled !== false,
      synthetic: mechanism.synthetic === true,
    },
    ...(frames.length ? { stacktrace: { type: 'raw', frames } } : {}),
  }
}

/** PostHog's exception autocapture (`capture_exceptions`) is the product's only
 * crash telemetry: a render error, a throwing handler or an unhandled rejection
 * arrives here and nowhere else. An event without a usable entry is dropped. */
function sanitizeExceptionEvent<T extends { event: string; properties: Record<string, unknown> }>(event: T): T | null {
  const list = event.properties.$exception_list
  const entries = (Array.isArray(list) ? list.slice(0, EXCEPTION_LIST_LIMIT) : []).map(scrubbedException).filter(entry => entry !== null)
  if (!entries.length) return null
  const level = event.properties.$exception_level
  return narrow(event, {
    $exception_list: entries,
    ...(typeof level === 'string' && exceptionLevels.has(level) ? { $exception_level: level } : {}),
  })
}

/** Re-sanitizes a RUM route path at the PostHog gateway so query strings,
 * hashes, invite tokens, UUIDs, emails and opaque IDs can never pass through. */
function sanitizeRumRoute(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  let pathname = value.trim()
  try {
    pathname = new URL(pathname, 'https://mikka.invalid').pathname
  } catch {
    pathname = pathname.split(/[?#]/, 1)[0] ?? '/'
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`
  const normalized = analyticsPath(`/${pathname.split('/').filter(Boolean).join('/')}`)
  return normalized.length > 160 ? normalized.slice(0, 160) : normalized
}

function boundedMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 3_600_000) return undefined
  return Math.round(value)
}

function boundedCls(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return undefined
  return Math.round(value * 10_000) / 10_000
}

/** Strict allowlist for frontend ErrorBoundary and zero-idle Core Web Vitals RUM
 * events: keeps only bounded non-PII class names, routes, buckets and timings. */
function sanitizeFrontendRumEvent<T extends { event: string; properties: Record<string, unknown> }>(event: T): T | null {
  const props = event.properties
  const kept: Record<string, unknown> = {}
  const rumRoute = sanitizeRumRoute(props.route)
  if (rumRoute !== undefined) kept.route = rumRoute
  if (typeof props.build_sha === 'string' && SAFE_BUILD_SHA.test(props.build_sha)) kept.build_sha = props.build_sha
  if (typeof props.viewport_bucket === 'string' && viewportBuckets.has(props.viewport_bucket)) kept.viewport_bucket = props.viewport_bucket

  if (event.event === 'frontend_render_error') {
    kept.error_name = typeof props.error_name === 'string' && EXCEPTION_TYPE.test(props.error_name) ? props.error_name : 'Error'
    if (typeof props.boundary === 'string' && SAFE_BOUNDARY_NAME.test(props.boundary)) kept.boundary = props.boundary
    if (typeof props.recoverable === 'boolean') kept.recoverable = props.recoverable
    return narrow(event, kept)
  }

  if (event.event === 'frontend_runtime_error') {
    kept.error_name = typeof props.error_name === 'string' && EXCEPTION_TYPE.test(props.error_name) ? props.error_name : 'Error'
    if (typeof props.error_source === 'string' && runtimeErrorSources.has(props.error_source)) kept.error_source = props.error_source
    return narrow(event, kept)
  }

  if (typeof props.flush_reason === 'string' && rumFlushReasons.has(props.flush_reason)) kept.flush_reason = props.flush_reason
  const lcp = boundedMs(props.lcp_ms)
  const cls = boundedCls(props.cls)
  const inp = boundedMs(props.inp_ms)
  const fcp = boundedMs(props.fcp_ms)
  const ttfb = boundedMs(props.ttfb_ms)
  if (lcp === undefined && cls === undefined && inp === undefined && fcp === undefined && ttfb === undefined) return null
  if (lcp !== undefined) kept.lcp_ms = lcp
  if (cls !== undefined) kept.cls = cls
  if (inp !== undefined) kept.inp_ms = inp
  if (fcp !== undefined) kept.fcp_ms = fcp
  if (ttfb !== undefined) kept.ttfb_ms = ttfb
  return narrow(event, kept)
}

const desktopEvents = new Set(['desktop_api_error', 'desktop_main_error', 'desktop_process_gone'])
/** A route template from apps/api/generated/routes.json (`/api/workspaces/[workspaceId]/task-labels`): never a concrete id. */
const ROUTE_TEMPLATE = /^\/api(?:\/(?:[A-Za-z0-9._~-]{1,64}|\[{1,2}(?:\.{3})?[A-Za-z][A-Za-z0-9_]{0,63}\]{1,2})){1,16}$/
/** Its literal segments are route words, never an id, token or number that slipped in. */
function routeTemplate(value: string) {
  return ROUTE_TEMPLATE.test(value) && value.split('/').every(segment => segment.startsWith('[') || !(UUID_SEGMENT.test(segment) || LONG_TOKEN_SEGMENT.test(segment) || NUMERIC_ID_SEGMENT.test(segment) || /^\d+$/.test(segment)))
}
const httpMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
/** A short failure code such as `desktop_backend_unavailable`; never a message. */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/
const mainErrorSources = new Set(['uncaught_exception', 'unhandled_rejection'])
const processTypes = new Set(['renderer', 'gpu', 'utility', 'zygote', 'sandbox-helper', 'pepper-plugin', 'unknown'])
const processGoneReasons = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'])

/** The desktop main process's own reports: a refused or failed API call by
 * route template, method, status and code; a main-process error's class; a
 * child process that went away and why. Anything else they carry is dropped. */
function sanitizeDesktopEvent<T extends { event: string; properties: Record<string, unknown> }>(event: T): T | null {
  const props = event.properties
  const kept: Record<string, unknown> = {}
  if (event.event === 'desktop_api_error') {
    if (typeof props.route !== 'string' || !(props.route === 'unmatched' || routeTemplate(props.route))) return null
    if (typeof props.method !== 'string' || !httpMethods.has(props.method)) return null
    if (!Number.isInteger(props.status) || (props.status as number) < 100 || (props.status as number) > 599) return null
    Object.assign(kept, { route: props.route, method: props.method, status: props.status })
    if (typeof props.error_code === 'string' && ERROR_CODE.test(props.error_code)) kept.error_code = props.error_code
    return narrow(event, kept)
  }
  if (event.event === 'desktop_main_error') {
    if (typeof props.error_source !== 'string' || !mainErrorSources.has(props.error_source)) return null
    kept.error_source = props.error_source
    kept.error_name = typeof props.error_name === 'string' && EXCEPTION_TYPE.test(props.error_name) ? props.error_name : 'Error'
    return narrow(event, kept)
  }
  if (typeof props.reason !== 'string' || !processGoneReasons.has(props.reason)) return null
  kept.reason = props.reason
  kept.process_type = typeof props.process_type === 'string' && processTypes.has(props.process_type) ? props.process_type : 'unknown'
  return narrow(event, kept)
}

export function sanitizeAnalyticsEvent<T extends { event: string; properties: Record<string, unknown> }>(event: T | null): T | null {
  if (!event) return null
  if (event.event === '$exception') return sanitizeExceptionEvent(event)
  if (frontendRumEvents.has(event.event)) return sanitizeFrontendRumEvent(event)
  if (desktopEvents.has(event.event)) return sanitizeDesktopEvent(event)
  if (event.event !== '$snapshot' && !allowedEvents.has(event.event)) return null
  // rrweb masks the DOM before serialization (instrumentation-client.ts).
  // Its transport needs the opaque snapshot payload and session identifiers;
  // every other event goes through the narrow allowlist instead.
  if (event.event === '$snapshot') {
    const browserType = event.properties.$browser_type
    const classification = browserType === 'bot' || browserType === 'browser' ? { $browser_type: browserType } : {}
    const keys = new Set(['token', 'distinct_id', '$session_id', '$window_id', '$lib', '$lib_version', '$snapshot_bytes', '$snapshot_data'])
    const snapshot = { ...event, properties: { ...Object.fromEntries(Object.entries(event.properties).filter(([key]) => keys.has(key))), ...classification } }
    for (const key of ['$set', '$set_once', '$unset']) Reflect.deleteProperty(snapshot, key)
    return snapshot
  }
  return narrow(event)
}

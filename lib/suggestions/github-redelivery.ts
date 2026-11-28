import { createSign } from 'node:crypto'
import { githubAppEnvironmentConfig } from '@/lib/github/app-env'
import { isCloudEdition } from '@/lib/edition'
import { GITHUB_REDELIVERY_ORIGIN } from '@/lib/env/hosts'
import { CloudServiceError } from '@/lib/cloud-services/errors'
import { requestBudgetSignal } from '@/lib/request-budget'
import { boundedJson } from '../../cloudflare/bounded-json.mjs'

// GitHub's side of the hourly suggestions backfill. Mikka's GitHub App keeps a
// log of every webhook delivery it sent (three days). Deliveries that did not
// get a 2xx from app/api/webhooks/github are asked to be sent again; the
// redelivery goes through that same route, so ingestion and the externalId
// dedupe are unchanged. Nothing is re-read from GitHub itself.

const API = 'https://api.github.com'
/** How far back failed deliveries are redelivered. Longer than the hourly interval, so one missed run is covered. */
export const REDELIVERY_WINDOW_MS = 3 * 60 * 60 * 1000
/** At most this many redeliveries per run. */
export const REDELIVERY_LIMIT = 25
/** The events app/api/webhooks/github turns into suggestions; others are not worth redelivering. */
const SUGGESTION_EVENTS = new Set(['pull_request', 'issues', 'issue_comment', 'pull_request_review', 'pull_request_review_comment'])

/** One row of GET /app/hook/deliveries. */
export interface GitHubDelivery { id: string; guid: string; delivered_at: string; redelivery: boolean; status_code: number; event: string }

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString('base64url')
}

/** The JWT a GitHub App signs to call /app endpoints: RS256, issued a minute early for clock drift, valid under GitHub's 10-minute limit. */
export function githubAppJwt(appId: string, privateKey: string, now: Date = new Date()): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: appId }))
  // Keys pasted into a single-line secret often carry literal "\n".
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(privateKey.replace(/\\n/g, '\n'))
  return `${header}.${claims}.${base64url(signature)}`
}

const succeeded = (delivery: GitHubDelivery) => delivery.status_code >= 200 && delivery.status_code < 300

/**
 * The deliveries to send again: in the window, for an event that feeds
 * suggestions, and with no 2xx attempt for the same delivery guid (an
 * earlier redelivery may already have succeeded). One per guid, the latest
 * attempt, at most `limit`.
 */
export function failedDeliveries(deliveries: readonly GitHubDelivery[], since: Date, limit = REDELIVERY_LIMIT, allEvents = false): GitHubDelivery[] {
  const byGuid = new Map<string, GitHubDelivery[]>()
  for (const delivery of deliveries) byGuid.set(delivery.guid, [...byGuid.get(delivery.guid) ?? [], delivery])
  const failed: GitHubDelivery[] = []
  for (const attempts of byGuid.values()) {
    if (attempts.some(succeeded)) continue
    const latest = attempts.reduce((a, b) => new Date(b.delivered_at) > new Date(a.delivered_at) ? b : a)
    if (new Date(latest.delivered_at) < since || !allEvents && !SUGGESTION_EVENTS.has(latest.event)) continue
    failed.push(latest)
  }
  return failed.sort((a, b) => new Date(a.delivered_at).getTime() - new Date(b.delivered_at).getTime()).slice(0, limit)
}

/** The cursor in GitHub's `Link: <…?cursor=…>; rel="next"` header. */
export function nextCursor(link: string | null): string | null {
  const next = link?.split(',').find(part => /rel="next"/.test(part))
  const url = next?.match(/<([^>]+)>/)?.[1]
  return url ? new URL(url).searchParams.get('cursor') : null
}

export interface RedeliveryResult { configured: boolean; scanned: number; failed: number; redelivered: number; errors: number }

function brokerSummary(value: unknown, status: number): RedeliveryResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'configured,errors,failed,redelivered,scanned') {
    throw new CloudServiceError('cloud_unavailable', 'protocol')
  }
  const result = value as RedeliveryResult
  const counts = [result.scanned, result.failed, result.redelivered, result.errors]
  if (typeof result.configured !== 'boolean' || !counts.every(count => Number.isSafeInteger(count) && count >= 0)
    || result.scanned > 10_000 || result.failed > result.scanned
    || result.redelivered + result.errors !== Math.min(result.failed, REDELIVERY_LIMIT)
    || (result.configured ? (status !== (result.errors ? 502 : 200)) : (status !== 503 || counts.some(Boolean)))) {
    throw new CloudServiceError('cloud_unavailable', 'protocol')
  }
  return result
}

/** The existing environment binding owns App credentials, its window and each retry. */
async function redeliverThroughBroker(fetcher: typeof fetch, deadline: number): Promise<RedeliveryResult> {
  let response: Response
  try {
    const signal = requestBudgetSignal({ deadline: Math.min(deadline, Date.now() + 40_000) }, 40_000)
    response = await fetcher(GITHUB_REDELIVERY_ORIGIN + '/redeliver', {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
    })
  } catch (cause) { throw new CloudServiceError('cloud_unavailable', 'network', cause) }
  try {
    if (![200, 502, 503].includes(response.status)) throw new CloudServiceError('cloud_unavailable', 'response')
    return brokerSummary(await boundedJson(response, 1024), response.status)
  } catch (cause) {
    if (cause instanceof CloudServiceError) throw cause
    throw new CloudServiceError('cloud_unavailable', 'protocol', cause)
  } finally { await response.body?.cancel().catch(() => {}) }
}

/**
 * Official Cloud delegates to its existing private broker. Community Apps
 * redeliver failed suggestion webhooks from the last few hours, or report
 * unconfigured when their App ID or signing key is absent. Returns counts,
 * never payloads; a caller deadline bounds actual network and body reads.
 */
export async function redeliverFailedGitHubWebhooks({ now = new Date(), fetcher = fetch, env, deadline = Infinity }: { now?: Date; fetcher?: typeof fetch; env?: Record<string, string | undefined>; deadline?: number } = {}): Promise<RedeliveryResult> {
  // Official Cloud's API never loads App signing configuration; the private
  // named binding keeps the full 24h/all-event policy from the existing sweep.
  if (isCloudEdition(env)) return redeliverThroughBroker(fetcher, deadline)
  const result: RedeliveryResult = { configured: false, scanned: 0, failed: 0, redelivered: 0, errors: 0 }
  const config = env ? githubAppEnvironmentConfig(env) : await (await import('@/lib/github/app-config')).readGitHubAppConfig()
  const appId = config.id
  const privateKey = config.pem
  if (!appId || !privateKey) return result
  result.configured = true
  const headers = { authorization: `Bearer ${githubAppJwt(appId, privateKey, now)}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'mikka-suggestions-reconcile' }
  const signal = Number.isFinite(deadline) ? requestBudgetSignal({ deadline }, 40_000) : undefined
  const since = new Date(now.getTime() - REDELIVERY_WINDOW_MS)
  const deliveries: GitHubDelivery[] = []
  let cursor: string | null = null
  // Newest first; stop once a page reaches past the window.
  while (true) {
    const url = new URL(`${API}/app/hook/deliveries`)
    url.searchParams.set('per_page', '100')
    if (cursor) url.searchParams.set('cursor', cursor)
    signal?.throwIfAborted()
    const response = await fetcher(url, { headers, signal })
    if (!response.ok) throw new Error(`GitHub delivery log answered ${response.status}`)
    // GitHub delivery IDs exceed Number.MAX_SAFE_INTEGER; keep the original JSON digits.
    const rows = JSON.parse(await response.text(), (key, value, context?: { source: string }) =>
      key === 'id' && typeof value === 'number' ? context!.source : value,
    ) as GitHubDelivery[]
    deliveries.push(...rows)
    cursor = nextCursor(response.headers.get('link'))
    if (!cursor || !rows.length || rows.some(row => new Date(row.delivered_at) < since)) break
  }
  result.scanned = deliveries.length
  const failed = failedDeliveries(deliveries, since, Infinity)
  result.failed = failed.length
  for (const delivery of failed.slice(0, REDELIVERY_LIMIT)) {
    signal?.throwIfAborted()
    const response = await fetcher(`${API}/app/hook/deliveries/${delivery.id}/attempts`, { method: 'POST', headers, signal })
    if (response.ok) result.redelivered++
    else result.errors++
  }
  console.log(`GitHub redelivery: scanned ${result.scanned}, failed ${result.failed}, redelivered ${result.redelivered}, errors ${result.errors}`)
  return result
}

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sanitizeAnalyticsEvent } from '../../../../lib/analytics-policy'
import type { BundledTelemetryState } from '@mikka/protocol/bridge'

// Desktop usage events and error reports, sent from main because the
// renderer's CSP reaches only the app origin. Every event, whoever made it,
// passes the web's allowlist (lib/analytics-policy.ts) after main adds its tags,
// so an event or property the web would drop never leaves here either.
//
// Nothing is sent when the build has no PostHog project (self-hosted and
// community builds), while the current account is on a self-hosted server, or
// once the person turns sharing off in Settings. The choice is remembered in
// telemetry.json beside the session vault, with the anonymous id used before
// sign-in; neither is a credential.

export type TelemetryConfig = {
  /** The PostHog project's public ingestion key; empty means this build sends nothing. */
  key: string
  host: string
  version: string
  flavor: 'prod' | 'dev'
  publicSha: string
  overlaySha: string
}

export type TelemetryIdentity = {
  /** The signed-in account's user id, the web's distinct id for the same person. */
  userId(): string | null
  /** Whether the current account's server is the build's own (Mikka Cloud). */
  cloud(): boolean
}

type Sender = (url: string, init: RequestInit) => Promise<Response>
type QueuedEvent = { event: string; properties: Record<string, unknown>; timestamp: string }
type Preferences = { enabled: boolean; anonymousId: string }

const FLUSH_AT = 20
const FLUSH_AFTER_MS = 10_000
const QUEUE_LIMIT = 200
/** The same failure is worth one report per window, not one per retry. */
const REPEAT_WINDOW_MS = 10 * 60_000
/** At most this many of main's own reports in any hour, however long the app runs. */
const REPORT_LIMIT = 200
/** At most this many of the renderer's events in any hour: a page stuck in an
 * error loop or a hostile one cannot turn the person's machine into a firehose.
 * Counted apart from main's reports, so it cannot crowd them out. */
const RENDERER_EVENT_LIMIT = 500
const REPORT_LIMIT_WINDOW_MS = 60 * 60_000

/**
 * Desktop error reports carry the error's class, never its message (the
 * "name/code only" logging rule): the web's allowlist keeps a redacted message
 * for `$exception`, so on desktop each entry's value becomes its type. The
 * in-app stack frames (function, bundled file, line, column) stay for grouping.
 */
export function withoutErrorMessages<T extends { event: string; properties: Record<string, unknown> }>(event: T): T {
  if (event.event !== '$exception' || !Array.isArray(event.properties.$exception_list)) return event
  const list = (event.properties.$exception_list as Record<string, unknown>[]).map(entry => ({ ...entry, value: entry.type }))
  return { ...event, properties: { ...event.properties, $exception_list: list } }
}

export class DesktopTelemetry {
  private preferences: Preferences | null = null
  private loading: Promise<Preferences> | null = null
  private readonly queue: QueuedEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly reported = new Map<string, number>()
  /** Report times in the last hour, oldest first. */
  private readonly reports: number[] = []
  /** The renderer's sent-event times in the last hour, oldest first. */
  private readonly rendererEvents: number[] = []

  constructor(private readonly config: TelemetryConfig, private readonly identity: TelemetryIdentity, private readonly options: {
    file: string
    send?: Sender
    now?: () => number
  }) {}

  private async load(): Promise<Preferences> {
    if (this.preferences) return this.preferences
    this.loading ??= (async () => {
      let stored: Partial<Preferences> = {}
      try { stored = JSON.parse(await readFile(this.options.file, 'utf8')) as Partial<Preferences> } catch { /* First run, or an unreadable file: defaults. */ }
      const preferences: Preferences = {
        enabled: stored.enabled !== false,
        anonymousId: typeof stored.anonymousId === 'string' && /^[0-9a-f-]{36}$/.test(stored.anonymousId) ? stored.anonymousId : randomUUID(),
      }
      if (stored.anonymousId !== preferences.anonymousId) await this.save(preferences).catch(() => {})
      this.preferences = preferences
      return preferences
    })()
    return this.loading
  }

  private async save(preferences: Preferences): Promise<void> {
    await mkdir(dirname(this.options.file), { recursive: true })
    const temporary = `${this.options.file}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(preferences), { mode: 0o600 })
    await rename(temporary, this.options.file)
  }

  /** Whether this build and account can send at all, and the person's choice. */
  async state(): Promise<BundledTelemetryState> {
    const { enabled } = await this.load()
    return { available: Boolean(this.config.key) && this.identity.cloud(), enabled }
  }

  async setEnabled(enabled: boolean): Promise<BundledTelemetryState> {
    if (typeof enabled !== 'boolean') throw new TypeError('telemetry_choice_invalid')
    const preferences = { ...await this.load(), enabled }
    await this.save(preferences)
    this.preferences = preferences
    if (!enabled) this.queue.length = 0
    return this.state()
  }

  /** One event from the renderer, at most RENDERER_EVENT_LIMIT an hour. Never throws and never waits on the network. */
  capture(event: unknown, properties: unknown = {}): void {
    this.enqueue(event, properties, this.rendererEvents, RENDERER_EVENT_LIMIT)
  }

  /**
   * Queues one event that passed the allowlist. With a budget, the event counts
   * against it and is dropped once the hour's allowance is spent; only events
   * that would be sent count, so nothing is spent while sharing is off.
   */
  private enqueue(event: unknown, properties: unknown, budget?: number[], limit = 0): void {
    if (!this.config.key || typeof event !== 'string' || event.length > 100) return
    const input = properties && typeof properties === 'object' && !Array.isArray(properties) ? properties as Record<string, unknown> : {}
    void this.load().then(preferences => {
      if (!preferences.enabled || !this.identity.cloud()) return
      const distinctId = this.identity.userId() ?? preferences.anonymousId
      // Main's tags win over anything the renderer put under the same names.
      const sanitized = sanitizeAnalyticsEvent({ event, properties: {
        ...input,
        token: this.config.key, distinct_id: distinctId, $process_person_profile: this.identity.userId() !== null,
        $lib: 'mikka-desktop', $lib_version: this.config.version,
        app: 'mikka', runtime: 'electron', environment: this.config.flavor === 'prod' ? 'production' : 'development',
        platform: 'desktop', app_version: this.config.version,
        ...(this.config.publicSha ? { public_sha: this.config.publicSha } : {}),
        ...(this.config.overlaySha ? { overlay_sha: this.config.overlaySha } : {}),
      } })
      if (!sanitized) return
      if (budget) {
        const now = this.now()
        while (budget.length && now - budget[0]! >= REPORT_LIMIT_WINDOW_MS) budget.shift()
        if (budget.length >= limit) return
        budget.push(now)
      }
      if (this.queue.length >= QUEUE_LIMIT) this.queue.shift()
      this.queue.push({ ...withoutErrorMessages(sanitized), timestamp: new Date(this.now()).toISOString() })
      if (this.queue.length >= FLUSH_AT) void this.flush()
      else this.timer ??= setTimeout(() => { void this.flush() }, FLUSH_AFTER_MS)
    }).catch(() => {})
  }

  /**
   * A report main makes itself, at most once per kind in the repeat window and
   * REPORT_LIMIT an hour. Nothing is recorded or counted while nothing would be
   * sent (no key, a self-hosted account, sharing off), so turning sharing on
   * later starts with a full allowance and no stale suppression.
   */
  private report(key: string, event: string, properties: Record<string, unknown>): void {
    if (!this.config.key) return
    void this.load().then(preferences => {
      if (!preferences.enabled || !this.identity.cloud()) return
      const now = this.now()
      while (this.reports.length && now - this.reports[0]! >= REPORT_LIMIT_WINDOW_MS) this.reports.shift()
      for (const [kind, at] of this.reported) if (now - at >= REPEAT_WINDOW_MS) this.reported.delete(kind)
      if (this.reported.has(key) || this.reports.length >= REPORT_LIMIT) return
      this.reported.set(key, now)
      this.reports.push(now)
      this.enqueue(event, properties)
    }).catch(() => {})
  }

  /** A renderer API call main refused or the server failed, by route template: never the path's ids. */
  apiFailure(failure: { route: string; method: string; status: number; code?: string }): void {
    this.report(`api:${failure.route}:${failure.method}:${failure.status}:${failure.code ?? ''}`, 'desktop_api_error', {
      route: failure.route, method: failure.method, status: failure.status, ...(failure.code ? { error_code: failure.code } : {}),
    })
  }

  /** A main-process error: its class only, never the message or stack. */
  mainError(error: unknown, source: 'uncaught_exception' | 'unhandled_rejection'): void {
    const name = error instanceof Error ? error.name : 'Error'
    this.report(`main:${source}:${name}`, 'desktop_main_error', { error_name: name, error_source: source })
  }

  /** A renderer, GPU or utility process that went away, and Electron's reason. */
  processGone(processType: string, reason: string): void {
    if (reason === 'clean-exit') return
    this.report(`gone:${processType}:${reason}`, 'desktop_process_gone', { process_type: processType, reason })
  }

  /** Sends what is queued; a failed send is dropped rather than retried. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.queue.length || !this.config.key) return
    const batch = this.queue.splice(0, this.queue.length)
    const send = this.options.send ?? ((url, init) => fetch(url, init))
    try {
      await send(`${this.config.host.replace(/\/$/, '')}/batch/`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', cache: 'no-store', credentials: 'omit',
        body: JSON.stringify({ api_key: this.config.key, batch }), signal: AbortSignal.timeout(10_000),
      })
    } catch {
      // Telemetry must never disturb the app; the next events start a fresh batch.
    }
  }

  private now(): number { return this.options.now?.() ?? Date.now() }
}

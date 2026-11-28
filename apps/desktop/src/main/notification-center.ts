// System notifications and the Dock/taskbar badge, independent of Electron so
// the dedupe and rate limits are unit-testable.

import { desktopBadgeCount, desktopNotification, type DesktopNotificationAccess } from '@mikka/protocol/bridge'

/** What the OS said when it was asked to show one: shown, or the error it gave instead. */
export interface NotificationOutcome {
  shown(): void
  failed(error: string): void
}

export interface NotificationSink {
  isSupported(): boolean
  show(title: string, body: string, onClick: () => void, outcome?: NotificationOutcome): void
  setBadge(count: number): void
}

/**
 * An error from the OS that means notifications for Mikka are switched off (macOS:
 * UNErrorCodeNotificationsNotAllowed; Windows: the toast notifier is disabled), not a one-off failure.
 */
export function deniedByOs(error: string): boolean {
  return /not\s*allowed|not\s*authori[sz]ed|authori[sz]ation|permission|denied|disabled|turned off/i.test(error)
}

const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 5
const MAX_REMEMBERED = 500

export class NotificationCenter {
  private readonly shown = new Set<string>()
  private recent: number[] = []
  private currentAccess: DesktopNotificationAccess = 'unknown'

  constructor(
    private readonly sink: NotificationSink,
    private readonly deliver: (href: string) => void,
    private readonly now: () => number = Date.now,
    /** Called when the OS access main has seen changes (the page shows Capy's "notifications are off" banner). */
    private readonly accessChanged: (access: DesktopNotificationAccess) => void = () => {}
  ) {}

  /** 'granted' once the OS showed one, 'denied' once it refused one for being switched off, else 'unknown'. */
  access(): DesktopNotificationAccess {
    return this.currentAccess
  }

  private setAccess(next: DesktopNotificationAccess): void {
    if (next === this.currentAccess) return
    this.currentAccess = next
    this.accessChanged(next)
  }

  /** Shows one notification per `id`, at most five a minute. */
  show(raw: unknown): void {
    const notification = desktopNotification.parse(raw)
    if (this.shown.has(notification.id)) return
    if (!this.sink.isSupported()) return
    const now = this.now()
    this.recent = this.recent.filter(at => now - at < WINDOW_MS)
    if (this.recent.length >= MAX_PER_WINDOW) return
    this.recent.push(now)
    this.shown.add(notification.id)
    if (this.shown.size > MAX_REMEMBERED) {
      const oldest = this.shown.values().next().value
      if (oldest !== undefined) this.shown.delete(oldest)
    }
    this.sink.show(notification.title, notification.body, () => this.deliver(notification.href), {
      shown: () => this.setAccess('granted'),
      failed: error => { if (deniedByOs(error)) this.setAccess('denied') },
    })
  }

  setBadge(raw: unknown): void {
    this.sink.setBadge(desktopBadgeCount.parse(raw))
  }
}

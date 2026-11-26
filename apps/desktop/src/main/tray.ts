// The tray / menu bar menu (decision C6), as Capy's tray (`main.js` Hke / Wke): recent threads with View all
// threads…, New Thread, then Quit; plus how many threads wait for the person and Open Mikka (Codex's tray
// "Open {appName}"). Kept free of Electron so the template is unit-testable; index.ts owns the Tray.

import type { MenuItemConstructorOptions } from 'electron'
import type { DesktopTrayState } from '@mikka/protocol/bridge'

/** Capy lists five recent threads (`Uke = 5`) and cuts a title at 48 characters. */
export const TRAY_THREADS = 5
const TITLE_MAX = 48

export function trayCopy(locale: string) {
  return locale.toLowerCase().startsWith('zh')
    ? {
      tooltip: 'Mikka',
      waiting: (count: number) => `${count} 个线程在等你`,
      recent: '最近线程',
      loading: '正在加载线程…',
      signIn: '登录后查看线程',
      none: '没有最近的线程',
      untitled: '未命名线程',
      viewAll: '查看全部线程…',
      newThread: '新建线程',
      open: '打开 Mikka',
      quit: '退出 Mikka',
    }
    : {
      tooltip: 'Mikka',
      waiting: (count: number) => `${count} ${count === 1 ? 'thread needs' : 'threads need'} you`,
      recent: 'Recent threads',
      loading: 'Loading threads…',
      signIn: 'Sign in to see your threads',
      none: 'No recent threads',
      untitled: 'Untitled thread',
      viewAll: 'View all threads…',
      newThread: 'New Thread',
      open: 'Open Mikka',
      quit: 'Quit Mikka',
    }
}

export interface TrayActions {
  /** Shows the main window on an in-app page. */
  openHref(href: string): void
  newThread(): void
  openApp(): void
}

export const INBOX_HREF = '/?section=inbox'
export const THREADS_HREF = '/?section=threads'

export function trayTitle(title: string, untitled: string): string {
  const name = title.trim() || untitled
  return name.length > TITLE_MAX ? `${name.slice(0, TITLE_MAX - 1)}…` : name
}

export function trayMenu(state: DesktopTrayState, locale: string, actions: TrayActions): MenuItemConstructorOptions[] {
  const copy = trayCopy(locale)
  const threads = state.threads?.slice(0, TRAY_THREADS) ?? null
  const recent: MenuItemConstructorOptions[] = !state.signedIn
    ? [{ label: copy.signIn, enabled: false }]
    : threads === null
      ? [{ label: copy.loading, enabled: false }]
      : threads.length === 0 && !state.hasMore
        ? [{ label: copy.none, enabled: false }]
        : [
          { label: copy.recent, enabled: false },
          ...threads.map(thread => ({ label: trayTitle(thread.title, copy.untitled), click: () => actions.openHref(thread.href) })),
          ...(state.hasMore || (state.threads?.length ?? 0) > threads.length ? [{ label: copy.viewAll, click: () => actions.openHref(THREADS_HREF) }] : []),
        ]
  return [
    ...(state.signedIn && state.waiting > 0 ? [{ label: copy.waiting(state.waiting), click: () => actions.openHref(INBOX_HREF) }, { type: 'separator' } as const] : []),
    ...recent,
    { type: 'separator' },
    { label: copy.newThread, click: actions.newThread },
    { type: 'separator' },
    { label: copy.open, click: actions.openApp },
    { type: 'separator' },
    { label: copy.quit, role: 'quit' },
  ]
}

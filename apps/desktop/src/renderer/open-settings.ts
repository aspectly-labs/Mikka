import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'
import { withBasePath } from '@/lib/base-path'
import type { BrowserSettingsSection, SettingsHandoff } from '@/lib/platform/open-settings'

export type { BrowserSettingsSection, SettingsHandoff }

export function openSettingsInBrowser(section: BrowserSettingsSection, target?: MikkaWindow | null) {
  const canonical = section === 'integrations' ? 'connections' : section
  return openPathInBrowser(withBasePath(`/settings?section=${canonical}`), target)
}

export function openCurrentPageInBrowser(target: MikkaWindow | null | undefined = window as MikkaWindow) {
  if (!target) return Promise.resolve<SettingsHandoff>('browser')
  return openPathInBrowser(`${target.location.pathname}${target.location.search}${target.location.hash}`, target)
}

/** The system browser opens the configured backend, never the app's local scheme. */
export async function openPathInBrowser(path: string, target: MikkaWindow | null | undefined = window as MikkaWindow): Promise<SettingsHandoff> {
  const bridge = target && bridgeFromWindow(target)
  if (!bridge) return 'browser'
  if (!bridge.app.openExternal || !bridge.app.serverUrl) return 'unsupported'
  const base = new URL(bridge.app.serverUrl)
  const url = new URL(path, base.origin)
  if (url.origin !== base.origin || url.username || url.password) return 'unsupported'
  await bridge.app.openExternal(url.href)
  return 'desktop'
}

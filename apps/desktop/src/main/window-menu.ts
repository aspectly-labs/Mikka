// The native application menu, as Capy's and Codex's desktop menus (spec: research/spec-desktop.md §1–2): the app menu with Settings…, File with
// New Thread, New Window and the tab commands, Edit, View, History, Window with tab switching, and Help.
// Tab and history items carry accelerators, so ⌘W, ⌘T, ⇧⌘T, ⌘1–9 and ⌘[ / ⌘] work while focus is in the
// composer or any other text field: main sends the command to the focused window (IPC.appMenuCommand) instead
// of the page listening for keys it never sees once a field has focus. Kept free of Electron so the
// template is unit-testable; index.ts builds it with Menu.buildFromTemplate.

import type { MenuItemConstructorOptions } from 'electron'
import type { DesktopMenuCommand } from '@mikka/protocol/bridge'

/** The native shortcut/action used to open another authenticated Mikka window. */
export interface NewWindowMenuItem {
  label: string
  accelerator: string
  click(): void
}

export interface DesktopMenuCopy {
  file: string
  edit: string
  view: string
  history: string
  window: string
  help: string
  newWindow: string
  newThread: string
  newTab: string
  duplicateTab: string
  copyUrl: string
  reopenClosedTab: string
  closeTab: string
  closeOtherTabs: string
  closeWindow: string
  addComputer: string
  settings: string
  checkForUpdates: string
  reload: string
  back: string
  forward: string
  nextTab: string
  previousTab: string
  tab: (index: number) => string
  website: string
  showLogs: string
}

export function menuCopy(locale: string): DesktopMenuCopy {
  return locale.toLowerCase().startsWith('zh')
    ? {
      file: '文件',
      edit: '编辑',
      view: '视图',
      history: '历史',
      window: '窗口',
      help: '帮助',
      newWindow: '新建窗口',
      newThread: '新建线程',
      newTab: '新建标签页',
      duplicateTab: '复制标签页',
      copyUrl: '复制链接',
      reopenClosedTab: '重新打开关闭的标签页',
      closeTab: '关闭标签页',
      closeOtherTabs: '关闭其他标签页',
      closeWindow: '关闭窗口',
      addComputer: '添加电脑…',
      settings: '设置…',
      checkForUpdates: '检查更新…',
      reload: '重新加载',
      back: '后退',
      forward: '前进',
      nextTab: '下一个标签页',
      previousTab: '上一个标签页',
      tab: index => `标签页 ${index}`,
      website: 'Mikka 网站',
      showLogs: '查看日志',
    }
    : {
      file: 'File',
      edit: 'Edit',
      view: 'View',
      history: 'History',
      window: 'Window',
      help: 'Help',
      newWindow: 'New Window',
      newThread: 'New Thread',
      newTab: 'New Tab',
      duplicateTab: 'Duplicate Tab',
      copyUrl: 'Copy URL',
      reopenClosedTab: 'Reopen Closed Tab',
      closeTab: 'Close Tab',
      closeOtherTabs: 'Close Other Tabs',
      closeWindow: 'Close Window',
      addComputer: 'Add a Computer…',
      settings: 'Settings…',
      checkForUpdates: 'Check for Updates…',
      reload: 'Reload',
      back: 'Back',
      forward: 'Forward',
      nextTab: 'Next Tab',
      previousTab: 'Previous Tab',
      tab: index => `Tab ${index}`,
      website: 'Mikka Website',
      showLogs: 'Show Logs',
    }
}

export function newWindowMenuItem(openWindow: () => void, locale = 'en'): NewWindowMenuItem {
  return {
    label: menuCopy(locale).newWindow,
    accelerator: 'CommandOrControl+Shift+N',
    click: openWindow,
  }
}

/**
 * Accelerators, as Capy's (`main.js` lNe) where Mikka has the command. New Thread is ⇧⌘O as in Capy and
 * ChatGPT, because ⌘N is the Devices page's Add device and ⇧⌘N already opens a new window.
 */
export const MENU_ACCELERATORS = {
  settings: 'CommandOrControl+,',
  newThread: 'CommandOrControl+Shift+O',
  newTab: 'CommandOrControl+T',
  reopenClosedTab: 'CommandOrControl+Shift+T',
  closeTab: 'CommandOrControl+W',
  closeOtherTabs: 'CommandOrControl+Alt+W',
  copyUrl: 'CommandOrControl+L',
  copyUrlAlias: 'CommandOrControl+Shift+C',
  closeWindow: 'CommandOrControl+Shift+W',
  back: 'CommandOrControl+[',
  forward: 'CommandOrControl+]',
  nextTab: 'Control+Tab',
  previousTab: 'Control+Shift+Tab',
  nextTabAlias: 'CommandOrControl+Alt+Right',
  previousTabAlias: 'CommandOrControl+Alt+Left',
} as const

export interface ApplicationMenuOptions {
  platform: NodeJS.Platform
  locale: string
  appName: string
  /** Packaged builds check for updates; development builds also get DevTools. */
  packaged: boolean
  /** Sends a command to the focused Mikka window (IPC.appMenuCommand). */
  command(command: DesktopMenuCommand): void
  /** ⌘W: closes the main window's tab, or a child window. */
  closeTab(): void
  newWindow(): void
  reload(): void
  checkForUpdates(): void
  openWebsite(): void
  showLogs(): void
  /** View's zoom items (index.ts ZOOM_ITEMS). */
  zoomItems: MenuItemConstructorOptions[]
}

export function applicationMenu(options: ApplicationMenuOptions): MenuItemConstructorOptions[] {
  const copy = menuCopy(options.locale)
  const mac = options.platform === 'darwin'
  const send = (command: DesktopMenuCommand) => () => options.command(command)
  // A second, hidden item gives one command a second shortcut (Electron allows one accelerator per item).
  const alias = (item: MenuItemConstructorOptions, accelerator: string): MenuItemConstructorOptions =>
    ({ ...item, id: item.id ? `${item.id}-alias` : undefined, accelerator, visible: false, acceleratorWorksWhenHidden: true })
  const settings: MenuItemConstructorOptions = { id: 'mikka-settings', label: copy.settings, accelerator: MENU_ACCELERATORS.settings, click: send({ type: 'settings.open' }) }
  const updates: MenuItemConstructorOptions[] = options.packaged ? [{ id: 'mikka-check-for-updates', label: copy.checkForUpdates, click: options.checkForUpdates }] : []
  const copyUrl: MenuItemConstructorOptions = { id: 'mikka-copy-url', label: copy.copyUrl, accelerator: MENU_ACCELERATORS.copyUrl, click: send({ type: 'tab.copyUrl' }) }
  const nextTab: MenuItemConstructorOptions = { id: 'mikka-next-tab', label: copy.nextTab, accelerator: MENU_ACCELERATORS.nextTab, click: send({ type: 'tab.next' }) }
  const previousTab: MenuItemConstructorOptions = { id: 'mikka-previous-tab', label: copy.previousTab, accelerator: MENU_ACCELERATORS.previousTab, click: send({ type: 'tab.previous' }) }
  // ⌘1–⌘8 open that tab and ⌘9 the last one, as in browsers; listed once, hidden, like Capy's.
  const selectTabs: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, offset) => {
    const index = offset + 1
    return { id: `mikka-select-tab-${index}`, label: copy.tab(index), accelerator: `CommandOrControl+${index}`, visible: false, acceleratorWorksWhenHidden: true, click: send({ type: 'tab.select', index }) }
  })
  return [
    ...(mac ? [{
      label: options.appName,
      submenu: [
        { role: 'about' },
        ...updates,
        { type: 'separator' },
        settings,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    } satisfies MenuItemConstructorOptions] : []),
    {
      label: copy.file,
      submenu: [
        { id: 'mikka-new-thread', label: copy.newThread, accelerator: MENU_ACCELERATORS.newThread, click: send({ type: 'thread.new' }) },
        { id: 'mikka-add-computer', label: copy.addComputer, click: send({ type: 'computer.add' }) },
        { type: 'separator' },
        { id: 'mikka-new-window', ...newWindowMenuItem(options.newWindow, options.locale) },
        { id: 'mikka-new-tab', label: copy.newTab, accelerator: MENU_ACCELERATORS.newTab, click: send({ type: 'tab.new' }) },
        { id: 'mikka-duplicate-tab', label: copy.duplicateTab, click: send({ type: 'tab.duplicate' }) },
        copyUrl,
        alias(copyUrl, MENU_ACCELERATORS.copyUrlAlias),
        { type: 'separator' },
        { id: 'mikka-reopen-tab', label: copy.reopenClosedTab, accelerator: MENU_ACCELERATORS.reopenClosedTab, click: send({ type: 'tab.reopen' }) },
        { id: 'mikka-close-tab', label: copy.closeTab, accelerator: MENU_ACCELERATORS.closeTab, click: () => options.closeTab() },
        { id: 'mikka-close-other-tabs', label: copy.closeOtherTabs, accelerator: MENU_ACCELERATORS.closeOtherTabs, click: send({ type: 'tab.closeOthers' }) },
        { role: 'close', label: copy.closeWindow, accelerator: MENU_ACCELERATORS.closeWindow },
        ...(mac ? [] : [{ type: 'separator' } as const, settings, { type: 'separator' } as const, { role: 'quit', accelerator: 'Control+Q' } as const]),
      ],
    },
    {
      label: copy.edit,
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: copy.view,
      submenu: [
        { label: copy.reload, accelerator: 'CommandOrControl+R', click: options.reload },
        ...(mac ? [{ role: 'forceReload' } as const] : []),
        ...(options.packaged ? [] : [{ role: 'toggleDevTools' } as const]),
        { type: 'separator' },
        ...options.zoomItems,
        ...(mac ? [{ type: 'separator' } as const, { role: 'togglefullscreen' } as const] : []),
      ],
    },
    {
      label: copy.history,
      submenu: [
        { id: 'mikka-back', label: copy.back, accelerator: MENU_ACCELERATORS.back, click: send({ type: 'history.back' }) },
        { id: 'mikka-forward', label: copy.forward, accelerator: MENU_ACCELERATORS.forward, click: send({ type: 'history.forward' }) },
      ],
    },
    {
      label: copy.window,
      submenu: [
        ...(mac ? [{ role: 'minimize' } as const, { role: 'zoom' } as const, { type: 'separator' } as const] : []),
        nextTab,
        alias(nextTab, MENU_ACCELERATORS.nextTabAlias),
        previousTab,
        alias(previousTab, MENU_ACCELERATORS.previousTabAlias),
        ...selectTabs,
        ...(mac ? [{ type: 'separator' } as const, { role: 'front' } as const] : []),
      ],
    },
    {
      role: 'help',
      label: copy.help,
      submenu: [
        { id: 'mikka-website', label: copy.website, click: options.openWebsite },
        { id: 'mikka-show-logs', label: copy.showLogs, click: options.showLogs },
        ...(mac ? [] : [{ type: 'separator' } as const, ...updates]),
      ],
    },
  ]
}

/** Every accelerator the template binds, for the tests that keep two items from claiming one shortcut. */
export function menuAccelerators(template: readonly MenuItemConstructorOptions[]): string[] {
  const found: string[] = []
  const walk = (items: readonly MenuItemConstructorOptions[]) => {
    for (const item of items) {
      if (typeof item.accelerator === 'string') found.push(item.accelerator)
      if (Array.isArray(item.submenu)) walk(item.submenu)
    }
  }
  walk(template)
  return found
}

/** The window's answer to "Mikka is not responding" (as Capy's): wait, reload, show logs or quit. */
export function unresponsiveCopy(locale: string) {
  return locale.toLowerCase().startsWith('zh')
    ? { message: 'Mikka 没有响应', detail: '可以继续等待，或者重新加载窗口。', buttons: ['继续等待', '重新加载', '查看日志', '退出'] }
    : { message: 'Mikka is not responding', detail: 'You can keep waiting, or reload the window.', buttons: ['Keep Waiting', 'Reload', 'Show Logs', 'Quit'] }
}

export type UnresponsiveChoice = 'wait' | 'reload' | 'logs' | 'quit'
export function unresponsiveChoice(response: number): UnresponsiveChoice {
  return (['wait', 'reload', 'logs', 'quit'] as const)[response] ?? 'wait'
}

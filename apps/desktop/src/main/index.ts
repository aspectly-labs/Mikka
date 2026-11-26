// Electron main: one window on the shared web UI, plus the native abilities
// the UI reads through `window.mikka`. The renderer is treated as untrusted;
// every privileged call goes through the validated IPC surface in `./bridge`.

import { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, nativeTheme, net, powerSaveBlocker, protocol, safeStorage, session, shell, webContents } from 'electron'
import { autoUpdater } from 'electron-updater'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { IPC, BUNDLED_IPC } from '@mikka/protocol/ipc'

import { AppSettings } from './app-settings'
import { registerBridge } from './bridge'
import { localDeviceStatus, localQuota, watchLocalRunActivity } from './daemon'
import { connectForUpdate, updateLocalDaemon } from './daemon-update'
import { readLocalDeviceAccount, readLocalDeviceOwner } from './local-setup'
import { AppLoadState, offlineReason, offlineRetryDelay } from './offline'
import { startLoopbackAuth, type LoopbackAuthServer } from './loopback'
import { startReturnListener, type ReturnListener } from './return-listener'
import { catchClaudeCallback } from './subscription-callback'
import { NotificationCenter } from './notification-center'
import { appExternalUrl, desktopAuthState, externalUrl, isTrustedFrame, navigationDecision } from './security'
import { Updates, updateCopy, updateFailure } from './updates'
import { UpdateGate, gateCopy, gateView, type GateState } from './launch-update'
import { HOSTED_API_HEADERS, meetsMinimumVersion } from '@mikka/protocol/version'
import { desktopTrayState } from '@mikka/protocol/bridge'
import { windowAppearance } from './window-appearance'
import { windowKindArgument } from '../window-kind'
import { RENDERER_ORIGIN, RENDERER_URL } from './bundled-policy'
import { bundledProtocol } from './bundled-protocol'
import { BundledAuth } from './bundled-auth'
import { notifyBundledSessionChange } from './bundled-session-change'
import { BundledLive } from './bundled-live'
import { BundledViewer } from './bundled-viewer'
import { registerBundledBridge } from './bundled-bridge'
import { SessionVault } from './session-vault'
import { ServerDirectory } from './server-directory'
import { BundledServers } from './bundled-servers'
import { AppLinks, appLinkFromArgv, appLinkScheme } from './app-link'
import { pickRepo } from './repo-picker'
import { agentLogins } from './agent-logins'
import { openBundledWebPage } from './bundled-web'
import { applicationMenu, unresponsiveChoice, unresponsiveCopy } from './window-menu'
import type { DesktopMenuCommand, DesktopNotificationAccess, DesktopTrayState } from '@mikka/protocol/bridge'
import { guardAppAction, closeWindowTarget } from './window-actions'
import { trayCopy, trayMenu } from './tray'
import { TRAY_ICON_1X, TRAY_ICON_2X } from './tray-icon'
import { markStartup } from '../startup'

const APP_URL = __MIKKA_APP_URL__
const APP_VERSION = __MIKKA_APP_VERSION__
const FLAVOR = __MIKKA_FLAVOR__
const APP_ORIGIN = new URL(APP_URL).origin
const BUNDLED = process.env.MIKKA_DESKTOP_RENDERER !== 'hosted'
const PARTITION = `${FLAVOR === 'dev' ? 'persist:mikka-dev' : 'persist:mikka'}${BUNDLED ? '-bundled' : ''}`
const PAGE_URL = BUNDLED ? RENDERER_URL : APP_URL
const PAGE_ORIGIN = BUNDLED ? RENDERER_ORIGIN : APP_ORIGIN

// Custom schemes need this explicit opt-in to retain V8's normal compiled-code
// cache across launches, as the hosted http(s) renderer already does.
protocol.registerSchemesAsPrivileged([{ scheme: 'mikka', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }])

app.setName(FLAVOR === 'dev' ? 'Mikka Dev' : 'Mikka')
// Dev and production never share keychain ciphertext or Chromium state.
const profile = process.env.MIKKA_USER_DATA_DIR
if (profile && isAbsolute(profile)) app.setPath('userData', profile)
else if (FLAVOR === 'dev') app.setPath('userData', join(app.getPath('appData'), 'Mikka Dev'))
if (process.platform === 'win32') app.setAppUserModelId('com.aspectlylabs.mikka')
app.enableSandbox()

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', event => event.preventDefault())
})

let mainWindow: BrowserWindow | null = null
let pendingClick: string | null = null
let retrying: NodeJS.Timeout | null = null
let authServer: LoopbackAuthServer | null = null
let authTimer: NodeJS.Timeout | null = null
let bundledAuth: BundledAuth | null = null
let bundledLive: BundledLive | null = null
let bundledViewer: BundledViewer | null = null
/** The server the open page was loaded for; its preload reads `app.serverUrl` once. */
let shownServer: string | null = null
let gateWindow: BrowserWindow | null = null
// A browser sign-in ends on a page that opens this app's link; the system then
// brings the app forward, which macOS does not let the app do by itself.
const appLinks = new AppLinks(appLinkScheme(FLAVOR))

function bringToFront(): void {
  if (gateWindow && !gateWindow.isDestroyed()) { gateWindow.show(); gateWindow.focus(); return }
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (app.isReady()) createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  // Opened by the person's click in the browser, so taking the front is expected.
  if (process.platform === 'darwin') app.focus({ steal: true })
  mainWindow.focus()
}

// macOS delivers an opened link here, before `ready` on a cold start. A link
// this process did not hand out (or one that expired) is ignored.
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (appLinks.accepts(url)) bringToFront()
})

function closeAuthServer(): void {
  if (authTimer) { clearTimeout(authTimer); authTimer = null }
  if (authServer) { authServer.close(); authServer = null }
}

/**
 * Starts a one-shot HTTP listener bound to 127.0.0.1 and returns its callback.
 * The renderer registers that callback with the web app before opening the
 * browser, so the token can only be delivered to this process. The app link
 * on its last page only brings the window forward; it carries no credential.
 */
async function prepareAuth(rawState: unknown): Promise<string> {
  const state = desktopAuthState(rawState)
  if (!state) throw new Error('prepareAuth needs a desktop nonce')
  closeAuthServer()
  const listener = await startLoopbackAuth({
    state,
    appUrl: APP_URL,
    link: appLinks.issue(),
    onFinish: finish => {
      authServer = null
      if (authTimer) { clearTimeout(authTimer); authTimer = null }
      if (!mainWindow || mainWindow.isDestroyed()) return
      bringToFront()
      void mainWindow.loadURL(finish)
    },
  })
  authServer = listener
  authTimer = setTimeout(closeAuthServer, 10 * 60_000)
  return listener.callback
}

let returnListener: ReturnListener | null = null
let returnTimer: NodeJS.Timeout | null = null
function closeReturnListener(): void {
  returnListener?.close(); returnListener = null
  if (returnTimer) { clearTimeout(returnTimer); returnTimer = null }
}

/**
 * A link the page finishes in the system browser (Plugins → GitHub): a
 * one-shot 127.0.0.1 listener for its return. When it comes, the window comes
 * forward and the page is told the result, then finishes the link itself.
 */
async function prepareReturn(rawState: string): Promise<string> {
  closeReturnListener()
  const listener = await startReturnListener({
    state: rawState,
    onReturn: result => {
      returnListener = null
      if (returnTimer) { clearTimeout(returnTimer); returnTimer = null }
      if (!mainWindow || mainWindow.isDestroyed()) return
      bringToFront()
      const contents = mainWindow.webContents
      if (!contents.isDestroyed() && isTrustedFrame(contents.getURL(), PAGE_URL)) contents.send(IPC.appReturned, { state: rawState, result })
    },
  })
  returnListener = listener
  returnTimer = setTimeout(closeReturnListener, 10 * 60_000)
  return listener.returnTo
}

function deliverClick(href: string): void {
  if (gate) { bringToFront(); return }
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingClick = href
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.send(IPC.notificationsClicked, href)
}

/** Every Mikka page this app shows (main and child windows), for pushes the page subscribes to. */
function sendToPages(channel: string, value: unknown): void {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed() && isTrustedFrame(contents.getURL(), PAGE_URL)) contents.send(channel, value)
  }
}

const notifications = new NotificationCenter(
  {
    isSupported: () => Notification.isSupported(),
    show: (title, body, onClick, outcome) => {
      const notification = new Notification({ title, body })
      notification.on('click', onClick)
      // The OS answers each one: shown, or refused (macOS and Windows), which is how main learns that
      // notifications for Mikka are switched off in System Settings (Capy's "Notifications … are off" banner).
      notification.on('show', () => outcome?.shown())
      notification.on('failed', (_event, error) => outcome?.failed(String(error)))
      notification.show()
    },
    setBadge: count => {
      if (process.platform !== 'win32') app.setBadgeCount(count)
    },
  },
  deliverClick,
  Date.now,
  (access: DesktopNotificationAccess) => sendToPages(IPC.notificationsAccessChanged, access)
)

/** The OS's own notification settings for this app (Capy: x-apple.systempreferences …Notifications-Settings). */
async function openNotificationSettings(): Promise<void> {
  if (process.platform === 'darwin') {
    const bundleId = app.isPackaged ? (FLAVOR === 'dev' ? 'com.aspectlylabs.mikka.dev' : 'com.aspectlylabs.mikka') : 'com.github.Electron'
    await shell.openExternal(`x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${bundleId}`)
  } else if (process.platform === 'win32') {
    await shell.openExternal('ms-settings:notifications')
  }
}

function registerSession(): void {
  const appSession = session.fromPartition(PARTITION)
  appSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write' && contents !== null && isTrustedFrame(contents.getURL(), PAGE_URL))
  })
  appSession.setPermissionCheckHandler((contents, permission) => permission === 'clipboard-sanitized-write' && contents !== null && isTrustedFrame(contents.getURL(), PAGE_URL))
  appSession.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      if (!BUNDLED && new URL(details.url).origin === APP_ORIGIN) {
        details.requestHeaders['x-mikka-client'] = 'desktop'
        details.requestHeaders['x-mikka-client-version'] = APP_VERSION
        Object.assign(details.requestHeaders, HOSTED_API_HEADERS)
      }
    } catch {
      // A malformed request URL is left untouched; the request still goes out.
    }
    callback({ requestHeaders: details.requestHeaders })
  })
}

/** The current account's server (#1557), or the sign-in page's; the build's server in hosted mode. */
function currentServer(): string {
  return bundledAuth?.serverUrl() ?? APP_URL
}

/** A page keeps the server it loaded with. When the window's server changes,
 * the page loads again so nothing from the previous server stays on screen. */
function reloadForServer(): boolean {
  const server = currentServer()
  if (shownServer === null || server === shownServer) return false
  shownServer = server
  if (!mainWindow || mainWindow.isDestroyed()) return true
  let english = false
  try { english = /^\/mikka\/en(?:\/|$)/.test(new URL(mainWindow.webContents.getURL()).pathname) } catch { /* not a page yet */ }
  void mainWindow.loadURL(english ? `${RENDERER_URL}/en` : RENDERER_URL)
  return true
}

function handleNavigation(event: Electron.Event, url: string): void {
  if (navigationDecision(url, PAGE_URL) === 'allow') return
  event.preventDefault()
  openOutside(url)
}

/** HTTP(S) and mailto go to the system browser; other schemes are denied. */
function openOutside(url: string): void {
  const target = externalUrl(url)
  if (target) void shell.openExternal(target)
}

function openChild(url: string): void {
  if (gate) { bringToFront(); return }
  const trusted = isTrustedFrame(url, PAGE_URL)
  const child = new BrowserWindow({
    width: 1100,
    height: 800,
    autoHideMenuBar: true,
    parent: mainWindow ?? undefined,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      partition: PARTITION,
      devTools: !app.isPackaged,
      ...(trusted ? {
        preload: join(__dirname, 'preload.cjs'),
        additionalArguments: [`--mikka-app-origin=${PAGE_ORIGIN}`, windowKindArgument('child')],
      } : {}),
    },
  })
  child.webContents.setWindowOpenHandler(details => {
    openWindow(details.url)
    return { action: 'deny' }
  })
  child.webContents.on('will-navigate', (event, next) => handleNavigation(event, next))
  child.webContents.on('will-redirect', (event, next) => handleNavigation(event, next))
  watchResponsiveness(child)
  void child.loadURL(url)
}

function openWindow(url: string): void {
  if (navigationDecision(url, PAGE_URL) === 'allow') openChild(url)
  else openOutside(url)
}

let offlineAttempt = 0
const appLoad = new AppLoadState(APP_ORIGIN)

function loadApp(): void {
  if (retrying) { clearTimeout(retrying); retrying = null }
  if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadURL(PAGE_URL)
}

function showOffline(reason: 'network' | 'server'): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const delay = offlineRetryDelay(offlineAttempt++)
  if (!mainWindow.webContents.getURL().startsWith('file:')) {
    const lang = /^zh\b/i.test(app.getLocale()) ? 'zh-CN' : 'en'
    void mainWindow.loadFile(join(__dirname, 'offline.html'), { query: { app: APP_URL, reason, lang } })
  }
  if (retrying) clearTimeout(retrying)
  retrying = setTimeout(() => { retrying = null; loadApp() }, delay)
}

/** Reload goes back to the app, never to the offline file it is showing. */
function reloadApp(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.webContents.getURL().startsWith('file:')) loadApp()
  else mainWindow.webContents.reload()
}

/**
 * A window whose page stops answering gets Capy's recovery dialog instead of a spinning cursor: keep
 * waiting, reload the window, show the logs, or quit. One dialog at a time; it closes itself if the page recovers.
 */
function watchResponsiveness(win: BrowserWindow): void {
  let asking = false
  win.on('unresponsive', () => {
    if (asking || win.isDestroyed()) return
    asking = true
    const words = unresponsiveCopy(app.getLocale())
    void dialog.showMessageBox(win, { type: 'warning', message: words.message, detail: words.detail, buttons: words.buttons, defaultId: 0, cancelId: 0, noLink: true })
      .then(({ response }) => {
        const choice = unresponsiveChoice(response)
        if (choice === 'reload' && !win.isDestroyed()) {
          // A hung renderer does not answer a reload; restart its process first.
          win.webContents.forcefullyCrashRenderer()
          win.webContents.reload()
        } else if (choice === 'logs') void showLogs()
        else if (choice === 'quit') app.quit()
      })
      .finally(() => { asking = false })
  })
}

/** Help › Show Logs: the folder Electron and the daemon installer write to. */
async function showLogs(): Promise<void> {
  const folder = app.getPath('logs')
  try { await mkdir(folder, { recursive: true }) } catch { /* shell still opens the parent */ }
  await shell.openPath(folder)
}

/** The window a menu command is for: the focused Mikka window, else the main window. */
function commandTarget(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed() && focused !== gateWindow) return focused
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

function sendMenuCommand(command: DesktopMenuCommand): void {
  const target = commandTarget()
  if (!target) {
    // Settings… and New Thread from the Dock menu with no window open: open one first.
    if (command.type === 'settings.open' || command.type === 'thread.new') commandWhenOpen(command)
    return
  }
  const contents = target.webContents
  if (!contents.isDestroyed() && isTrustedFrame(contents.getURL(), PAGE_URL)) contents.send(IPC.appMenuCommand, command)
}

let appSettings: AppSettings | undefined
let runActivity: ReturnType<typeof watchLocalRunActivity> | undefined
let tray: Tray | null = null
let trayState: DesktopTrayState = { signedIn: false, waiting: 0, threads: null, hasMore: false }

/** Shows the main window (opening one if it was closed) on an in-app page, as a notification click does. */
function openFromTray(href: string): void {
  // A window opened for this hands the page over once it subscribes, as a click that arrived while closed.
  if (!mainWindow || mainWindow.isDestroyed()) { pendingClick = href; createMainWindow(); return }
  deliverClick(href)
}

/** A menu command for a window that is only now opening: sent once its page has loaded and subscribed. */
function commandWhenOpen(command: DesktopMenuCommand): void {
  createMainWindow()
  const contents = mainWindow?.webContents
  contents?.once('did-finish-load', () => {
    if (!gate && !contents.isDestroyed() && isTrustedFrame(contents.getURL(), PAGE_URL)) {
      contents.send(IPC.appMenuCommand, command)
    }
  })
}

function renderTray(): void {
  if (!tray || tray.isDestroyed()) return
  const locale = app.getLocale()
  tray.setContextMenu(Menu.buildFromTemplate(trayMenu(trayState, locale, {
    openHref: guardAppAction(() => gate !== null, bringToFront, openFromTray),
    newThread: guardAppAction(() => gate !== null, bringToFront, () => {
      if (!mainWindow || mainWindow.isDestroyed()) { commandWhenOpen({ type: 'thread.new' }); return }
      bringToFront()
      sendMenuCommand({ type: 'thread.new' })
    }),
    openApp: bringToFront,
  })))
  // The menu bar shows the waiting count beside the mark on macOS, as Capy's tray item does.
  if (process.platform === 'darwin') tray.setTitle(trayState.signedIn && trayState.waiting > 0 ? String(trayState.waiting) : '')
  tray.setToolTip(trayCopy(locale).tooltip)
}

/** The tray / menu bar icon (decision C6). Its menu fills in once the page reports its threads. */
function installTray(): void {
  if (tray) return
  const image = nativeImage.createFromDataURL(TRAY_ICON_1X)
  image.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_2X })
  if (process.platform === 'darwin') image.setTemplateImage(true)
  tray = new Tray(image)
  renderTray()
}

function updateTray(raw: unknown): void {
  trayState = desktopTrayState.parse(raw)
  renderTray()
}

/** ⌘W closes a tab in the main window (its tab strip) and a child window as a whole, as browsers do. */
function closeTabOrWindow(): void {
  const target = commandTarget()
  if (!target) return
  closeWindowTarget(target === mainWindow, isTrustedFrame(target.webContents.getURL(), PAGE_URL),
    () => target.webContents.send(IPC.appMenuCommand, { type: 'tab.close' } satisfies DesktopMenuCommand), () => target.close())
}

function createMainWindow(): void {
  markStartup('main.window.start')
  const appearance = windowAppearance(process.platform, { dark: nativeTheme.shouldUseDarkColors })
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // The page paints its own top bar, so the native one must not show as a separate band.
    ...appearance,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      devTools: !app.isPackaged,
      partition: PARTITION,
      additionalArguments: [`--mikka-app-origin=${PAGE_ORIGIN}`, windowKindArgument('main')],
    },
  })
  markStartup('main.window.created')
  mainWindow.setMenuBarVisibility(false)
  mainWindow.once('ready-to-show', () => { if (!gate) mainWindow?.show() })
  mainWindow.on('closed', () => { mainWindow = null })
  watchResponsiveness(mainWindow)
  mainWindow.webContents.setWindowOpenHandler(details => {
    openWindow(details.url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => handleNavigation(event, url))
  mainWindow.webContents.on('will-redirect', (event, url) => handleNavigation(event, url))
  mainWindow.webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) appLoad.started(details.url)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    if (appLoad.finished(mainWindow?.webContents.getURL() ?? '')) {
      offlineAttempt = 0
      if (retrying) { clearTimeout(retrying); retrying = null }
    }
  })
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !mainWindow?.webContents.getURL().startsWith('file:')) return
    const reload = input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')
    if (!reload) return
    event.preventDefault()
    loadApp()
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _description, validatedURL, isMainFrame) => {
    if (BUNDLED || !isMainFrame || errorCode === -3 || !validatedURL.startsWith(APP_ORIGIN)) return
    appLoad.failedLoad()
    showOffline(offlineReason(errorCode, net.isOnline()))
  })
  void mainWindow.loadURL(PAGE_URL)
}

function messageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options)
}

/**
 * The updater reads the signed ZIP and latest-mac.yml from the published
 * GitHub Release. Draft releases are invisible to it, so a release becomes
 * available only after the draft is published. A downloaded update is
 * offered by the rail's restart button and installs on the next quit anyway.
 */
const copy = () => updateCopy(app.getLocale())
const updates = new Updates(autoUpdater, {
  ready: version => {
    // Capy's words: ready to install, installs on restart, Restart Now / Later.
    void messageBox({ type: 'info', message: copy().ready, detail: copy().readyDetail(version), buttons: [copy().restartNow, copy().later], defaultId: 0, cancelId: 1 })
      .then(({ response }) => { if (response === 0) updates.install() })
  },
  upToDate: () => { void messageBox({ type: 'info', message: copy().upToDate(APP_VERSION), buttons: [copy().ok] }) },
  failed: error => { void messageBox({ type: 'error', ...updateFailure(copy(), error), buttons: [copy().ok] }) },
}, version => {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed() && isTrustedFrame(contents.getURL(), PAGE_URL)) contents.send(IPC.appUpdateReady, version)
  }
})

let gate: UpdateGate | null = null
/** The first background check waits for the window to settle; later ones run a few times a day. */
const BACKGROUND_UPDATE_DELAY_MS = 10_000
const BACKGROUND_UPDATE_INTERVAL_MS = 4 * 60 * 60_000

function runUpdateGate(minimum: string): void {
  if (gate) return
  const copy = gateCopy(app.getLocale())
  const win = new BrowserWindow({
    width: 360,
    height: 200,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: copy.title,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171717' : '#f5f5f4',
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: !app.isPackaged },
  })
  gateWindow = win
  let loaded = false
  let pending: GateState | null = null
  const render = (state: GateState) => {
    if (win.isDestroyed()) return
    if (!loaded) { pending = state; return }
    void win.webContents.executeJavaScript(`window.render(${JSON.stringify(gateView(state, copy))}, ${JSON.stringify(copy.lang)})`).catch(() => {})
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.on('did-navigate-in-page', (_event, url) => { if (new URL(url).hash === '#retry') gate?.retry() })
  win.webContents.once('did-finish-load', () => {
    loaded = true
    if (pending) render(pending)
    if (!win.isDestroyed()) win.show()
  })
  win.on('closed', () => {
    gateWindow = null
    app.quit()
  })
  gate = new UpdateGate(autoUpdater, {
    onState: render,
    minimum,
  })
  const lang = /^zh\b/i.test(app.getLocale()) ? 'zh-CN' : 'en'
  void win.loadFile(join(__dirname, 'update.html'), { query: { lang } })
  gate.start(updates.beginRequiredUpdate())
}

/**
 * The server's minimum desktop version (/api/version, MIN_CLIENT_VERSION, ADR
 * 0011). The page asks when it sees one above this build; main reads it again
 * itself, so a page cannot force an update the server does not require.
 */
async function enforceMinimumVersion(): Promise<void> {
  if (!app.isPackaged || FLAVOR === 'dev' || gate) return
  let minimum: string
  try {
    const server = currentServer()
    const response = await session.fromPartition(PARTITION).fetch(`${server.replace(/\/$/, '')}/api/version`, { headers: { origin: new URL(server).origin }, redirect: 'error', cache: 'no-store' })
    if (!response.ok) return
    const { minDesktopVersion } = await response.json() as { minDesktopVersion?: unknown }
    if (typeof minDesktopVersion !== 'string' || meetsMinimumVersion(APP_VERSION, minDesktopVersion)) return
    minimum = minDesktopVersion
  } catch {
    return
  }
  if (gate) return
  const children = BrowserWindow.getAllWindows().filter(win => win !== mainWindow && win.isVisible())
  for (const win of children) win.hide()
  mainWindow?.hide()
  runUpdateGate(minimum)
}

async function checkForUpdates(interactive: boolean): Promise<void> {
  if (!app.isPackaged || FLAVOR === 'dev') {
    if (interactive) await messageBox({ type: 'info', message: copy().notInstalled, buttons: [copy().ok] })
    return
  }
  await updates.check(interactive)
}

/**
 * Ctrl/Cmd+= zooms in without Shift (Electron's default is Plus, which needs
 * Shift on US layouts); a hidden Plus item keeps Ctrl/Cmd+Shift+= and keypad +.
 */
const ZOOM_ITEMS: Electron.MenuItemConstructorOptions[] = [
  { role: 'resetZoom' },
  { role: 'zoomIn', accelerator: 'CommandOrControl+=' },
  { role: 'zoomIn', accelerator: 'CommandOrControl+Plus', visible: false },
  { role: 'zoomIn', accelerator: 'CommandOrControl+numadd', visible: false },
  { role: 'zoomOut' },
  { role: 'zoomOut', accelerator: 'CommandOrControl+numsub', visible: false },
]

/**
 * The native menu (window-menu.ts), as Capy's and Codex's. Windows and Linux show no menu bar; the menu
 * stays to keep its shortcuts, which is also how ⌘W/⌘T/⌘1–9 reach the page with focus in a text field.
 */
function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenu({
    platform: process.platform,
    locale: app.getLocale(),
    appName: app.name,
    packaged: app.isPackaged,
    command: guardAppAction(() => gate !== null, bringToFront, sendMenuCommand),
    closeTab: guardAppAction(() => gate !== null, bringToFront, closeTabOrWindow),
    newWindow: guardAppAction(() => gate !== null, bringToFront, () => openChild(PAGE_URL)),
    reload: reloadApp,
    checkForUpdates: guardAppAction(() => gate !== null, bringToFront, () => { void checkForUpdates(true) }),
    openWebsite: () => { void shell.openExternal('https://aspectlylabs.com/mikka') },
    showLogs: () => { void showLogs() },
    zoomItems: ZOOM_ITEMS,
  })))
}

async function start(): Promise<void> {
  markStartup('main.ready')
  // The packaged Info.plist (electron-builder `protocols`) declares the scheme;
  // this makes this build its default handler. An unpackaged run would register Electron itself.
  if (app.isPackaged) app.setAsDefaultProtocolClient(appLinks.scheme)
  registerSession()
  let restoring = Promise.resolve()
  if (BUNDLED) {
    const backend = session.fromPartition(`${PARTITION}-backend`)
    // Which server the sign-in page targets; public facts only (server-directory.ts).
    const directory = new ServerDirectory(join(app.getPath('userData'), 'servers.json'), APP_URL)
    shownServer = directory.target()
    const vault = new SessionVault(join(app.getPath('userData'), 'credentials'), APP_URL, {
      available: async () => await safeStorage.isAsyncEncryptionAvailable() && (process.platform !== 'linux' || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())),
      encrypt: value => safeStorage.encryptStringAsync(value),
      decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
    })
    bundledAuth = new BundledAuth({
      serverUrl: APP_URL, version: APP_VERSION, vault,
      fetch: (url, init) => backend.fetch(url, init),
      openExternal: url => shell.openExternal(url),
      appLink: () => appLinks.issue(),
      target: directory.target(),
      targetChanged: url => directory.follow(url),
      describe: url => { const known = directory.info(url); return { url: known.url, cloud: directory.isCloud(url), name: known.name } },
      changed: change => {
        bundledLive?.closeAll()
        bundledViewer?.closeAll()
        if (reloadForServer()) return
        notifyBundledSessionChange(webContents.getAllWebContents(), mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null, PAGE_URL, change)
      },
      scopeChanged: () => { bundledLive?.closeAll(); bundledViewer?.closeAll() },
      returned: async next => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        bringToFront()
        const path = next === '/' ? '/mikka' : next === '/mikka' || next.startsWith('/mikka/') || next.startsWith('/mikka?') ? next : `/mikka${next}`
        await mainWindow.loadURL(`${RENDERER_ORIGIN}${path}`)
      },
    })
    // Open the first backend socket while the OS keychain and local renderer
    // initialize. BundledAuth has validated this compiled origin; preconnect
    // sends no application HTTP request or session credential.
    backend.preconnect({ url: new URL(directory.target()).origin, numSockets: 1 })
    markStartup('main.backend.preconnect')
    markStartup('main.restore.start')
    restoring = bundledAuth.restore().then(() => { markStartup('main.restore.end'); reloadForServer() })
    bundledLive = new BundledLive(bundledAuth, (owner, event) => {
      const contents = webContents.fromId(owner)
      if (contents && !contents.isDestroyed() && isTrustedFrame(contents.getURL(), PAGE_URL)) contents.send(BUNDLED_IPC.liveEvent, event)
    })
    bundledViewer = new BundledViewer(bundledAuth, (owner, event) => {
      const contents = webContents.fromId(owner)
      if (contents && !contents.isDestroyed() && isTrustedFrame(contents.getURL(), PAGE_URL)) contents.send(BUNDLED_IPC.viewerEvent, event)
    })
    registerBundledBridge(bundledAuth, bundledLive, bundledViewer, new BundledServers(bundledAuth, directory, {
      fetch: (url, init) => backend.fetch(url, init),
      appVersion: APP_VERSION,
      enforceMinimum: app.isPackaged && FLAVOR === 'prod',
    }))
    session.fromPartition(PARTITION).protocol.handle('mikka', bundledProtocol(join(__dirname, 'renderer'), bundledAuth))
  }
  appSettings = new AppSettings(join(app.getPath('userData'), 'app-settings.json'), {
    loginSupported: process.platform === 'darwin' || process.platform === 'win32',
    getLogin: () => app.getLoginItemSettings().openAtLogin,
    setLogin: openAtLogin => app.setLoginItemSettings({ openAtLogin }),
    tray: enabled => { if (enabled) installTray(); else { tray?.destroy(); tray = null } },
    block: () => powerSaveBlocker.start('prevent-app-suspension'),
    unblock: id => powerSaveBlocker.stop(id),
  })
  registerBridge({
    appSettings,
    appUrl: APP_URL,
    serverUrl: currentServer,
    rendererUrl: PAGE_URL,
    flavor: FLAVOR,
    mintEnrollment: async () => {
      const url = `${APP_URL.replace(/\/$/, '')}/api/devices/enrollment`
      const init: RequestInit = {
        method: 'POST', headers: { origin: APP_ORIGIN }, redirect: 'error',
      }
      const response = bundledAuth ? await bundledAuth.request('/api/devices/enrollment', init) : await session.fromPartition(PARTITION).fetch(url, init)
      if (!response.ok) throw new Error('Sign in to register a device')
      const body = await response.json() as { token: string }
      return body.token
    },
    openExternal: async url => {
      await bundledAuth?.whenRestored()
      const server = currentServer()
      const target = appExternalUrl(url, server)
      if (!target) throw new Error('openExternal accepts only app-origin HTTP(S) URLs')
      if (bundledAuth && await openBundledWebPage(target, { serverUrl: server, auth: bundledAuth, openExternal: page => shell.openExternal(page) })) return
      await shell.openExternal(target)
    },
    prepareAuth: BUNDLED ? async () => { throw new Error('Use main-owned bundled sign-in / 请使用桌面登录') } : prepareAuth,
    prepareReturn,
    claudeCallback: url => catchClaudeCallback(url, page => shell.openExternal(page)),
    localDevice: localDeviceStatus,
    pickRepo,
    agentLogins,
    localAccount: () => readLocalDeviceAccount((url, init) => bundledAuth ? bundledAuth.request('/api/devices/enrollment', init) : session.fromPartition(PARTITION).fetch(url, init), APP_URL),
    localOwner: () => readLocalDeviceOwner((url, init) => bundledAuth ? bundledAuth.request('/api/devices/enrollment?view=owner', init) : session.fromPartition(PARTITION).fetch(url, init), APP_URL),
    quota: localQuota,
    notifications,
    openNotificationSettings,
    updateTray,
    consumePendingClick: () => {
      const href = pendingClick
      pendingClick = null
      return href
    },
    updates,
    requireUpdate: enforceMinimumVersion,
  })
  installMenu()
  // No launch gate (decision C7, overturning 2026-11-02; as Capy and Codex): the window opens at once and the
  // update downloads in the background. A downloaded version reaches the rail's 重启以更新 and the menu check's
  // 立即重启 / 稍后, and installs on quit. Only a server that requires a newer desktop blocks (enforceMinimumVersion).
  createMainWindow()
  appSettings.apply()
  runActivity = watchLocalRunActivity(active => appSettings?.setActive(active))
  if (app.isPackaged && FLAVOR !== 'dev') {
    // This app may just have updated: the daemon on this computer updates too, when idle (daemon-update.ts).
    void updateLocalDaemon(FLAVOR, { connect: connectForUpdate({ name: 'mikka-desktop', version: APP_VERSION }) })
      .then(() => runActivity?.refresh())
    setTimeout(() => { void checkForUpdates(false) }, BACKGROUND_UPDATE_DELAY_MS)
    setInterval(() => { void checkForUpdates(false) }, BACKGROUND_UPDATE_INTERVAL_MS)
  }
  app.on('activate', () => {
    runActivity?.refresh()
    if (BrowserWindow.getAllWindows().length === 0 && !gate) createMainWindow()
  })
  // Only disk assets and the loading shell may overtake restoration. API and
  // IPC handlers already wait on BundledAuth's barrier before using any identity.
  await restoring
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // Windows and Linux open the app link by starting a second instance with it.
    const link = appLinkFromArgv(argv, appLinks.scheme)
    if (link !== null && !appLinks.accepts(link)) return
    if (!mainWindow && !(gateWindow && !gateWindow.isDestroyed())) return
    bringToFront()
  })
  app.on('before-quit', closeAuthServer)
  app.on('before-quit', () => { tray?.destroy(); tray = null })
  app.on('before-quit', closeReturnListener)
  app.on('before-quit', () => runActivity?.close())
  app.on('before-quit', () => { bundledAuth?.dispose(); bundledLive?.closeAll(); bundledViewer?.closeAll() })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  void app.whenReady().then(start)
}

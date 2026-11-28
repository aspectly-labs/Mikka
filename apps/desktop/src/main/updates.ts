// electron-updater checks during the launch gate and on explicit menu request.
// A downloaded release reaches the web UI, which shows the rail's restart button.

/** The part of electron-updater's `autoUpdater` this module drives. */
export interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'update-available' | 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'update-not-available', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
}

/** Native answers to a menu check. */
export interface UpdateReport {
  /** A version is downloaded: offer 立即重启 / 稍后. */
  ready(version: string): void
  upToDate(): void
  failed(error: Error): void
}

/** The menu check's words; Chinese unless the system language is not. */
export function updateCopy(locale: string) {
  return locale.toLowerCase().startsWith('zh')
    ? {
      menu: '检查更新…',
      restart: (version: string) => `重启以更新到 v${version}`,
      ready: 'Mikka 新版本已可安装',
      readyDetail: (version: string) => `v${version} 会在重启后安装`,
      restartNow: '立即重启',
      later: '稍后',
      upToDate: (version: string) => `Mikka ${version} 已是最新版本`,
      failed: '无法检查更新',
      failedHint: '检查网络连接后再试一次',
      diskFull: '磁盘空间不足，无法更新',
      diskFullHint: '腾出一些空间后再检查更新',
      notInstalled: '安装版才会检查更新',
      ok: '好',
    }
    : {
      menu: 'Check for Updates…',
      restart: (version: string) => `Restart to update to v${version}`,
      ready: 'A new version of Mikka is ready to install',
      readyDetail: (version: string) => `Version ${version} installs when the app restarts`,
      restartNow: 'Restart Now',
      later: 'Later',
      upToDate: (version: string) => `Mikka ${version} is up to date`,
      failed: 'Could not check for updates',
      failedHint: 'Check your connection and try again',
      diskFull: 'Not enough disk space to update',
      diskFullHint: 'Free up some space, then check for updates again',
      notInstalled: 'Updates are checked in the installed app',
      ok: 'OK',
    }
}

/**
 * A failed check or download, said by its cause as Capy's updater does: a full disk asks for space,
 * anything else to check the connection. The updater's own error text is never shown.
 */
export function updateFailure(copy: ReturnType<typeof updateCopy>, error: Error & { code?: unknown }): { message: string; detail: string } {
  const diskFull = error.code === 'ENOSPC' || /ENOSPC|no space left|not enough (?:disk )?space/i.test(error.message)
  return diskFull ? { message: copy.diskFull, detail: copy.diskFullHint } : { message: copy.failed, detail: copy.failedHint }
}

export class Updates {
  /** The downloaded version, waiting for a restart. */
  ready: string | null = null
  /** A menu check found a version that is still downloading; answer once it lands. */
  private required = false
  private announce = false
  private interactive = false

  constructor(private readonly updater: Updater, private readonly report: UpdateReport, onReady: (version: string) => void) {
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.on('update-available', () => {
      if (this.take()) this.announce = true
    })
    updater.on('update-not-available', () => {
      if (this.take()) report.upToDate()
    })
    updater.on('update-downloaded', info => {
      if (this.required) return
      this.ready = info.version
      onReady(info.version)
      if (this.announce) {
        this.announce = false
        report.ready(info.version)
      }
    })
    updater.on('error', error => {
      if (this.take() || this.announce) {
        this.announce = false
        report.failed(error)
      }
    })
  }

  /** Give the gate exclusive control of installations, including a previously downloaded release. */
  beginRequiredUpdate(): string | null {
    this.required = true
    this.announce = false
    this.interactive = false
    this.updater.autoInstallOnAppQuit = false
    const cached = this.ready
    this.ready = null
    return cached
  }

  /** A background check stays silent; once a version is downloaded there is nothing left to check. */
  async check(interactive: boolean): Promise<void> {
    if (this.required) return
    if (this.ready) {
      if (interactive) this.report.ready(this.ready)
      return
    }
    this.interactive = interactive
    await this.updater.checkForUpdates().catch((error: Error) => {
      if (this.take()) this.report.failed(error)
    })
  }

  install(): void {
    if (this.ready) this.updater.quitAndInstall()
  }

  private take(): boolean {
    const interactive = this.interactive
    this.interactive = false
    return interactive
  }
}

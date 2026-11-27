import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { desktopAppSettings, type DesktopAppSettings } from '@mikka/protocol/bridge'

export class AppSettings {
  private value: DesktopAppSettings
  private active = false
  private blocker: number | null = null

  constructor(private readonly file: string, private readonly native: {
    loginSupported: boolean
    getLogin(): boolean
    setLogin(enabled: boolean): void
    tray(visible: boolean): void
    block(): number
    unblock(id: number): void
  }) {
    this.value = existsSync(file) ? desktopAppSettings.parse(JSON.parse(readFileSync(file, 'utf8')))
      : { startAtLogin: false, menuBarIcon: true, preventSleep: false }
  }

  read() {
    return { ...this.value, startAtLogin: this.native.loginSupported && this.native.getLogin(), loginSupported: this.native.loginSupported }
  }

  write(raw: unknown) {
    const patch = desktopAppSettings.partial().strict().parse(raw)
    if (patch.startAtLogin !== undefined && !this.native.loginSupported) throw new Error('unsupportedPlatform')
    const next = { ...this.value, ...patch }
    writeFileSync(this.file + '.tmp', JSON.stringify(next), { mode: 0o600 })
    renameSync(this.file + '.tmp', this.file)
    if (patch.startAtLogin !== undefined) this.native.setLogin(patch.startAtLogin)
    this.value = next
    this.apply()
    return this.read()
  }

  setActive(active: boolean) {
    this.active = active
    this.syncSleep()
  }

  apply() {
    this.native.tray(this.value.menuBarIcon)
    this.syncSleep()
  }

  private syncSleep() {
    if (this.active && this.value.preventSleep) {
      this.blocker ??= this.native.block()
    } else if (this.blocker !== null) {
      this.native.unblock(this.blocker)
      this.blocker = null
    }
  }
}

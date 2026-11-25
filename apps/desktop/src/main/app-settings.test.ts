import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppSettings } from './app-settings'

test('app preferences survive restart and a run holds one sleep blocker', t => {
  const dir = mkdtempSync(join(tmpdir(), 'mikka-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let login = false, tray = true, starts = 0, stops = 0
  const native = { loginSupported: true, getLogin: () => login, setLogin: (value: boolean) => { login = value },
    tray: (value: boolean) => { tray = value }, block: () => ++starts, unblock: (id: number) => { assert.equal(id, 1); ++stops } }
  const path = join(dir, 'preferences.json')
  const settings = new AppSettings(path, native)
  settings.write({ preventSleep: true, startAtLogin: true, menuBarIcon: false })
  assert.deepEqual([login, tray, starts], [true, false, 0])
  settings.setActive(true)
  settings.setActive(true)
  assert.equal(starts, 1)
  settings.setActive(false)
  assert.equal(stops, 1)
  assert.deepEqual(new AppSettings(path, native).read(), { startAtLogin: true, menuBarIcon: false, preventSleep: true, loginSupported: true })
  assert.throws(() => settings.write({ preventSleep: 1 }))
})

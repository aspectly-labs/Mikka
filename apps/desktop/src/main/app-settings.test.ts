import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol'
import { connectDaemonInDataDir } from '@mikka/daemon/client'
import { daemonPaths } from '@mikka/daemon/paths'
import { createLogger } from '../../../../packages/daemon/src/log'
import { RpcServer, type RpcHandlers } from '../../../../packages/daemon/src/rpc/server'
import { AppSettings } from './app-settings'
import { watchDaemonRunActivity } from './daemon-run-activity'

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


test('the app holds sleep prevention without a window and releases it on run end, disconnect and quit', { timeout: 10_000, skip: process.platform === 'win32' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mikka-activity-'))
  const { socket: socketPath, secret: secretPath } = daemonPaths(directory)
  const secret = 'fixture-desktop-run-activity-secret'
  const events: string[] = []
  let unblockEvent: (() => void) | undefined
  const observed = (label: string) => {
    events.push(label)
    unblockEvent?.()
  }
  const waitFor = async (count: number) => {
    while (events.length < count) await new Promise<void>(resolve => { unblockEvent = resolve })
  }
  let blocker = 0
  const settings = new AppSettings(join(directory, 'preferences.json'), {
    loginSupported: false, getLogin: () => false, setLogin: () => undefined, tray: () => undefined,
    block: () => { observed('blocked'); return ++blocker },
    unblock: id => { assert.equal(id, blocker); observed('released') },
  })
  settings.write({ preventSleep: true })
  const connect = () => connectDaemonInDataDir(directory, { name: 'activity-fixture', version: '1' })
  const stop = watchDaemonRunActivity(directory, connect, active => settings.setActive(active))
  let active = true
  const serve = (supportsRunActivity = true) => new RpcServer({
    socketPath, secret, hello: () => ({ protocolVersion: DAEMON_PROTOCOL_VERSION, daemonVersion: '0.0.0-fixture', pid: process.pid }),
    handlers: {} as RpcHandlers,
    isRunActive: supportsRunActivity ? () => active : undefined,
    log: createLogger(),
  })
  let daemon = serve()
  t.after(async () => { stop(); await daemon.close(); rmSync(directory, { recursive: true, force: true }) })
  writeFileSync(secretPath, secret, { mode: 0o600 })
  await daemon.listen()
  // Native main attaches before the daemon is installed, then receives an
  // already-running snapshot even though no BrowserWindow exists.
  await waitFor(1)
  active = false
  daemon.publishRunActivity(active)
  await waitFor(2)
  active = true
  daemon.publishRunActivity(active)
  await waitFor(3)
  await daemon.close()
  await waitFor(4)
  assert.deepEqual(events, ['blocked', 'released', 'blocked', 'released'])

  daemon = serve(false)
  await daemon.listen()
  const olderClient = await connect()
  await assert.rejects(olderClient.watchRunActivity(() => assert.fail('unsupported activity')), /Run activity unavailable/)
  olderClient.close()
  await daemon.close()
  daemon = serve()
  await daemon.listen()
  await waitFor(5)
  stop()
  stop()
  assert.deepEqual(events, ['blocked', 'released', 'blocked', 'released', 'blocked', 'released'])
})

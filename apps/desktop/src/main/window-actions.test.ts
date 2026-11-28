import assert from 'node:assert/strict'
import test from 'node:test'
import { guardAppAction, closeWindowTarget } from './window-actions'
import { trayBridge } from '../window-kind'

test('required update redirects a tray destination and a tab shortcut to the gate', () => {
  let gated = false
  const calls: string[] = []
  const guard = (action: (href: string) => void) => guardAppAction(() => gated, () => calls.push('gate'), action)
  const open = guard(href => calls.push(href))
  const close = guard(() => calls.push('close'))
  open('inbox')
  gated = true
  open('thread')
  close('')
  assert.deepEqual(calls, ['inbox', 'gate', 'gate'])
})

test('only a child window closes on Cmd-W and a main error page stays open', () => {
  const calls: string[] = []
  const close = (main: boolean, appPage: boolean) => closeWindowTarget(main, appPage, () => calls.push('tab'), () => calls.push('window'))
  close(true, false)
  assert.deepEqual(calls, [])
  close(true, true)
  close(false, true)
  assert.deepEqual(calls, ['tab', 'window'])
})

test('unmounting a child renderer cannot reset the main tray', async () => {
  let signedIn = false
  const update = async (state: unknown) => { signedIn = Boolean(state) }
  await trayBridge('main', update)?.update(true)
  await trayBridge('child', update)?.update(false)
  assert.ok(signedIn)
  await trayBridge('main', update)?.update(false)
  assert.equal(signedIn, false)
})

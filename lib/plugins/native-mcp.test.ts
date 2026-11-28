import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nativeMcpName, withLockedToolSwitches } from './native-mcp'

const id = '6f0c7f6e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', other = '7a1d8e9f-2b3c-4d5e-9f0a-1b2c3d4e5f60'
const server = (serverId: string, disabledTools?: string[]) => ({ name: nativeMcpName(serverId), transport: 'http' as const, url: 'https://mcp.example.invalid', headers: {}, ...(disabledTools ? { disabledTools } : {}) })
const unavailable = (error: { code?: string; status?: number }) => error.code === 'mcpUnavailable' && error.status === 409

test('the claim response carries the switches read under the fence, not the earlier export', () => {
  assert.deepEqual(withLockedToolSwitches([server(id)], { [id]: ['delete_docs'] }, true), [server(id, ['delete_docs'])])
  assert.deepEqual(withLockedToolSwitches([server(id, ['delete_docs'])], { [id]: [] }, true), [server(id, [])])
  assert.deepEqual(withLockedToolSwitches([server(id)], { [id]: [] }, false), [server(id)])
})

test('a server the fence did not lock fails closed as unavailable', () => {
  assert.throws(() => withLockedToolSwitches([server(id)], {}, true), unavailable)
  assert.throws(() => withLockedToolSwitches([server(id), server(other)], { [id]: [] }, true), unavailable)
})

test('a disabled tool for a daemon that cannot filter tools fails closed as unavailable', () => {
  assert.throws(() => withLockedToolSwitches([server(id)], { [id]: ['delete_docs'] }, false), unavailable)
})

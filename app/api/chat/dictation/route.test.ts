import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

class FakeChatFileError extends Error { constructor(readonly code: string) { super(code) } }
class FakeWorkspaceError extends Error {}
let signedIn = true
let tokenWorkspaceId: string | undefined
const transcribed: { userId: string; workspaceId: string; size: number }[] = []
let failWith: Error | null = null

mock.module('@/lib/api-auth', { namedExports: {
  auth: { api: { getSession: async () => signedIn ? { user: { id: 'user-1' }, tokenWorkspaceId } : null } },
  apiWorkspaceAllowed: (session: { tokenWorkspaceId?: string }, workspaceId: string) => !session.tokenWorkspaceId || session.tokenWorkspaceId === workspaceId,
} })
mock.module('@/lib/mobile-api', { namedExports: { writeAllowed: () => true } })
mock.module('@/lib/chat-attachments/extract', { namedExports: { ChatFileError: FakeChatFileError } })
mock.module('@/lib/workspace-access', { namedExports: { WorkspaceError: FakeWorkspaceError, loadWorkspaceContext: async () => ({ workspace: { id: 'ws-1' } }) } })
mock.module('@/lib/chat-attachments/transcribe', { namedExports: { transcribeChatAudio: async (userId: string, workspaceId: string, audio: Uint8Array) => {
  if (failWith) throw failWith
  transcribed.push({ userId, workspaceId, size: audio.byteLength })
  return 'Run the test suite after compacting'
} } })
const { POST } = await import('./route')

const send = (body: BodyInit | null, type = 'audio/webm') => POST(new Request('http://localhost/mikka/api/chat/dictation', { method: 'POST', body, headers: { 'content-type': type } }))

test('chat dictation transcribes audio in the caller workspace and returns text', async () => {
  const response = await send(new Uint8Array([4, 5, 6]))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { text: 'Run the test suite after compacting' })
  assert.deepEqual(transcribed, [{ userId: 'user-1', workspaceId: 'ws-1', size: 3 }])
})

test('chat dictation enforces auth, audio content type, and 10 MiB limit', async () => {
  signedIn = false
  assert.equal((await send(new Uint8Array([1]))).status, 401)
  signedIn = true
  assert.equal((await send('plain text', 'text/plain')).status, 400)
  assert.equal((await send(new Uint8Array(10 * 1024 * 1024 + 1))).status, 413)
})

test('chat dictation maps missing audio key and cross-workspace token', async () => {
  failWith = new FakeChatFileError('audioKeyRequired')
  const missing = await send(new Uint8Array([1]))
  assert.equal(missing.status, 409)
  assert.deepEqual(await missing.json(), { error: 'audioKeyRequired' })
  failWith = null

  transcribed.length = 0
  tokenWorkspaceId = 'ws-other'
  assert.equal((await send(new Uint8Array([1]))).status, 404)
  assert.deepEqual(transcribed, [])
  tokenWorkspaceId = undefined
})

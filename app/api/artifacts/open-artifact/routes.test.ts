import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import {
  OPEN_ARTIFACT_BRIDGE_SIGNATURE_HEADER,
  OPEN_ARTIFACT_BRIDGE_TIMESTAMP_HEADER,
} from '@mikka/protocol/open-artifact'
import { signOpenArtifactBridgePayload, verifyOpenArtifactBridgeHttpRequest } from '@/lib/artifacts/open-artifact-bridge'

const SECRET = 'route-test-bridge-secret-0123456789'
const HOST_ORIGIN = 'https://artifacts.mikka.example'
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const ARTIFACT_ID = '22222222-2222-4222-8222-222222222222'

const originalSecret = process.env.OPEN_ARTIFACT_BRIDGE_SECRET
const originalHost = process.env.OPEN_ARTIFACT_HOST_ORIGIN

const authenticateMock = mock.fn(async () => ({
  ok: true as const,
  identity: { subject: 'owner-user', email: 'owner@example.com', name: 'Owner' },
}))
const authorizeMock = mock.fn(async () => ({
  ok: true as const,
  role: 'owner' as const,
  artifactId: ARTIFACT_ID,
  workspaceId: WORKSPACE_ID,
}))
const guardMock = mock.fn(async () => ({ ok: true as const, allow: true as const }))
const syncMock = mock.fn(async () => ({
  ok: true as const,
  event: 'created' as const,
  artifactId: ARTIFACT_ID,
  workspaceId: WORKSPACE_ID,
  version: 1,
}))
const wakeMock = mock.fn(async () => ({
  ok: true as const,
  delivered: true,
  classification: 'fenced_notice' as const,
  artifactId: ARTIFACT_ID,
  eventId: 'evt-1',
}))

mock.module('@/lib/artifacts/open-artifact-bridge', {
  namedExports: {
    authenticateOpenArtifact: authenticateMock,
    authorizeOpenArtifact: authorizeMock,
    guardOpenArtifact: guardMock,
    syncOpenArtifactCatalog: syncMock,
    deliverOpenArtifactWake: wakeMock,
    verifyOpenArtifactBridgeHttpRequest,
  },
})

const getSessionMock = mock.fn(async () => ({
  user: { id: 'owner-user', email: 'owner@example.com', name: 'Owner', image: null },
  session: { id: 'sess-1' },
}))
mock.module('@/lib/api-auth', {
  namedExports: {
    getApiSession: getSessionMock,
    auth: { api: { getSession: getSessionMock } },
  },
})

const loadWorkspaceMock = mock.fn(async () => ({
  workspace: { id: WORKSPACE_ID, name: 'Personal', kind: 'personal' as const },
  choices: [{ id: WORKSPACE_ID, name: 'Personal', kind: 'personal' as const }],
  currentUserId: 'owner-user',
  role: 'admin' as const,
  currentUser: { name: 'Owner', email: 'owner@example.com', image: null },
}))
mock.module('@/lib/workspace-access', {
  namedExports: {
    loadWorkspaceContext: loadWorkspaceMock,
  },
})

let bridgePOST: typeof import('./bridge/route')['POST']
let wakePOST: typeof import('./wake/route')['POST']
let configGET: typeof import('./config/route')['GET']

before(async () => {
  ;({ POST: bridgePOST } = await import('./bridge/route'))
  ;({ POST: wakePOST } = await import('./wake/route'))
  ;({ GET: configGET } = await import('./config/route'))
})

beforeEach(() => {
  process.env.OPEN_ARTIFACT_BRIDGE_SECRET = SECRET
  process.env.OPEN_ARTIFACT_HOST_ORIGIN = HOST_ORIGIN
  authenticateMock.mock.resetCalls()
  authorizeMock.mock.resetCalls()
  guardMock.mock.resetCalls()
  syncMock.mock.resetCalls()
  wakeMock.mock.resetCalls()
  getSessionMock.mock.resetCalls()
  loadWorkspaceMock.mock.resetCalls()
})

after(() => {
  if (originalSecret === undefined) delete process.env.OPEN_ARTIFACT_BRIDGE_SECRET
  else process.env.OPEN_ARTIFACT_BRIDGE_SECRET = originalSecret
  if (originalHost === undefined) delete process.env.OPEN_ARTIFACT_HOST_ORIGIN
  else process.env.OPEN_ARTIFACT_HOST_ORIGIN = originalHost
})

function signedPost(url: string, bodyObj: unknown, overrideSig?: string) {
  const rawBody = JSON.stringify(bodyObj)
  const { timestamp, signature } = signOpenArtifactBridgePayload(rawBody, SECRET)
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [OPEN_ARTIFACT_BRIDGE_TIMESTAMP_HEADER]: timestamp,
      [OPEN_ARTIFACT_BRIDGE_SIGNATURE_HEADER]: overrideSig ?? signature,
    },
    body: rawBody,
  })
}

test('bridge route rejects unsigned or unconfigured requests and dispatches valid signed actions', async () => {
  delete process.env.OPEN_ARTIFACT_BRIDGE_SECRET
  const unconfigured = await bridgePOST(
    signedPost('https://mikka.example/mikka/api/artifacts/open-artifact/bridge', {
      action: 'authenticate',
      cookieHeader: 'a=b',
    }),
  )
  assert.equal(unconfigured.status, 503)

  process.env.OPEN_ARTIFACT_BRIDGE_SECRET = SECRET
  const badSig = await bridgePOST(
    signedPost(
      'https://mikka.example/mikka/api/artifacts/open-artifact/bridge',
      { action: 'authenticate', cookieHeader: 'a=b' },
      `sha256=${'f'.repeat(64)}`,
    ),
  )
  assert.equal(badSig.status, 401)

  const invalidBody = await bridgePOST(
    signedPost('https://mikka.example/mikka/api/artifacts/open-artifact/bridge', {
      action: 'unknown',
    }),
  )
  assert.equal(invalidBody.status, 400)

  const authRes = await bridgePOST(
    signedPost('https://mikka.example/mikka/api/artifacts/open-artifact/bridge', {
      action: 'authenticate',
      cookieHeader: 'session=ok',
    }),
  )
  assert.equal(authRes.status, 200)
  assert.equal(authRes.headers.get('cache-control'), 'no-store')
  assert.equal((await authRes.json()).identity.subject, 'owner-user')
  assert.equal(authenticateMock.mock.callCount(), 1)

  const authzRes = await bridgePOST(
    signedPost('https://mikka.example/mikka/api/artifacts/open-artifact/bridge', {
      action: 'authorize',
      subject: 'owner-user',
      externalId: 'art_1',
    }),
  )
  assert.equal(authzRes.status, 200)
  assert.equal((await authzRes.json()).role, 'owner')
  assert.equal(authorizeMock.mock.callCount(), 1)
})

test('wake route requires valid HMAC signature and delivers validated wake payloads', async () => {
  const badSig = await wakePOST(
    signedPost(
      'https://mikka.example/mikka/api/artifacts/open-artifact/wake',
      {
        externalId: 'art_1',
        reason: 'comment',
        from: { kind: 'collaborator', subject: 'user-2', name: 'Bob' },
        text: 'Looks good',
      },
      `sha256=${'0'.repeat(64)}`,
    ),
  )
  assert.equal(badSig.status, 401)
  assert.equal(wakeMock.mock.callCount(), 0)

  const okRes = await wakePOST(
    signedPost('https://mikka.example/mikka/api/artifacts/open-artifact/wake', {
      externalId: 'art_1',
      reason: 'comment',
      from: { kind: 'collaborator', subject: 'user-2', name: 'Bob' },
      text: 'Looks good',
    }),
  )
  assert.equal(okRes.status, 200)
  assert.equal(okRes.headers.get('cache-control'), 'no-store')
  const payload = await okRes.json()
  assert.equal(payload.classification, 'fenced_notice')
  assert.equal(wakeMock.mock.callCount(), 1)
})

test('config route enforces session + same-origin and returns public config without bridgeSecret', async () => {
  const crossOrigin = await configGET(
    new Request('https://mikka.example/mikka/api/artifacts/open-artifact/config', {
      method: 'GET',
      headers: { origin: 'https://evil.example' },
    }),
  )
  assert.equal(crossOrigin.status, 403)

  const ok = await configGET(
    new Request('https://mikka.example/mikka/api/artifacts/open-artifact/config', {
      method: 'GET',
      headers: { origin: 'https://mikka.example' },
    }),
  )
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('cache-control'), 'private, no-store')
  const data = await ok.json()
  assert.equal(data.enabled, true)
  assert.equal(data.hostOrigin, HOST_ORIGIN)
  assert.equal('bridgeSecret' in data, false)
})

import assert from 'node:assert/strict'
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { assertE2eTarget } from './helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
if (target) {
  assertE2eTarget(target)
  assert.equal(process.env.MIKKA_DATABASE_URL, target)
  assert.equal(process.env.DATABASE_URL, target)
}
if (!target && process.env.REQUIRE_DB === '1') throw new Error('Passkey security requires isolated PG17')

/** Independent RFC 6238 authenticator for verifying interaction with native TOTP 2FA. */
function authenticatorCode(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bits = [...secret.replace(/=+$/, '').toUpperCase()].map(character => {
    const value = alphabet.indexOf(character)
    assert.ok(value >= 0)
    return value.toString(2).padStart(5, '0')
  }).join('')
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, index) => Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const digest = createHmac('sha1', key).update(counter).digest()
  const offset = digest.at(-1)! & 15
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0')
}

/** Pure node:crypto WebAuthn P-256 (ES256) software authenticator for real protocol ceremonies. */
class SoftwareAuthenticator {
  readonly credentialId = randomBytes(16)
  readonly privateKey: KeyObject
  readonly cosePublicKey: Buffer
  readonly aaguidHex: string
  signCount = 0

  constructor(aaguidHex = 'bada5566a7aa401fbd9645619a55120d') {
    this.aaguidHex = aaguidHex
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    this.privateKey = privateKey
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    const x = Buffer.from(jwk.x, 'base64url')
    const y = Buffer.from(jwk.y, 'base64url')
    // COSE_Key map(5): { 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y }
    this.cosePublicKey = Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x,
      Buffer.from([0x22, 0x58, 0x20]), y,
    ])
  }

  get idBase64Url() {
    return this.credentialId.toString('base64url')
  }

  attest(challenge: string, origin: string, rpId: string, transports = ['internal', 'hybrid']) {
    this.signCount += 1
    const rpIdHash = createHash('sha256').update(rpId).digest()
    const flags = Buffer.from([0x41 | 0x04 | 0x08 | 0x10]) // UP | UV | BE | BS | AT
    const count = Buffer.alloc(4)
    count.writeUInt32BE(this.signCount)
    const aaguid = Buffer.from(this.aaguidHex, 'hex')
    const credLen = Buffer.alloc(2)
    credLen.writeUInt16BE(this.credentialId.length)
    const authData = Buffer.concat([rpIdHash, flags, count, aaguid, credLen, this.credentialId, this.cosePublicKey])
    const authHeader = authData.length < 256
      ? Buffer.from([0x58, authData.length])
      : Buffer.from([0x59, authData.length >> 8, authData.length & 0xff])
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3, 0x63]), Buffer.from('fmt'), Buffer.from([0x64]), Buffer.from('none'),
      Buffer.from([0x67]), Buffer.from('attStmt'), Buffer.from([0xa0]),
      Buffer.from([0x68]), Buffer.from('authData'), authHeader, authData,
    ])
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.create',
      challenge,
      origin,
      crossOrigin: false,
    }))
    return {
      id: this.idBase64Url,
      rawId: this.idBase64Url,
      type: 'public-key' as const,
      response: {
        attestationObject: attestationObject.toString('base64url'),
        clientDataJSON: clientDataJSON.toString('base64url'),
        transports,
      },
      clientExtensionResults: {},
    }
  }

  assert(challenge: string, origin: string, rpId: string) {
    this.signCount += 1
    const rpIdHash = createHash('sha256').update(rpId).digest()
    const flags = Buffer.from([0x01 | 0x04 | 0x08 | 0x10]) // UP | UV | BE | BS
    const count = Buffer.alloc(4)
    count.writeUInt32BE(this.signCount)
    const authenticatorData = Buffer.concat([rpIdHash, flags, count])
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.get',
      challenge,
      origin,
      crossOrigin: false,
    }))
    const clientDataHash = createHash('sha256').update(clientDataJSON).digest()
    const signature = sign('sha256', Buffer.concat([authenticatorData, clientDataHash]), this.privateKey)
    return {
      id: this.idBase64Url,
      rawId: this.idBase64Url,
      type: 'public-key' as const,
      response: {
        authenticatorData: authenticatorData.toString('base64url'),
        clientDataJSON: clientDataJSON.toString('base64url'),
        signature: signature.toString('base64url'),
      },
      clientExtensionResults: {},
    }
  }
}

class Browser {
  readonly cookies = new Map<string, string>()
  readonly ip = `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`
  take(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const at = pair.indexOf('=')
      const name = pair.slice(0, at)
      const value = pair.slice(at + 1)
      if (!value || /max-age=0(?:;|$)/i.test(cookie)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }
  headers(origin: string, token?: string, includeOrigin = true) {
    return new Headers({
      ...(includeOrigin ? { origin } : {}),
      'content-type': 'application/json',
      'x-forwarded-for': this.ip,
      ...(token ? { authorization: `Bearer ${token}` } : this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    })
  }
}

test('passkey registration, authentication, audit, REST + Desktop RPC, 2FA guard, cross-user rejection, and account deletion', { skip: !target, timeout: 120_000 }, async t => {
  process.env.BETTER_AUTH_URL ||= 'http://localhost:3100'
  const database = new Pool({ connectionString: target })
  const { auth, authBaseURL } = await import('../lib/auth')
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { createRequestScope, runRequestScope } = await import('../apps/api/src/context')
  const { BASE_PATH } = await import('../lib/base-path')
  const passkeysListRoute = await import('../app/api/me/passkeys/route')
  const passkeysItemRoute = await import('../app/api/me/passkeys/[passkeyId]/route')
  const personalSecurityRoute = await import('../app/api/me/security/route')
  const { createDesktopRpc } = await import('../lib/desktop-rpc/handler')
  const { desktopActions } = await import('../lib/desktop-rpc/registry')
  const { withDesktopSession } = await import('../lib/desktop-rpc/session')
  const { decode, encode } = await import('../lib/desktop-rpc/wire')
  const { createLegacyPersonalAccessToken, createPersonalAccessToken } = await import('../lib/tokens/store')
  const { deleteAccount } = await import('../lib/account/delete')

  assert.ok(authBaseURL)
  const origin = new URL(authBaseURL).origin
  const rpId = new URL(authBaseURL).hostname
  const context = await auth.$context

  const people = ['alice', 'bob', 'deletable'].map(name => ({
    id: randomUUID(),
    name,
    email: `${name}-${randomUUID()}@passkey.example.invalid`,
  }))
  const [alice, bob, deletable] = people
  const workspaces: string[] = []

  t.after(async () => {
    try {
      await database.query('DELETE FROM workspace_audit_outbox WHERE "workspaceId" = ANY($1::uuid[])', [workspaces])
      await database.query('DELETE FROM workspace_audit_events WHERE "workspaceId" = ANY($1::uuid[])', [workspaces])
      await database.query('DELETE FROM mikka_workspaces WHERE id = ANY($1::uuid[])', [workspaces])
      await database.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [people.map(p => p.id)])
    } finally {
      await (await import('../lib/builtin-gateway/runtime')).builtinGateway()?.stop()
      await Promise.all([database.end(), pool.end(), workspacePool.end()])
    }
  })

  const password = randomBytes(24).toString('base64url')
  const hashedPassword = await context.password.hash(password)
  for (const user of people) {
    await database.query(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, now(), now())',
      [user.id, user.name, user.email],
    )
    await database.query(
      'INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ($1, $2, $3, $2, $4, now(), now())',
      [randomUUID(), user.id, 'credential', hashedPassword],
    )
    const wsId = randomUUID()
    workspaces.push(wsId)
    await database.query('INSERT INTO mikka_workspaces (id, "userId", name, kind) VALUES ($1, $2, $3, $4)', [wsId, user.id, `${user.name}-ws`, 'team'])
    await database.query(
      'INSERT INTO mikka_workspace_members ("workspaceId", "userId", name, email, role) VALUES ($1, $2, $3, $4, $5)',
      [wsId, user.id, user.name, user.email, 'admin'],
    )
  }

  async function scoped(request: Request, work: () => Promise<Response>): Promise<Response> {
    const scope = createRequestScope(request)
    try {
      const response = await runRequestScope(scope, work)
      const headers = new Headers(response.headers)
      scope.cookies.commit(headers)
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    } finally {
      await scope.after.finish()
    }
  }

  async function authCall(method: 'GET' | 'POST', path: string, browser: Browser, body?: unknown, token?: string, extra?: Record<string, string>) {
    const headers = browser.headers(origin, token)
    for (const [k, v] of Object.entries(extra ?? {})) headers.set(k, v)
    const request = new Request(`${origin}${BASE_PATH}/api/auth${path}`, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    })
    const response = await scoped(request, () => auth.handler(request))
    browser.take(response)
    return response
  }

  async function restList(browser: Browser, token?: string) {
    const request = new Request(`${origin}/api/me/passkeys`, { headers: browser.headers(origin, token, false) })
    return scoped(request, () => passkeysListRoute.GET(request))
  }

  async function restPatch(passkeyId: string, body: unknown, browser: Browser, token?: string, customOrigin?: string | null) {
    const headers = browser.headers(origin, token, customOrigin !== null)
    if (customOrigin) headers.set('origin', customOrigin)
    const request = new Request(`${origin}/api/me/passkeys/${passkeyId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    })
    return scoped(request, () => passkeysItemRoute.PATCH(request, { params: Promise.resolve({ passkeyId }) }))
  }

  async function restDelete(passkeyId: string, browser: Browser, token?: string, customOrigin?: string | null) {
    const headers = browser.headers(origin, token, customOrigin !== null)
    if (customOrigin) headers.set('origin', customOrigin)
    const request = new Request(`${origin}/api/me/passkeys/${passkeyId}`, { method: 'DELETE', headers })
    return scoped(request, () => passkeysItemRoute.DELETE(request, { params: Promise.resolve({ passkeyId }) }))
  }

  const desktopRpc = createDesktopRpc({
    authenticate: async headers => {
      const token = headers.get('authorization')?.slice(7)
      if (!token) return null
      return auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }), query: { disableCookieCache: true } })
    },
    scope: withDesktopSession,
    actions: desktopActions,
  })

  async function rpcCall<T>(action: string, args: unknown[], bearerToken: string): Promise<{ status: number; result?: T }> {
    const request = new Request(`${origin}${BASE_PATH}/api/desktop/rpc`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
        'x-mikka-desktop-protocol': '1',
      },
      body: JSON.stringify({ version: 1, action, args: encode(args) }),
    })
    const response = await scoped(request, () => desktopRpc(request))
    if (response.status !== 200) return { status: response.status }
    const payload = await response.json() as { result: unknown }
    return { status: 200, result: decode(payload.result) as T }
  }

  const aliceBrowser = new Browser()
  const bobBrowser = new Browser()
  const aliceKey = new SoftwareAuthenticator()
  let alicePasskeyId = ''
  let aliceBearerToken = ''
  let bobBearerToken = ''

  await t.test('unauthenticated callers and PAT tokens are rejected across native, REST and Desktop RPC endpoints', async () => {
    const anon = new Browser()
    assert.equal((await authCall('GET', '/passkey/generate-register-options', anon)).status, 401)
    assert.equal((await authCall('POST', '/passkey/verify-registration', anon, { response: {} })).status, 401)
    assert.equal((await authCall('GET', '/passkey/list-user-passkeys', anon)).status, 401)
    assert.equal((await authCall('POST', '/passkey/update-passkey', anon, { id: 'pk_none', name: 'New' })).status, 401)
    assert.equal((await authCall('POST', '/passkey/delete-passkey', anon, { id: 'pk_none' })).status, 401)

    assert.equal((await restList(anon)).status, 401)
    assert.equal((await restPatch('pk_none', { name: 'New' }, anon)).status, 401)
    assert.equal((await restDelete('pk_none', anon)).status, 401)
    assert.equal((await rpcCall('passkeys.listPasskeys', [], '')).status, 401)

    // Both v1 and legacy PAT tokens cannot read or mutate personal passkeys
    const v1Pat = await createPersonalAccessToken(alice.id, workspaces[0], { name: 'Passkey v1 PAT Probe' })
    const legacyPat = await createLegacyPersonalAccessToken(alice.id, workspaces[0], { name: 'Passkey Legacy PAT Probe' })
    assert.equal((await restList(anon, v1Pat.token)).status, 401)
    assert.equal((await restList(anon, legacyPat.token)).status, 403)
    assert.equal((await restPatch('pk_none', { name: 'New' }, anon, legacyPat.token)).status, 403)
    assert.equal((await restDelete('pk_none', anon, legacyPat.token)).status, 403)
  })

  await t.test('authenticated user registers a passkey, signs in with WebAuthn assertion, and emits durable passkey audit', async t => {
    const login = await authCall('POST', '/sign-in/email', aliceBrowser, { email: alice.email, password })
    assert.equal(login.status, 200)
    aliceBearerToken = ((await login.json()) as { token: string }).token

    const bobLogin = await authCall('POST', '/sign-in/email', bobBrowser, { email: bob.email, password })
    assert.equal(bobLogin.status, 200)
    bobBearerToken = ((await bobLogin.json()) as { token: string }).token

    const regOptsRes = await authCall('GET', '/passkey/generate-register-options', aliceBrowser)
    assert.equal(regOptsRes.status, 200)
    const regOpts = await regOptsRes.json() as { challenge: string; rp: { id: string; name: string } }
    assert.equal(regOpts.rp.id, rpId)
    assert.equal(regOpts.rp.name, 'Mikka')

    // Omit custom name so afterVerification resolves "1Password" from AAGUID
    const attestation = aliceKey.attest(regOpts.challenge, origin, rpId)
    const regVerify = await authCall('POST', '/passkey/verify-registration', aliceBrowser, { response: attestation })
    assert.equal(regVerify.status, 200)
    const createdPasskey = await regVerify.json() as { id: string; name: string; backedUp: boolean; deviceType: string }
    assert.ok(createdPasskey.id)
    assert.equal(createdPasskey.name, '1Password')
    assert.equal(createdPasskey.backedUp, true)
    assert.equal(createdPasskey.deviceType, 'multiDevice')
    alicePasskeyId = createdPasskey.id

    // Safe summary via GET /api/me/passkeys omits publicKey, credentialID, counter, userId
    const listRes = await restList(aliceBrowser)
    assert.equal(listRes.status, 200)
    const listed = await listRes.json() as { passkeys: Array<Record<string, unknown>> }
    assert.equal(listed.passkeys.length, 1)
    assert.equal(listed.passkeys[0].id, alicePasskeyId)
    assert.equal(listed.passkeys[0].name, '1Password')
    assert.equal(listed.passkeys[0].providerName, '1Password')
    assert.deepEqual(listed.passkeys[0].transports, ['internal', 'hybrid'])
    for (const secretField of ['publicKey', 'credentialID', 'counter', 'userId']) {
      assert.equal(Object.hasOwn(listed.passkeys[0], secretField), false, `${secretField} must not leak in summary`)
    }

    // GET /api/me/security includes passkeyCount: 1
    const secReq = new Request(`${origin}/api/me/security`, { headers: aliceBrowser.headers(origin) })
    const secRes = await scoped(secReq, () => personalSecurityRoute.GET(secReq))
    assert.equal(secRes.status, 200)
    assert.equal(((await secRes.json()) as { passkeyCount: number }).passkeyCount, 1)

    // Real WebAuthn passkey login on a fresh signed-out browser
    const passkeyLoginBrowser = new Browser()
    const authOptsRes = await authCall('GET', '/passkey/generate-authenticate-options', passkeyLoginBrowser)
    assert.equal(authOptsRes.status, 200)
    const authOpts = await authOptsRes.json() as { challenge: string }
    const assertion = aliceKey.assert(authOpts.challenge, origin, rpId)
    const authVerifyRes = await authCall('POST', '/passkey/verify-authentication', passkeyLoginBrowser, { response: assertion }, undefined, { 'x-mikka-client': 'desktop' })
    assert.equal(authVerifyRes.status, 200)
    const authVerifyBody = await authVerifyRes.json() as { session: { id: string }; user: { id: string } }
    assert.equal(authVerifyBody.user.id, alice.id)
    assert.ok(authVerifyRes.headers.getSetCookie().length > 0)

    // Verify counter incremented in DB and durable audit queued with method: 'passkey'
    const { rows: [dbRow] } = await database.query<{ counter: number }>('SELECT counter FROM "passkey" WHERE id = $1', [alicePasskeyId])
    assert.equal(dbRow.counter, 2)
    const { rows: audits } = await database.query<{ payload: { action: string; targetId: string; metadata: { method: string } } }>(
      'SELECT payload FROM workspace_audit_outbox WHERE "workspaceId" = $1 AND payload->>\'action\' = \'auth.signed_in\'',
      [workspaces[0]],
    )
    assert.ok(audits.some(row => row.payload.targetId === authVerifyBody.session.id && row.payload.metadata.method === 'passkey'))

    // Outbox failure withholds session and cookies on passkey sign-in
    const failedAuditBrowser = new Browser()
    const opts2 = await (await authCall('GET', '/passkey/generate-authenticate-options', failedAuditBrowser)).json() as { challenge: string }
    const assertion2 = aliceKey.assert(opts2.challenge, origin, rpId)
    const sessionsBefore = (await database.query<{ n: number }>('SELECT count(*)::int AS n FROM session WHERE "userId" = $1', [alice.id])).rows[0].n
    const constraint = `passkey_audit_${randomUUID().replaceAll('-', '')}`
    await database.query(`ALTER TABLE workspace_audit_outbox ADD CONSTRAINT ${constraint} CHECK ("workspaceId" <> '${workspaces[0]}'::uuid) NOT VALID`)
    t.mock.method(console, 'error', () => {})
    try {
      const withheld = await authCall('POST', '/passkey/verify-authentication', failedAuditBrowser, { response: assertion2 }, undefined, { 'x-mikka-client': 'desktop' })
      assert.equal(withheld.status, 503)
      assert.equal(((await withheld.json()) as { code: string }).code, 'AUTH_AUDIT_UNAVAILABLE')
      assert.equal(withheld.headers.getSetCookie().length, 0)
      assert.equal(withheld.headers.has('x-mikka-session-cache'), false)
      const sessionsAfter = (await database.query<{ n: number }>('SELECT count(*)::int AS n FROM session WHERE "userId" = $1', [alice.id])).rows[0].n
      assert.equal(sessionsAfter, sessionsBefore)
    } finally {
      await database.query(`ALTER TABLE workspace_audit_outbox DROP CONSTRAINT ${constraint}`)
    }
  })

  await t.test('cross-user and cross-origin mutations are rejected while owner REST + Desktop RPC rename works', async () => {
    // Missing or cross-site Origin rejected on REST mutations
    assert.equal((await restPatch(alicePasskeyId, { name: 'CSRF' }, aliceBrowser, undefined, null)).status, 403)
    assert.equal((await restPatch(alicePasskeyId, { name: 'CSRF' }, aliceBrowser, undefined, 'https://evil.example')).status, 403)
    assert.equal((await restDelete(alicePasskeyId, aliceBrowser, undefined, 'https://evil.example')).status, 403)

    // User B (Bob) attempting to rename or delete User A's (Alice's) passkey is rejected across ALL surfaces
    assert.equal((await authCall('POST', '/passkey/update-passkey', bobBrowser, { id: alicePasskeyId, name: 'Hijacked' })).status, 401)
    assert.equal((await authCall('POST', '/passkey/delete-passkey', bobBrowser, { id: alicePasskeyId })).status, 401)
    assert.equal((await restPatch(alicePasskeyId, { name: 'Hijacked' }, bobBrowser)).status, 404)
    assert.equal((await restDelete(alicePasskeyId, bobBrowser)).status, 404)

    const bobRpcRename = await rpcCall<{ error?: string }>('passkeys.renamePasskey', [{ id: alicePasskeyId, name: 'Hijacked' }], bobBearerToken)
    assert.equal(bobRpcRename.status, 200)
    assert.deepEqual(bobRpcRename.result, { error: 'passkeyNotFound' })

    const bobRpcDelete = await rpcCall<{ error?: string }>('passkeys.deletePasskey', [{ id: alicePasskeyId }], bobBearerToken)
    assert.equal(bobRpcDelete.status, 200)
    assert.deepEqual(bobRpcDelete.result, { error: 'passkeyNotFound' })

    // Owner rename via REST PATCH
    assert.equal((await restPatch(alicePasskeyId, { name: '   ' }, aliceBrowser)).status, 400)
    const patched = await restPatch(alicePasskeyId, { name: 'Alice MacBook Pro' }, aliceBrowser)
    assert.equal(patched.status, 200)
    assert.equal(((await patched.json()) as { passkey: { name: string } }).passkey.name, 'Alice MacBook Pro')

    // Owner list & rename via Desktop RPC
    const rpcListed = await rpcCall<{ passkeys: Array<{ id: string; name: string }> }>('passkeys.listPasskeys', [], aliceBearerToken)
    assert.equal(rpcListed.status, 200)
    assert.equal(rpcListed.result?.passkeys[0]?.name, 'Alice MacBook Pro')

    const rpcRenamed = await rpcCall<{ passkey: { name: string } }>('passkeys.renamePasskey', [{ id: alicePasskeyId, name: 'Alice Studio Key' }], aliceBearerToken)
    assert.equal(rpcRenamed.status, 200)
    assert.equal(rpcRenamed.result?.passkey.name, 'Alice Studio Key')
  })

  await t.test('2FA-enabled account rejects passkey registration, rename and deletion from an unverified session until TOTP verified', async () => {
    // Enroll Alice in native TOTP 2FA without touching two-factor implementation
    const enroll = await authCall('POST', '/two-factor/enable', aliceBrowser, { password })
    assert.equal(enroll.status, 200)
    const setup = await enroll.json() as { totpURI: string }
    const totpSecret = new URL(setup.totpURI).searchParams.get('secret')!
    const verifyTotp = await authCall('POST', '/two-factor/verify-totp', aliceBrowser, { code: authenticatorCode(totpSecret) })
    assert.equal(verifyTotp.status, 200)
    const verifiedBearer = verifyTotp.headers.get('set-auth-token') || ((await verifyTotp.clone().json().catch(() => ({}))) as { token?: string }).token
    const verifiedSession = await auth.api.getSession({ headers: aliceBrowser.headers(origin), query: { disableCookieCache: true } })
    assert.ok(verifiedSession)
    const aliceVerifiedToken = verifiedBearer || verifiedSession.session.token

    // Create an unverified human session for Alice (e.g. OAuth / pre-step-up session)
    const unverified = await context.internalAdapter.createSession(alice.id)
    assert.ok(unverified)
    const unverifiedBrowser = new Browser()

    // Native passkey endpoints MUST reject unverified 2FA session with 403 TWO_FACTOR_REQUIRED
    for (const [method, path, body] of [
      ['GET', '/passkey/generate-register-options', undefined],
      ['POST', '/passkey/verify-registration', { response: {} }],
      ['POST', '/passkey/update-passkey', { id: alicePasskeyId, name: 'Bypass 2FA' }],
      ['POST', '/passkey/delete-passkey', { id: alicePasskeyId }],
    ] as const) {
      const res = await authCall(method, path, unverifiedBrowser, body, unverified.token)
      assert.equal(res.status, 403, `unverified 2FA session must be denied on ${path}`)
      assert.equal(((await res.json()) as { code: string }).code, 'TWO_FACTOR_REQUIRED')
    }

    // REST management endpoints MUST reject unverified 2FA session with 403 TWO_FACTOR_REQUIRED
    const unverifiedPatch = await restPatch(alicePasskeyId, { name: 'Bypass 2FA' }, unverifiedBrowser, unverified.token)
    assert.equal(unverifiedPatch.status, 403)
    assert.equal(((await unverifiedPatch.json()) as { error: { code: string } }).error.code, 'TWO_FACTOR_REQUIRED')

    const unverifiedDelete = await restDelete(alicePasskeyId, unverifiedBrowser, unverified.token)
    assert.equal(unverifiedDelete.status, 403)
    assert.equal(((await unverifiedDelete.json()) as { error: { code: string } }).error.code, 'TWO_FACTOR_REQUIRED')

    // Desktop RPC mutations MUST reject unverified 2FA session with error: 'twoFactorRequired'
    const rpcDeniedRename = await rpcCall<{ error?: string }>('passkeys.renamePasskey', [{ id: alicePasskeyId, name: 'Bypass 2FA' }], unverified.token)
    assert.deepEqual(rpcDeniedRename.result, { error: 'twoFactorRequired' })
    const rpcDeniedDelete = await rpcCall<{ error?: string }>('passkeys.deletePasskey', [{ id: alicePasskeyId }], unverified.token)
    assert.deepEqual(rpcDeniedDelete.result, { error: 'twoFactorRequired' })

    // Verified 2FA session CAN register a second passkey and delete passkeys
    const secondKey = new SoftwareAuthenticator('ea9b8d664d011d213ce4b6b48cb575d4') // Google Password Manager
    const regOpts2 = await (await authCall('GET', '/passkey/generate-register-options', aliceBrowser)).json() as { challenge: string }
    const regVerify2 = await authCall('POST', '/passkey/verify-registration', aliceBrowser, {
      response: secondKey.attest(regOpts2.challenge, origin, rpId),
      name: 'Phone Passkey',
    })
    assert.equal(regVerify2.status, 200)
    const secondPasskeyId = ((await regVerify2.json()) as { id: string }).id

    // Delete second passkey via Desktop RPC using verified 2FA session
    const rpcDeleted = await rpcCall<{ deleted: boolean }>('passkeys.deletePasskey', [{ id: secondPasskeyId }], aliceVerifiedToken)
    assert.deepEqual(rpcDeleted.result, { deleted: true })

    // Delete first passkey via REST DELETE using verified 2FA session
    const restDeleted = await restDelete(alicePasskeyId, aliceBrowser)
    assert.equal(restDeleted.status, 200)
    assert.deepEqual(await restDeleted.json(), { deleted: true })

    const afterDelete = await restList(aliceBrowser)
    assert.deepEqual(await afterDelete.json(), { passkeys: [] })
  })

  await t.test('account deletion removes owned passkey credentials cleanly', async () => {
    const delBrowser = new Browser()
    assert.equal((await authCall('POST', '/sign-in/email', delBrowser, { email: deletable.email, password })).status, 200)
    const delKey = new SoftwareAuthenticator()
    const opts = await (await authCall('GET', '/passkey/generate-register-options', delBrowser)).json() as { challenge: string }
    const reg = await authCall('POST', '/passkey/verify-registration', delBrowser, {
      response: delKey.attest(opts.challenge, origin, rpId),
    })
    assert.equal(reg.status, 200)
    assert.equal((await database.query<{ n: number }>('SELECT count(*)::int AS n FROM "passkey" WHERE "userId" = $1', [deletable.id])).rows[0].n, 1)

    const outcome = await deleteAccount(deletable.id, deletable.email, {
      mainPool: database,
      workspacePool: database,
      externalCleanup: async () => [],
    })
    assert.equal(outcome.ok, true)
    assert.equal((await database.query<{ n: number }>('SELECT count(*)::int AS n FROM "passkey" WHERE "userId" = $1', [deletable.id])).rows[0].n, 0)
  })
})

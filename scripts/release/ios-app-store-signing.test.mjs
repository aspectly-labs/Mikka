import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ascToken, ensureProfiles, exportOptionsPlist, installProfiles, normalizeSerial, profileName } from './ios-app-store-signing.mjs'

const workflow = readFileSync(new URL('../../.github/workflows/mobile-next-ios.yml', import.meta.url), 'utf8')
const source = readFileSync(new URL('./ios-app-store-signing.mjs', import.meta.url), 'utf8')
const step = name => {
  const start = workflow.indexOf(`- name: ${name}`)
  assert.ok(start >= 0, name)
  const next = workflow.indexOf('\n      - ', start + 1)
  return workflow.slice(start, next < 0 ? undefined : next)
}

test('certificate serials compare as normalized uppercase hex', () => {
  assert.equal(normalizeSerial('serial=00ab:12'), 'AB12')
  assert.equal(normalizeSerial('4D1E'), '4D1E')
  assert.equal(normalizeSerial('000'), '0')
  assert.throws(() => normalizeSerial('xyz'), /RELEASE_IOS_SERIAL_INVALID/)
  assert.throws(() => normalizeSerial(''), /RELEASE_IOS_SERIAL_INVALID/)
})

test('the App Store Connect token is a short-lived ES256 JWT the key verifies', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const token = ascToken({ keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'ABC123DEF4', issuerId: '11111111-2222-3333-4444-555555555555', now: 1000 })
  const [header, payload, signature] = token.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'ABC123DEF4', typ: 'JWT' })
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iss: '11111111-2222-3333-4444-555555555555', iat: 1000, exp: 2200, aud: 'appstoreconnect-v1' })
  assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')))
})

test('export options sign manually with the imported identity and each profile', () => {
  const plist = exportOptionsPlist({ teamId: 'TEAM123456', identity: 'A'.repeat(40), profiles: [{ bundleId: 'com.aspectlylabs.mikka', name: 'Mikka next & co' }] })
  assert.match(plist, /<key>signingStyle<\/key><string>manual<\/string>/)
  assert.match(plist, /<key>method<\/key><string>app-store-connect<\/string>/)
  assert.match(plist, new RegExp(`<key>signingCertificate</key><string>${'A'.repeat(40)}</string>`))
  assert.match(plist, /<key>com\.aspectlylabs\.mikka<\/key><string>Mikka next &amp; co<\/string>/)
  assert.doesNotMatch(plist, /automatic/)
})

function fakeAsc({ certificates, bundles, profiles = [], pageSize = 200 }) {
  const calls = []
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) })
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url)
    const { pathname, searchParams } = parsed
    calls.push({ method: init.method, pathname, body: init.body ? JSON.parse(init.body) : undefined })
    if (init.method === 'GET' && pathname === '/v1/certificates') return reply(200, { data: certificates })
    if (init.method === 'GET' && pathname === '/v1/bundleIds') return reply(200, { data: bundles.filter(b => b.attributes.identifier.includes(searchParams.get('filter[identifier]'))) })
    if (init.method === 'GET' && pathname === '/v1/profiles') {
      const exactName = searchParams.get('filter[name]')
      const filtered = exactName ? profiles.filter(p => p.attributes.name === exactName) : profiles
      const cursor = Number(searchParams.get('cursor') ?? '0')
      const slice = filtered.slice(cursor, cursor + pageSize)
      const nextCursor = cursor + pageSize
      const links = nextCursor < filtered.length ? { next: `https://api.appstoreconnect.apple.com/v1/profiles?filter[profileType]=IOS_APP_STORE&include=certificates,bundleId&cursor=${nextCursor}` } : {}
      return reply(200, { data: slice, links })
    }
    if (init.method === 'POST' && pathname === '/v1/profiles') return reply(201, { data: { id: 'NEWPROFILE1', attributes: { name: JSON.parse(init.body).data.attributes.name, uuid: '00000000-0000-0000-0000-000000000002', profileContent: Buffer.from('new').toString('base64'), profileState: 'ACTIVE' } } })
    return reply(404, { errors: [{ code: 'NOT_FOUND' }] })
  }
  return { calls, fetchImpl }
}

const certificate = { id: 'CERTID0001', attributes: { serialNumber: '00AB12CD34EF', certificateType: 'DISTRIBUTION' } }
const bundles = [
  { id: 'BUNDLEID01', attributes: { identifier: 'com.aspectlylabs.mikka' } },
  { id: 'BUNDLEID02', attributes: { identifier: 'com.aspectlylabs.mikka.dev' } },
]

test('an existing active profile matching bundleId and certificate is reused without creating anything', async () => {
  const serial = normalizeSerial('AB12CD34EF')
  const existing = {
    id: 'PROFILEID1',
    attributes: { name: profileName('com.aspectlylabs.mikka', serial), uuid: '00000000-0000-0000-0000-000000000001', profileContent: Buffer.from('old').toString('base64'), profileState: 'ACTIVE' },
    relationships: { bundleId: { data: { type: 'bundleIds', id: 'BUNDLEID01' } }, certificates: { data: [{ type: 'certificates', id: 'CERTID0001' }] } },
  }
  const { calls, fetchImpl } = fakeAsc({ certificates: [certificate], bundles, profiles: [existing] })
  const result = await ensureProfiles({ fetchImpl, token: 't', serial, bundleIds: ['com.aspectlylabs.mikka'] })
  assert.deepEqual(result.map(p => [p.bundleId, p.uuid, p.name]), [['com.aspectlylabs.mikka', '00000000-0000-0000-0000-000000000001', existing.attributes.name]])
  assert.ok(calls.every(call => call.method === 'GET'))
})

test('an active same-name profile bound to a different certificate is NOT reused; a compatible profile is created under an unused name', async () => {
  const serial = normalizeSerial('AB12CD34EF')
  const baseName = profileName('com.aspectlylabs.mikka', serial)
  const mismatched = {
    id: 'PROFILEID_WRONG_CERT',
    attributes: { name: baseName, uuid: '00000000-0000-0000-0000-000000000099', profileContent: Buffer.from('wrong').toString('base64'), profileState: 'ACTIVE' },
    relationships: { bundleId: { data: { type: 'bundleIds', id: 'BUNDLEID01' } }, certificates: { data: [{ type: 'certificates', id: 'OTHERCERT9' }] } },
  }
  const { calls, fetchImpl } = fakeAsc({ certificates: [certificate], bundles, profiles: [mismatched] })
  const [profile] = await ensureProfiles({ fetchImpl, token: 't', serial, bundleIds: ['com.aspectlylabs.mikka'] })
  assert.equal(profile.name, `${baseName} 2`)
  assert.equal(profile.uuid, '00000000-0000-0000-0000-000000000002')
  const created = calls.filter(call => call.method === 'POST')
  assert.equal(created.length, 1)
  assert.equal(created[0].body.data.attributes.name, `${baseName} 2`)
  assert.deepEqual(created[0].body.data.relationships, {
    bundleId: { data: { type: 'bundleIds', id: 'BUNDLEID01' } },
    certificates: { data: [{ type: 'certificates', id: 'CERTID0001' }] },
  })
  const compatible = {
    id: 'PROFILEID_SUF2',
    attributes: { name: `${baseName} 2`, uuid: '00000000-0000-0000-0000-000000000002', profileContent: Buffer.from('good').toString('base64'), profileState: 'ACTIVE' },
    relationships: { bundleId: { data: { type: 'bundleIds', id: 'BUNDLEID01' } }, certificates: { data: [{ type: 'certificates', id: 'CERTID0001' }] } },
  }
  const secondRun = fakeAsc({ certificates: [certificate], bundles, profiles: [mismatched, compatible], pageSize: 1 })
  const [reused] = await ensureProfiles({ fetchImpl: secondRun.fetchImpl, token: 't', serial, bundleIds: ['com.aspectlylabs.mikka'] })
  assert.equal(reused.name, `${baseName} 2`)
  assert.equal(reused.uuid, '00000000-0000-0000-0000-000000000002')
  assert.ok(secondRun.calls.every(call => call.method === 'GET'))
})

test('a missing profile is created for the exact bundle id and the registered certificate only', async () => {
  const { calls, fetchImpl } = fakeAsc({ certificates: [certificate], bundles })
  const [profile] = await ensureProfiles({ fetchImpl, token: 't', serial: 'AB12CD34EF', bundleIds: ['com.aspectlylabs.mikka'] })
  assert.equal(profile.uuid, '00000000-0000-0000-0000-000000000002')
  const created = calls.filter(call => call.method !== 'GET')
  assert.equal(created.length, 1)
  assert.equal(created[0].pathname, '/v1/profiles')
  assert.deepEqual(created[0].body.data.relationships, {
    bundleId: { data: { type: 'bundleIds', id: 'BUNDLEID01' } },
    certificates: { data: [{ type: 'certificates', id: 'CERTID0001' }] },
  })
  assert.equal(created[0].body.data.attributes.profileType, 'IOS_APP_STORE')
})

test('an unregistered certificate or bundle id fails closed before any write', async () => {
  const unknownCert = fakeAsc({ certificates: [certificate], bundles })
  await assert.rejects(ensureProfiles({ fetchImpl: unknownCert.fetchImpl, token: 't', serial: 'FFFF', bundleIds: ['com.aspectlylabs.mikka'] }), /RELEASE_IOS_CERTIFICATE_NOT_REGISTERED/)
  const unknownBundle = fakeAsc({ certificates: [certificate], bundles })
  await assert.rejects(ensureProfiles({ fetchImpl: unknownBundle.fetchImpl, token: 't', serial: 'AB12CD34EF', bundleIds: ['com.aspectlylabs.other'] }), /RELEASE_IOS_BUNDLE_ID_NOT_REGISTERED/)
  for (const { calls } of [unknownCert, unknownBundle]) assert.ok(calls.every(call => call.method === 'GET'))
})

test('profiles are installed where Xcode reads them', () => {
  const home = mkdtempSync(join(tmpdir(), 'ios-profiles-'))
  installProfiles([{ uuid: '00000000-0000-0000-0000-000000000003', content: Buffer.from('profile').toString('base64') }], home)
  for (const directory of ['Library/MobileDevice/Provisioning Profiles', 'Library/Developer/Xcode/UserData/Provisioning Profiles']) {
    assert.deepEqual(readdirSync(join(home, directory)), ['00000000-0000-0000-0000-000000000003.mobileprovision'])
    assert.equal(readFileSync(join(home, directory, '00000000-0000-0000-0000-000000000003.mobileprovision'), 'utf8'), 'profile')
  }
})

test('the profile helper never creates, revokes or deletes certificates', () => {
  assert.doesNotMatch(source, /'POST', '\/certificates/)
  assert.doesNotMatch(source, /'DELETE'/)
  assert.doesNotMatch(source, /'PATCH'/)
})

test('the workflow reads the persistent identity through OIDC and never lets Xcode provision certificates', () => {
  for (const name of ['APPLE_IOS_DISTRIBUTION_P12_BASE64', 'APPLE_IOS_DISTRIBUTION_P12_PASSWORD']) {
    const read = step(`Read existing ${name} through OIDC`)
    for (const required of ['method: oidc', 'identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac', 'env-slug: prod', 'secret-path: /platform', `secret-name: ${name}`, 'recursive: false', 'include-imports: false']) assert.ok(read.includes(required), `${name}: ${required}`)
    assert.ok(!workflow.includes(`secrets.${name}`))
  }
  const importStep = step('Import the persistent Apple Distribution identity')
  for (const required of ['security create-keychain', 'security import', 'set-key-partition-list', 'rm -f "$p12"', 'APPLE_IOS_DISTRIBUTION_P12_BASE64=', 'APPLE_IOS_DISTRIBUTION_P12_PASSWORD=']) assert.ok(importStep.includes(required), required)
  for (const name of ['Archive with the Apple Distribution identity', 'Export the App Store build']) {
    const body = step(name)
    for (const forbidden of ['-allowProvisioningUpdates', 'CODE_SIGN_STYLE=Automatic', '-authenticationKeyPath', '<string>automatic</string>']) assert.ok(!body.includes(forbidden), `${name}: ${forbidden}`)
  }
  assert.ok(!workflow.includes('-allowProvisioningUpdates'))
  const cleanup = step('Remove the signing keychain and the App Store Connect key')
  assert.ok(cleanup.includes('if: always()'))
  assert.ok(cleanup.includes('security delete-keychain'))
  const testIndex = workflow.indexOf('node --test scripts/release/ios-app-store-signing.test.mjs')
  const credIndex = workflow.indexOf('Read the private UI checkout credential')
  assert.ok(testIndex >= 0 && credIndex > testIndex, 'pre-credential signing test must run before private checkout credential')
})

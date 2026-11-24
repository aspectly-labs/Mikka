// Pairs each signable iOS target with the persistent Apple Distribution certificate for
// mobile-next-ios.yml. The existing App Store Connect API key finds (or creates) the App Store
// provisioning profile for that certificate, the profile is installed for Xcode and the export
// options for manual signing are written. It never creates or revokes a certificate: an ephemeral
// runner that creates one loses its private key and permanently uses up an account slot.
// Public logs get profile names and fixed error codes only.
import { createPrivateKey, sign } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const API = 'https://api.appstoreconnect.apple.com/v1'
const BUNDLE_ID = /^[A-Za-z0-9.-]+$/

export function normalizeSerial(value) {
  const hex = String(value ?? '').replace(/^serial=/i, '').replace(/[\s:]/g, '').toUpperCase()
  if (!/^[0-9A-F]+$/.test(hex)) throw Error('RELEASE_IOS_SERIAL_INVALID')
  return hex.replace(/^0+(?=.)/, '')
}

const base64url = value => Buffer.from(value).toString('base64url')

export function ascToken({ keyPem, keyId, issuerId, now = Math.floor(Date.now() / 1000) }) {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ iss: issuerId, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' }))
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key: createPrivateKey(keyPem), dsaEncoding: 'ieee-p1363' })
  return `${header}.${payload}.${base64url(signature)}`
}

export function profileName(bundleId, serial) {
  return `Mikka next App Store ${bundleId} ${serial.slice(-8)}`
}

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function exportOptionsPlist({ teamId, identity, profiles }) {
  const entries = profiles.map(p => `      <key>${xml(p.bundleId)}</key><string>${xml(p.name)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>signingStyle</key><string>manual</string>
  <key>teamID</key><string>${xml(teamId)}</string>
  <key>signingCertificate</key><string>${xml(identity)}</string>
  <key>provisioningProfiles</key>
  <dict>
${entries}
  </dict>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
`
}

function ascError(method, path, status, body) {
  const route = path.split('?')[0].replace(/\/[A-Za-z0-9-]{8,}(?=\/|$)/g, '/:id')
  const code = body?.errors?.[0]?.code
  const error = Error('RELEASE_IOS_ASC_REQUEST_FAILED')
  error.detail = `${method} ${route} -> ${status}${typeof code === 'string' && /^[A-Z_.]+$/i.test(code) ? ` ${code}` : ''}`
  return error
}

async function asc(fetchImpl, token, method, path, body) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let json = {}
  try { json = text ? JSON.parse(text) : {} } catch { json = {} }
  if (!response.ok) throw ascError(method, path, response.status, json)
  return json
}

async function listPages(fetchImpl, token, initialPath, maxPages = 20) {
  const items = []
  let path = initialPath
  for (let page = 0; path && page < maxPages; page += 1) {
    const response = await asc(fetchImpl, token, 'GET', path)
    if (Array.isArray(response.data)) items.push(...response.data)
    const next = response.links?.next
    if (typeof next !== 'string' || !next) break
    if (!next.startsWith(`${API}/`)) throw Error('RELEASE_IOS_ASC_PAGINATION_INVALID')
    path = next.slice(API.length)
  }
  return items
}

export function profileMatches(profile, { bundleId, certificateId }) {
  if (profile?.attributes?.profileState !== 'ACTIVE') return false
  if (profile?.relationships?.bundleId?.data?.id !== bundleId) return false
  const certs = profile?.relationships?.certificates?.data
  return Array.isArray(certs) && certs.some(item => item?.id === certificateId)
}

export async function ensureProfiles({ fetchImpl = fetch, token, serial, bundleIds }) {
  const certificates = await listPages(fetchImpl, token, '/certificates?filter[certificateType]=IOS_DISTRIBUTION,DISTRIBUTION&limit=200')
  const certificate = certificates.find(item => {
    try { return normalizeSerial(item.attributes?.serialNumber) === serial } catch { return false }
  })
  if (!certificate) throw Error('RELEASE_IOS_CERTIFICATE_NOT_REGISTERED')
  const allProfiles = await listPages(fetchImpl, token, '/profiles?filter[profileType]=IOS_APP_STORE&include=certificates,bundleId&limit=200')
  const profiles = []
  for (const bundleId of bundleIds) {
    if (!BUNDLE_ID.test(bundleId)) throw Error('RELEASE_IOS_BUNDLE_ID_INVALID')
    const bundles = await asc(fetchImpl, token, 'GET', `/bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}&limit=200`)
    const bundle = (bundles.data ?? []).find(item => item.attributes?.identifier === bundleId)
    if (!bundle) throw Error('RELEASE_IOS_BUNDLE_ID_NOT_REGISTERED')
    const baseName = profileName(bundleId, serial)
    const candidates = allProfiles.filter(item => {
      const candidateName = item?.attributes?.name ?? ''
      return candidateName === baseName || candidateName.startsWith(`${baseName} `)
    })
    let profile = candidates.find(item => profileMatches(item, { bundleId: bundle.id, certificateId: certificate.id }))
    if (!profile) {
      const takenNames = new Set(allProfiles.map(item => item?.attributes?.name).filter(Boolean))
      let createName = baseName
      for (let suffix = 2; takenNames.has(createName); suffix += 1) {
        if (suffix > 100) throw Error('RELEASE_IOS_PROFILE_NAME_EXHAUSTED')
        createName = `${baseName} ${suffix}`
      }
      const created = await asc(fetchImpl, token, 'POST', '/profiles', {
        data: {
          type: 'profiles',
          attributes: { name: createName, profileType: 'IOS_APP_STORE' },
          relationships: {
            bundleId: { data: { type: 'bundleIds', id: bundle.id } },
            certificates: { data: [{ type: 'certificates', id: certificate.id }] },
          },
        },
      })
      profile = created.data
      if (profile) allProfiles.push(profile)
    }
    const { name: actualName, uuid, profileContent } = profile?.attributes ?? {}
    if (typeof actualName !== 'string' || !actualName || typeof uuid !== 'string' || !/^[0-9A-Fa-f-]{36}$/.test(uuid) || typeof profileContent !== 'string' || !profileContent) throw Error('RELEASE_IOS_PROFILE_INVALID')
    profiles.push({ bundleId, name: actualName, uuid, content: profileContent })
  }
  return profiles
}

export function installProfiles(profiles, home = homedir()) {
  for (const directory of [join(home, 'Library/MobileDevice/Provisioning Profiles'), join(home, 'Library/Developer/Xcode/UserData/Provisioning Profiles')]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    for (const profile of profiles) writeFileSync(join(directory, `${profile.uuid}.mobileprovision`), Buffer.from(profile.content, 'base64'), { mode: 0o600 })
  }
}

function option(argv, name) {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  if (!value) throw Error('RELEASE_IOS_USAGE')
  return value
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
  const identity = env.IOS_SIGNING_IDENTITY ?? ''
  const teamId = env.APPLE_TEAM_ID ?? ''
  if (!/^[0-9A-F]{40}$/.test(identity)) throw Error('RELEASE_IOS_IDENTITY_INVALID')
  if (!/^[A-Z0-9]{1,30}$/.test(teamId)) throw Error('RELEASE_IOS_TEAM_INVALID')
  if (!/^[A-Z0-9]{1,30}$/.test(env.APPLE_API_KEY_ID ?? '') || !/^[0-9a-f-]{36}$/i.test(env.APPLE_API_ISSUER ?? '')) throw Error('RELEASE_IOS_ASC_KEY_INVALID')
  const serial = normalizeSerial(env.IOS_SIGNING_SERIAL)
  const bundleIds = JSON.parse(readFileSync(option(argv, '--bundle-ids'), 'utf8'))
  if (!Array.isArray(bundleIds) || bundleIds.length === 0) throw Error('RELEASE_IOS_BUNDLE_ID_INVALID')
  const keyPem = Buffer.from(env.APPLE_API_KEY_P8_BASE64 ?? '', 'base64').toString('utf8')
  const token = ascToken({ keyPem, keyId: env.APPLE_API_KEY_ID, issuerId: env.APPLE_API_ISSUER })
  const profiles = await ensureProfiles({ fetchImpl, token, serial, bundleIds })
  installProfiles(profiles, env.HOME || homedir())
  writeFileSync(option(argv, '--profiles'), JSON.stringify(Object.fromEntries(profiles.map(p => [p.bundleId, { name: p.name, uuid: p.uuid }]))), { mode: 0o600 })
  writeFileSync(option(argv, '--export-options'), exportOptionsPlist({ teamId, identity, profiles }), { mode: 0o600 })
  for (const profile of profiles) console.log(`App Store profile: ${profile.name}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = /^RELEASE_IOS_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'RELEASE_IOS_SIGNING_FAILED'
    console.error(error?.detail ? `${code}: ${error.detail}` : code)
    process.exitCode = 1
  })
}

// Real PostgreSQL + the production Better Auth instance (lib/auth.ts) with the
// mobile refresh plugin (lib/auth-mobile-refresh.ts). Isolated *_e2e database only.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import { isE2eTarget } from './helpers/e2e-target.mjs'
import { withBasePath } from '../lib/base-path'

const dbUrl = process.env.MIKKA_DATABASE_URL ?? process.env.DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !dbUrl) throw new Error('Mobile refresh tests require an isolated loopback *_e2e database')
// The native app's origin; official cloud trusts it already (lib/auth-config.ts).
process.env.AUTH_TRUSTED_ORIGINS = [process.env.AUTH_TRUSTED_ORIGINS, 'mikka://'].filter(Boolean).join(',')
process.env.BETTER_AUTH_URL ??= 'http://127.0.0.1:3000'
const NATIVE = 'mikka://'
const skip = !dbUrl

let auth: typeof import('../lib/auth').auth
let pool: import('pg').Pool
let origin: string
let refresh: typeof import('../lib/auth-mobile-refresh')
const users: string[] = []

/** The Expo plugin's cookie jar, reduced to what matters: name → value, deleted by Max-Age=0. */
class Jar {
  cookies = new Map<string, string>()
  /** Each device has its own address, as Better Auth's per-address rate limits expect. */
  ip = `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`
  take(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';')
      const index = pair.indexOf('=')
      const name = pair.slice(0, index).trim(), value = pair.slice(index + 1)
      if (attributes.some(attribute => /^\s*max-age=0\s*$/i.test(attribute))) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return response
  }
  header() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') }
  multi() { return [...this.cookies.keys()].filter(name => name.includes('_multi-')) }
}

async function call(path: string, options: { jar?: Jar; body?: unknown; origin?: string } = {}) {
  const read = path.startsWith('/get-session')
  const headers = new Headers({ origin: options.origin ?? NATIVE, 'user-agent': 'Mikka/1.0 (iPhone; iOS 18.1)', 'x-forwarded-for': options.jar?.ip ?? new Jar().ip })
  if (options.jar?.cookies.size) headers.set('cookie', options.jar.header())
  if (!read) headers.set('content-type', 'application/json')
  const response = await auth.handler(new Request(`${origin}${withBasePath(`/api/auth${path}`)}`, {
    method: read ? 'GET' : 'POST', headers, body: read ? undefined : JSON.stringify(options.body ?? {}),
  }))
  options.jar?.take(response)
  return response
}

type Issued = { userId: string; sessionId: string; refreshToken: string; refreshExpiresAt: string; accessExpiresAt: string }
async function issued(response: Response): Promise<Issued> {
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return await response.json() as Issued
}
async function refusal(response: Response) {
  assert.equal(response.status, 401)
  assert.equal((await response.json() as { code: string }).code, refresh.REFRESH_REJECTED)
}

/** A person signed in on the phone (an email sign-in through the native origin) with a jar like the app's. */
async function phone() {
  const id = `mobile-refresh-${randomBytes(6).toString('hex')}`
  const email = `${id}@example.test`, password = randomBytes(24).toString('base64url')
  await pool.query('insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, $1, $2, true, now(), now())', [id, email])
  users.push(id)
  const context = await auth.$context
  await context.internalAdapter.createAccount({ userId: id, accountId: id, providerId: 'credential', password: await context.password.hash(password) })
  const jar = new Jar()
  const signedIn = await call('/sign-in/email', { jar, body: { email, password } })
  assert.equal(signedIn.status, 200)
  const session = await sessionOf(jar)
  assert.ok(session, 'the phone is signed in')
  return { id, email, password, jar, session }
}
async function sessionOf(jar: Jar) {
  const response = await call('/get-session?disableCookieCache=true', { jar })
  return await response.json() as { session: { id: string; token: string; expiresAt: string }; user: { id: string } } | null
}
const rows = async (userId: string) => (await pool.query<{ id: string; family_id: string; session_id: string | null; session_rotated: boolean; used_at: Date | null; revoked_at: Date | null; revoked_reason: string | null; replaced_by: string | null; token_hash: string }>(
  'select * from mobile_refresh_tokens where user_id = $1 order by created_at, id', [userId])).rows
/**
 * Resolves once another backend waits on a lock `holder` holds (and, given
 * `query`, runs a statement like it), so an interleaving never rests on timing.
 */
async function blockedBy(holder: import('pg').PoolClient, query = '%') {
  const { rows: [{ pid }] } = await holder.query<{ pid: number }>('select pg_backend_pid() as pid')
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rowCount } = await pool.query('select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid)) and query like $2', [pid, query])
    if (rowCount) return
    await delay(25)
  }
  assert.fail(`nothing waited on the lock held by backend ${pid}`)
}
/** A held connection goes back to the pool with its locks gone, even when the test failed before its commit. */
async function settle(held: import('pg').PoolClient) {
  await held.query('rollback').catch(() => undefined)
  held.release()
}
/** The access session a first rotation mints when the expired one is gone (Better Auth's own createSession). */
async function replacementFor(userId: string) {
  const created = await (await auth.$context).internalAdapter.createSession(userId, false, { expiresAt: new Date(Date.now() + 3600_000) }, true)
  assert.ok(created)
  return created
}
const sessionRow = async (id: string) => (await pool.query<{ id: string; expiresAt: Date; twoFactorVerifiedAt: Date | null; twoFactorMethod: string | null }>(
  'select id, "expiresAt", "twoFactorVerifiedAt", "twoFactorMethod" from session where id = $1', [id])).rows[0]

before(async () => {
  if (skip) return
  assert.ok(isE2eTarget(dbUrl), 'mobile refresh tests require an isolated e2e database')
  const { Pool } = await import('pg')
  pool = new Pool({ connectionString: dbUrl, max: 4 })
  auth = (await import('../lib/auth')).auth
  refresh = await import('../lib/auth-mobile-refresh')
  origin = new URL((await auth.$context).baseURL).origin
})
after(async () => {
  if (skip) return
  await pool.query('delete from "user" where id = any($1)', [users])
  assert.equal((await pool.query('select count(*)::int as n from mobile_refresh_tokens where user_id = any($1)', [users])).rows[0].n, 0, 'deleting the person deletes their refresh tokens')
  await pool.end()
  await (await import('../lib/db')).pool.end()
})

test('exchange starts a family bound to the signed-in session, only for the native app', { skip }, async () => {
  const person = await phone()
  assert.ok(person.session)
  assert.equal((await call('/mobile-refresh/exchange', { jar: person.jar, origin })).status, 403, 'a web page cannot mint a refresh token from the cookie')
  assert.equal((await call('/mobile-refresh/exchange')).status, 401, 'no session, no refresh token')
  const first = await issued(await call('/mobile-refresh/exchange', { jar: person.jar }))
  assert.match(first.refreshToken, /^mkmr_[A-Za-z0-9_-]{43}$/)
  assert.equal(first.userId, person.id, 'the app binds the credential to the person it signed in')
  assert.equal(first.accessExpiresAt, new Date(person.session.session.expiresAt).toISOString(), 'the exchanged session keeps its own lifetime')
  const stored = await rows(person.id)
  assert.equal(stored.length, 1)
  assert.equal(stored[0].session_id, person.session.session.id)
  assert.equal(stored[0].session_rotated, false)
  assert.notEqual(stored[0].token_hash, first.refreshToken, 'only the hash is stored')
  // A second exchange for the same session (a lost keychain) replaces the first family.
  const second = await issued(await call('/mobile-refresh/exchange', { jar: person.jar }))
  await refusal(await call('/mobile-refresh/rotate', { body: { refreshToken: first.refreshToken } }))
  await issued(await call('/mobile-refresh/rotate', { jar: person.jar, body: { refreshToken: second.refreshToken } }))
  assert.equal((await rows(person.id)).find(row => row.id === stored[0].id)?.revoked_reason, 'replaced')
})

test('rotate renews the access session in place as a one-hour cookie and keeps the family', { skip }, async () => {
  const person = await phone()
  const first = await issued(await call('/mobile-refresh/exchange', { jar: person.jar }))
  const stale = new Jar(); stale.cookies = new Map(person.jar.cookies); stale.ip = person.jar.ip
  const rotation = await call('/mobile-refresh/rotate', { jar: person.jar, body: { refreshToken: first.refreshToken } })
  const sessionCookie = rotation.headers.getSetCookie().find(line => /session_token=/.test(line) && !/_multi-/.test(line))
  const maxAge = Number(/max-age=(\d+)/i.exec(sessionCookie ?? '')?.[1])
  assert.ok(maxAge > 3500 && maxAge <= 3600, `the cookie ends with the access session, so the app's jar drops it on time (Max-Age ${maxAge})`)
  const second = await issued(rotation)
  assert.equal(second.sessionId, person.session.session.id)
  assert.notEqual(person.jar.header(), stale.header(), 'the response set the renewed session cookie')
  assert.notEqual(second.refreshToken, first.refreshToken)
  const minutes = (Date.parse(second.accessExpiresAt) - Date.now()) / 60_000
  assert.ok(minutes > 58 && minutes <= 60, `access session lasts an hour, got ${minutes}`)
  const current = await sessionOf(person.jar)
  assert.equal(current?.session.id, person.session.session.id, 'the same session: its id, pushes and outbox stay')
  assert.equal(new Date(current!.session.expiresAt).toISOString(), second.accessExpiresAt)
  assert.equal(await sessionOf(stale), null, 'the previous cookie stopped working')
  assert.deepEqual(person.jar.multi().filter(name => name.endsWith(person.session.session.token.toLowerCase())), [], 'the old multi-session cookie was expired')
  const family = await rows(person.id)
  assert.equal(family.length, 2)
  assert.ok(family.every(row => row.revoked_at === null), 'rotation never revokes its own family')
  assert.equal(family[0].replaced_by, family[1].id)
  assert.equal(family[0].session_id, null)
  assert.equal(family[1].session_id, current!.session.id)
  assert.equal(family[1].session_rotated, true)
  // The next rotation works from the new token, after the hour has run out too.
  await pool.query(`update session set "expiresAt" = now() - interval '1 second' where id = $1`, [current!.session.id])
  const third = await issued(await call('/mobile-refresh/rotate', { jar: person.jar, body: { refreshToken: second.refreshToken } }))
  assert.equal((await sessionOf(person.jar))?.session.id, current!.session.id)
  assert.ok(third.refreshToken)
})

test('a rotated access session never slides; an exchanged one still does', { skip }, async () => {
  const person = await phone()
  const first = await issued(await call('/mobile-refresh/exchange', { jar: person.jar }))
  // The exchanged session is an ordinary session: due for Better Auth's daily refresh, it slides to 7 days.
  await pool.query(`update session set "expiresAt" = now() + interval '5 days' where id = $1`, [person.session.session.id])
  await call('/get-session?disableCookieCache=true', { jar: person.jar })
  const slid = (await sessionRow(person.session.session.id)).expiresAt.getTime() - Date.now()
  assert.ok(slid > 6.9 * 86_400_000, 'an ordinary session still slides')
  const second = await issued(await call('/mobile-refresh/rotate', { jar: person.jar, body: { refreshToken: first.refreshToken } }))
  const minted = (await sessionOf(person.jar))!.session.id
  const expiry = (await sessionRow(minted)).expiresAt.toISOString()
  assert.ok(Date.parse(expiry) - Date.now() < 3_600_000, 'rotation shortened the exchanged session to an hour')
  assert.equal(expiry, second.accessExpiresAt)
  // Better Auth would slide this read to 7 days (it is past updateAge by construction).
  for (let read = 0; read < 2; read++) assert.ok(await sessionOf(person.jar))
  assert.equal((await sessionRow(minted)).expiresAt.toISOString(), expiry, 'reads do not slide it')
  await pool.query(`update session set "expiresAt" = now() + interval '7 days' where id = $1`, [minted])
  assert.equal((await sessionRow(minted)).expiresAt.toISOString(), expiry, 'no write extends it')
  await pool.query(`update session set "expiresAt" = now() - interval '1 second' where id = $1`, [minted])
  assert.ok((await sessionRow(minted)).expiresAt.getTime() < Date.now(), 'shortening still works')
})

test('a used token presented again after the grace window revokes the whole family', { skip }, async () => {
  const person = await phone()
  const first = await issued(await call('/mobile-refresh/exchange', { jar: person.jar }))
  const second = await issued(await call('/mobile-refresh/rotate', { jar: person.jar, body: { refreshToken: first.refreshToken } }))
  const minted = (await sessionOf(person.jar))!.session.id
  await pool.query(`update mobile_refresh_tokens set used_at = now() - interval '2 minutes' where user_id = $1 and used_at is not null`, [person.id])
  await refusal(await call('/mobile-refresh/rotate', { body: { refreshToken: first.refreshToken } }))
  const family = await rows(person.id)
  assert.ok(family.every(row => row.revoked_at && row.session_id === null))
  assert.equal(family[1].revoked_reason, 'reused')
  assert.equal(await sessionRow(minted), undefined, 'the family\'s access session was deleted')
  assert.equal(await sessionOf(person.jar), null)
  await refusal(await call('/mobile-refresh/rotate', { body: { refreshToken: second.refreshToken } }))
})

test('within the grace window a lost response rotates again; once its child is used it is a replay', { skip }, async () => {
  const person = await phone()
  const first = await issued(await call('/mobile-refresh/exchange', { jar: person.jar }))
  const lost = new Jar(); lost.cookies = new Map(person.jar.cookies); lost.ip = person.jar.ip
  const dropped = await issued(await call('/mobile-refresh/rotate', { jar: lost, body: { refreshToken: first.refreshToken } }))
  assert.ok(await sessionOf(lost))
  // The phone never saw that answer and presents the same token again.
  const retried = await issued(await call('/mobile-refresh/rotate', { jar: person.jar, body: { refreshToken: first.refreshToken } }))
  const family = await rows(person.id)
  assert.ok(family.some(row => row.session_id === null && row.revoked_reason === 'superseded'), 'the lost child is superseded')
  assert.equal(await sessionOf(lost), null, 'the lost answer\'s cookie stopped working')
  assert.ok(await sessionOf(person.jar))
  await refusal(await call('/mobile-refresh/rotate', { body: { refreshToken: dropped.refreshToken } }))
  // That refusal is of a revoked token, not a replay: the family lives on.
  const next = await issued(await call('/mobile-refresh/rotate', { jar: person.jar, body: { refreshToken: retried.refreshToken } }))
  // Now the original token's child has been used: presenting it again, even in the window, is a replay.
  await refusal(await call('/mobile-refresh/rotate', { body: { refreshToken: first.refreshToken } }))
  await refusal(await call('/mobile-refresh/rotate', { body: { refreshToken: next.refreshToken } }))
  assert.ok((await rows(person.id)).every(row => row.revoked_at))
})

test('expired, unknown and malformed tokens are refused without touching the family', { skip }, async () => {
  const person = await phone()
  const first = await issued(await call('/mobile-refresh/exchange', { jar: person.jar }))
  await refusal(await call('/mobile-refresh/rotate', { body: { refreshToken: `mkmr_${randomBytes(32).toString('base64url')}` } }))
  await refusal(await call('/mobile-refresh/rotate', { body: { refreshToken: 'not-a-token' } }))
  await pool.query(`update mobile_refresh_tokens set created_at = now() - interval '61 days', expires_at = now() - interval '1 second' where user_id = $1`, [person.id])
  await refusal(await call('/mobile-refresh/rotate', { body: { refreshToken: first.refreshToken } }))
  assert.equal((await rows(person.id))[0].revoked_at, null)
  assert.ok(await sessionOf(person.jar), 'the session itself is untouched')
})

test('signing out, on the phone or elsewhere, revokes the family; an expired session\'s own cleanup does not', { skip }, async () => {
  // Sign-out on the phone while its access session is live.
  const a = await phone()
  const aToken = (await issued(await call('/mobile-refresh/exchange', { jar: a.jar }))).refreshToken
  const aNext = (await issued(await call('/mobile-refresh/rotate', { jar: a.jar, body: { refreshToken: aToken } }))).refreshToken
  assert.equal((await call('/sign-out', { jar: a.jar })).status, 200)
  assert.equal((await rows(a.id)).at(-1)?.revoked_reason, 'session_ended')
  await refusal(await call('/mobile-refresh/rotate', { body: { refreshToken: aNext } }))

  // The phone's own stale cookie after expiry: Better Auth deletes the session, the family lives.
  const b = await phone()
  const bToken = (await issued(await call('/mobile-refresh/exchange', { jar: b.jar }))).refreshToken
  const bNext = (await issued(await call('/mobile-refresh/rotate', { jar: b.jar, body: { refreshToken: bToken } }))).refreshToken
  const bMinted = (await sessionOf(b.jar))!.session.id
  await pool.query(`insert into mobile_push_tokens (id, "userId", token, platform, "sessionId") values (gen_random_uuid(), $1, $2, 'ios', $3)`,
    [b.id, `ExponentPushToken[${b.id}]`, bMinted])
  await pool.query(`update session set "expiresAt" = now() - interval '1 second' where id = $1`, [bMinted])
  const signedIn = `select count(*)::int as n from session where id = $1 and ${refresh.PHONE_SESSION_SIGNED_IN}`
  assert.equal((await pool.query(signedIn, [bMinted])).rows[0].n, 1, 'a phone whose hour ran out still gets its pushes')
  assert.equal(await sessionOf(b.jar), null)
  assert.equal(await sessionRow(bMinted), undefined, 'Better Auth cleaned the expired session up')
  assert.equal((await rows(b.id)).at(-1)?.revoked_at, null)
  const bThird = (await issued(await call('/mobile-refresh/rotate', { jar: b.jar, body: { refreshToken: bNext } }))).refreshToken
  const bRenewed = (await sessionOf(b.jar))!.session.id
  assert.notEqual(bRenewed, bMinted, 'with its row gone, rotation minted a new session')
  assert.equal((await pool.query('select "sessionId" from mobile_push_tokens where "userId" = $1', [b.id])).rows[0].sessionId, bRenewed, 'and moved the phone\'s push registration to it')

  // Another device signs the phone out after its access session expired: 登录设备 still lists it, and revoking ends the family.
  const web = new Jar(); web.ip = b.jar.ip
  assert.equal((await call('/sign-in/email', { jar: web, origin, body: { email: b.email, password: b.password } })).status, 200)
  const phoneSession = (await sessionOf(b.jar))!.session
  await pool.query(`update session set "expiresAt" = now() - interval '1 second' where id = $1`, [phoneSession.id])
  const { listSignedInDevices } = await import('../lib/account/sessions')
  const webSession = (await sessionOf(web))!.session
  const listed = await listSignedInDevices(b.id, webSession.id)
  assert.ok(listed.some(device => device.id === phoneSession.id), 'a phone kept signed in by its refresh credential is listed')
  assert.equal((await call('/revoke-session', { jar: web, origin, body: { token: phoneSession.token } })).status, 200)
  assert.equal((await rows(b.id)).at(-1)?.revoked_reason, 'session_ended')
  assert.equal((await pool.query(signedIn, [phoneSession.id])).rows[0].n, 0, 'a signed-out phone gets no pushes')
  await refusal(await call('/mobile-refresh/rotate', { body: { refreshToken: bThird } }))

  // 退出其他所有设备 skips expired sessions in Better Auth, but not a phone held by its family.
  const c = await phone()
  const cToken = (await issued(await call('/mobile-refresh/exchange', { jar: c.jar }))).refreshToken
  const cNext = (await issued(await call('/mobile-refresh/rotate', { jar: c.jar, body: { refreshToken: cToken } }))).refreshToken
  await pool.query(`update session set "expiresAt" = now() - interval '1 second' where id = $1`, [(await sessionOf(c.jar))!.session.id])
  const cWeb = new Jar()
  assert.equal((await call('/sign-in/email', { jar: cWeb, origin, body: { email: c.email, password: c.password } })).status, 200)
  assert.equal((await call('/revoke-other-sessions', { jar: cWeb, origin })).status, 200)
  await refusal(await call('/mobile-refresh/rotate', { body: { refreshToken: cNext } }))
  assert.ok(await sessionOf(cWeb), 'the device that signed the others out stays signed in')

  // Sign-out on the phone after its access session expired: the app also revokes its refresh token.
  const d = await phone()
  const dToken = (await issued(await call('/mobile-refresh/exchange', { jar: d.jar }))).refreshToken
  assert.equal((await call('/mobile-refresh/revoke', { body: { refreshToken: dToken } })).status, 200)
  assert.equal((await rows(d.id))[0].revoked_reason, 'signed_out')
  assert.equal(await sessionOf(d.jar), null, 'the session it backed ended too')
  await refusal(await call('/mobile-refresh/rotate', { body: { refreshToken: dToken } }))
})

test('the sign-in\'s second-factor assurance stays with the session; organization SSO keeps its own session', { skip }, async () => {
  const person = await phone()
  const verifiedAt = new Date(Date.now() - 3_600_000)
  await pool.query('update session set "twoFactorVerifiedAt" = $2, "twoFactorMethod" = $3 where id = $1', [person.session.session.id, verifiedAt, 'totp'])
  const first = await issued(await call('/mobile-refresh/exchange', { jar: person.jar }))
  const second = await issued(await call('/mobile-refresh/rotate', { jar: person.jar, body: { refreshToken: first.refreshToken } }))
  const renewed = await sessionRow((await sessionOf(person.jar))!.session.id)
  assert.equal(renewed.twoFactorVerifiedAt?.toISOString(), verifiedAt.toISOString())
  assert.equal(renewed.twoFactorMethod, 'totp')
  // The session row is gone (its own stale cookie): the minted one gets the family's copy.
  await pool.query(`update session set "expiresAt" = now() - interval '1 second' where id = $1`, [renewed.id])
  assert.equal(await sessionOf(person.jar), null)
  await issued(await call('/mobile-refresh/rotate', { jar: person.jar, body: { refreshToken: second.refreshToken } }))
  const minted = await sessionRow((await sessionOf(person.jar))!.session.id)
  assert.notEqual(minted.id, renewed.id)
  assert.equal(minted.twoFactorVerifiedAt?.toISOString(), verifiedAt.toISOString())
  assert.equal(minted.twoFactorMethod, 'totp')
  // A live access session deleted by any SQL path ends the family.
  await pool.query('delete from session where id = $1', [minted.id])
  assert.equal((await rows(person.id)).at(-1)?.revoked_reason, 'session_ended')

  const sso = await phone()
  await pool.query(`update session set "enterpriseOrganizationId" = 'org-fixture' where id = $1`, [sso.session.session.id])
  const declined = await call('/mobile-refresh/exchange', { jar: sso.jar })
  assert.equal(declined.status, 409)
  assert.equal((await declined.json() as { code: string }).code, refresh.REFRESH_UNAVAILABLE)
  assert.equal((await rows(sso.id)).length, 0)
})

test('a refresh token is never an access credential', { skip }, async () => {
  const person = await phone()
  const { refreshToken } = await issued(await call('/mobile-refresh/exchange', { jar: person.jar }))
  const { getApiSession } = await import('../lib/api-auth')
  assert.equal(await getApiSession({ headers: new Headers({ authorization: `Bearer ${refreshToken}` }) }), null)
  assert.equal(await getApiSession({ headers: new Headers({ authorization: `Bearer ${refreshToken}`, cookie: person.jar.header() }) }), null, 'not even beside a valid cookie')
  const { desktopBearerHeaders } = await import('../lib/desktop-rpc/handler')
  assert.equal(desktopBearerHeaders(new Request(origin, { headers: { authorization: `Bearer ${refreshToken}` } })), null)
  assert.equal(await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${refreshToken}` }) }), null)
  assert.equal((await call('/get-session', { jar: Object.assign(new Jar(), { cookies: new Map([['better-auth.session_token', refreshToken]]) }) })).status, 200)
  assert.equal(await sessionOf(Object.assign(new Jar(), { cookies: new Map([['better-auth.session_token', refreshToken]]) })), null)
})

test('a revocation that waits on a rotation in flight still ends the token that rotation issued', { skip }, async () => {
  const person = await phone()
  const first = await issued(await call('/mobile-refresh/exchange', { jar: person.jar }))
  const [row] = await rows(person.id)
  const rotation = await pool.connect()
  try {
    // A rotation holding its family lock has inserted the next token and not committed yet.
    await rotation.query('begin')
    await rotation.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`mobile-refresh:${row.family_id}`])
    const next = randomUUID()
    await rotation.query(`insert into mobile_refresh_tokens (id, family_id, user_id, session_id, session_rotated, token_hash, expires_at, family_expires_at)
      select $1, family_id, user_id, session_id, true, $2, expires_at, family_expires_at from mobile_refresh_tokens where id = $3`, [next, randomBytes(32).toString('hex'), row.id])
    await rotation.query('update mobile_refresh_tokens set session_id = null, used_at = now(), replaced_by = $2 where id = $1', [row.id, next])
    const revoking = call('/mobile-refresh/revoke', { body: { refreshToken: first.refreshToken } })
    // The revocation found the family and now waits on its lock: the rotation commits under it.
    await blockedBy(rotation, '%pg_advisory_xact_lock%')
    await rotation.query('commit')
    assert.equal((await revoking).status, 200)
    const family = await rows(person.id)
    assert.equal(family.find(token => token.id === next)?.revoked_reason, 'signed_out', 'the token committed while the revocation waited is revoked too')
  } finally { await settle(rotation) }
})

test('signing a phone out from 登录设备 holds even when the phone rotated after the list was read', { skip }, async () => {
  const person = await phone()
  const first = await issued(await call('/mobile-refresh/exchange', { jar: person.jar }))
  const web = new Jar(); web.ip = person.jar.ip
  assert.equal((await call('/sign-in/email', { jar: web, origin, body: { email: person.email, password: person.password } })).status, 200)
  const { listSignedInDevices, sessionTokenFor, endSignedInDevice } = await import('../lib/account/sessions')
  const listed = (await listSignedInDevices(person.id, (await sessionOf(web))!.session.id)).find(device => device.id === person.session.session.id)
  assert.ok(listed)
  const tokenWhenListed = await sessionTokenFor(person.id, listed.id)
  // The phone renews its session between the list and the tap.
  const second = await issued(await call('/mobile-refresh/rotate', { jar: person.jar, body: { refreshToken: first.refreshToken } }))
  assert.equal(await (await auth.$context).internalAdapter.findSession(tokenWhenListed!), null, 'the token read with the list no longer names the session')
  const tokens = await endSignedInDevice(person.id, listed.id)
  assert.equal(tokens.length, 1, 'the session renewed in place, by its token as it is now')
  for (const token of tokens) await auth.api.revokeSession({ body: { token }, headers: new Headers({ cookie: web.header(), origin }) })
  assert.equal(await sessionOf(person.jar), null, 'the phone is signed out')
  await refusal(await call('/mobile-refresh/rotate', { body: { refreshToken: second.refreshToken } }))
  assert.ok(await sessionOf(web))
})

test('a retry of a lost answer that overlaps the rotation replacing its expired session still recovers', { skip }, async () => {
  const person = await phone()
  const first = await issued(await call('/mobile-refresh/exchange', { jar: person.jar }))
  const [parent] = await rows(person.id)
  const expired = person.session.session.id
  await pool.query(`update session set "expiresAt" = now() - interval '1 second' where id = $1`, [expired])
  const replacement = await replacementFor(person.id)
  // The first rotation has claimed the token and holds the expired session's row; its answer never reaches the phone.
  await pool.query('update mobile_refresh_tokens set used_at = now() where id = $1', [parent.id])
  const rotation = await pool.connect()
  try {
    await rotation.query('begin')
    await rotation.query('select 1 from session where id = $1 for update', [expired])
    const phoneJar = new Jar(); phoneJar.ip = person.jar.ip
    const retry = call('/mobile-refresh/rotate', { jar: phoneJar, body: { refreshToken: first.refreshToken } })
    // The retry, inside the grace window, has read the expired session as the family's and waits for its row.
    await blockedBy(rotation, '%from session where id = $1%for update%')
    // Meanwhile the first rotation finds that row gone, adopts its minted replacement and links the next token to it.
    await rotation.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`mobile-refresh:${parent.family_id}`])
    await rotation.query('delete from session where id = $1', [expired])
    const lost = randomUUID()
    await rotation.query(`insert into mobile_refresh_tokens (id, family_id, user_id, session_id, session_rotated, token_hash, expires_at, family_expires_at)
      select $1, family_id, user_id, $2, true, $3, expires_at, family_expires_at from mobile_refresh_tokens where id = $4`, [lost, replacement.id, randomBytes(32).toString('hex'), parent.id])
    await rotation.query('update mobile_refresh_tokens set session_id = null, replaced_by = $2 where id = $1', [parent.id, lost])
    await rotation.query('commit')

    const recovered = await issued(await retry)
    assert.equal(recovered.sessionId, replacement.id, 'the retry renews the session the family moved to')
    assert.equal((await sessionOf(phoneJar))?.session.id, replacement.id, 'and the phone has a working cookie for it')
    const family = await rows(person.id)
    assert.equal(family.find(token => token.id === lost)?.revoked_reason, 'superseded', 'the lost answer\'s token is retired')
    assert.equal(family.at(-1)?.session_id, replacement.id)
    assert.equal(family.filter(token => !token.revoked_at && !token.used_at).length, 1, 'one live token: the one the retry returned')
    assert.equal((await pool.query('select count(*)::int as n from session where "userId" = $1', [person.id])).rows[0].n, 1, 'the retry minted nothing beside it')
  } finally { await settle(rotation) }
})

test('signing a phone out from 登录设备 while a rotation replaces its session ends the replacement too', { skip }, async () => {
  const person = await phone()
  await issued(await call('/mobile-refresh/exchange', { jar: person.jar }))
  const [parent] = await rows(person.id)
  const expired = person.session.session.id
  const web = new Jar(); web.ip = person.jar.ip
  assert.equal((await call('/sign-in/email', { jar: web, origin, body: { email: person.email, password: person.password } })).status, 200)
  // The phone's access session expired while it was away; 登录设备 still lists it through its family.
  await pool.query(`update session set "expiresAt" = now() - interval '1 second' where id = $1`, [expired])
  const { endSignedInDevice } = await import('../lib/account/sessions')
  const replacement = await replacementFor(person.id)
  const rotation = await pool.connect()
  try {
    // A rotation holds the family lock while it replaces the expired session.
    await rotation.query('begin')
    await rotation.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`mobile-refresh:${parent.family_id}`])
    const ending = endSignedInDevice(person.id, expired)
    await blockedBy(rotation, '%pg_advisory_xact_lock%')
    await rotation.query('delete from session where id = $1', [expired])
    const next = randomUUID()
    await rotation.query(`insert into mobile_refresh_tokens (id, family_id, user_id, session_id, session_rotated, token_hash, expires_at, family_expires_at)
      select $1, family_id, user_id, $2, true, $3, expires_at, family_expires_at from mobile_refresh_tokens where id = $4`, [next, replacement.id, randomBytes(32).toString('hex'), parent.id])
    await rotation.query('update mobile_refresh_tokens set session_id = null, used_at = now(), replaced_by = $2 where id = $1', [parent.id, next])
    await rotation.query('commit')

    const tokens = await ending
    assert.deepEqual(tokens, [replacement.token], 'the replacement committed while the sign-out waited is ended too')
    for (const token of tokens) await auth.api.revokeSession({ body: { token }, headers: new Headers({ cookie: web.header(), origin }) })
    assert.equal(await sessionRow(replacement.id), undefined, 'no session of the phone is left')
    assert.ok((await rows(person.id)).every(token => token.revoked_at), 'and its family is over')
    assert.ok(await sessionOf(web), 'the device that signed it out stays signed in')
  } finally { await settle(rotation) }
})

test('a retry that minted its own session while another rotation installed a replacement renews the replacement and deletes its own', { skip }, async () => {
  const person = await phone()
  const first = await issued(await call('/mobile-refresh/exchange', { jar: person.jar }))
  const [parent] = await rows(person.id)
  const expired = person.session.session.id
  // Better Auth has deleted the expired access session (its own stale cookie); the family still names it.
  await pool.query(`update session set "expiresAt" = now() - interval '1 second' where id = $1`, [expired])
  await pool.query('delete from session where id = $1', [expired])
  const replacement = await replacementFor(person.id)
  // The first rotation has claimed the token; its answer never reaches the phone.
  await pool.query('update mobile_refresh_tokens set used_at = now() where id = $1', [parent.id])
  const rotation = await pool.connect()
  try {
    // Session rows can be read and locked, not inserted: the retry gets as far as minting its own session.
    await rotation.query('begin')
    await rotation.query('lock table session in share mode')
    const phoneJar = new Jar(); phoneJar.ip = person.jar.ip
    const retry = call('/mobile-refresh/rotate', { jar: phoneJar, body: { refreshToken: first.refreshToken } })
    await blockedBy(rotation, '%insert into%session%')
    // Meanwhile the first rotation links the next token to its replacement and commits.
    await rotation.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`mobile-refresh:${parent.family_id}`])
    const lost = randomUUID()
    await rotation.query(`insert into mobile_refresh_tokens (id, family_id, user_id, session_id, session_rotated, token_hash, expires_at, family_expires_at)
      select $1, family_id, user_id, $2, true, $3, expires_at, family_expires_at from mobile_refresh_tokens where id = $4`, [lost, replacement.id, randomBytes(32).toString('hex'), parent.id])
    await rotation.query('update mobile_refresh_tokens set session_id = null, replaced_by = $2 where id = $1', [parent.id, lost])
    await rotation.query('commit')

    const recovered = await issued(await retry)
    assert.equal(recovered.sessionId, replacement.id, 'the retry renews the replacement the family moved to')
    assert.equal((await sessionOf(phoneJar))?.session.id, replacement.id)
    const sessions = (await pool.query<{ id: string }>('select id from session where "userId" = $1', [person.id])).rows
    assert.deepEqual(sessions.map(session => session.id), [replacement.id], 'the session the retry minted for itself is deleted')
    const family = await rows(person.id)
    assert.equal(family.find(token => token.id === lost)?.revoked_reason, 'superseded')
    assert.ok(family.every(token => token.revoked_reason !== 'session_ended'), 'deleting the spare session ends nothing')
    await issued(await call('/mobile-refresh/rotate', { jar: phoneJar, body: { refreshToken: recovered.refreshToken } }))
  } finally { await settle(rotation) }
})

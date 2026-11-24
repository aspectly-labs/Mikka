import { Platform } from 'react-native'
import { authClient } from '@/lib/auth'
import { apiCache } from './api-cache'
import { currentAccount, servers } from './config'
import { sessionTokenOf } from './session-token'

let ending: Promise<void> | null = null
let expired = false

/**
 * The server no longer knows this session (a 401: a password reset elsewhere,
 * revoked on the web, expired). Sign out here only: the Expo plugin clears the
 * keychain cookie before the request goes out, so the app returns to the
 * sign-in screen even though the server call itself fails.
 */
export function endLostSession(stillLost: () => Promise<boolean> = async () => true): Promise<void> {
  if (ending) return ending
  const client = authClient, account = currentAccount()
  // A sign-in that finished meanwhile is not the lost session: never sign it out.
  const lost = () => stillLost().catch(() => false)
  ending = (async () => {
    if (!await lost()) return
    expired = true
    apiCache.clear()
    if (Platform.OS !== 'web') await (await import('@/lib/push')).forgetPushToken(account.id).catch(() => undefined)
    if (!await lost()) return
    await client.signOut().catch(() => undefined)
    client.$store.notify('$sessionSignal')
    await servers.signedOut(account.id).catch(() => undefined)
  })().finally(() => { ending = null })
  return ending
}

let confirming: { token: string | null; promise: Promise<void> } | null = null

/**
 * A Mikka API request answered 401. Signs out only when the auth server, asked
 * once for this session, says there is none; several 401s for the same session
 * share that one check. A check that fails (no network, a server error), a
 * session the server still knows, or a new sign-in since the request went out
 * (`sentCookie` no longer carries the stored token) keeps the person signed in,
 * so one request's 401 never ends a working session.
 */
export function sessionRefused(sentCookie: string | null = null): Promise<void> {
  if (ending) return ending
  const token = sessionTokenOf(sentCookie)
  if (confirming?.token === token) return confirming.promise
  const client = authClient, account = currentAccount()
  // A different token means a newer sign-in, which is never signed out. No token at all is still this
  // session: the auth client clears the cookie itself when the server answers that the session is gone.
  const sameSession = async () => {
    if (currentAccount().id !== account.id || authClient !== client) return false
    const stored = sessionTokenOf(await client.getCookie().catch(() => null))
    return stored === null || stored === token
  }
  const promise = (async () => {
    if (!await sameSession()) return
    const result = await client.getSession({ query: { disableCookieCache: true } }).catch(() => null)
    if (!result || result.data?.user) return
    if (result.error && result.error.status !== 401) return
    if (!await sameSession()) return
    await endLostSession(sameSession)
  })().finally(() => { if (confirming?.promise === promise) confirming = null })
  confirming = { token, promise }
  return promise
}

/** Whether the app signed out because the session was lost, so the sign-in screen can say so. */
export const sessionExpired = () => expired

/** The person is signing in again. */
export function clearSessionExpired() {
  expired = false
}

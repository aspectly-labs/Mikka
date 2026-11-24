import { Platform } from 'react-native'
import { authClient } from '@/lib/auth'
import { apiCache } from './api-cache'
import { currentAccount, servers } from './config'

let ending: Promise<void> | null = null
let expired = false

/**
 * The server no longer knows this session (a 401: a password reset elsewhere,
 * revoked on the web, expired). Sign out here only: the Expo plugin clears the
 * keychain cookie before the request goes out, so the app returns to the
 * sign-in screen even though the server call itself fails.
 */
export function endLostSession(): Promise<void> {
  if (ending) return ending
  const client = authClient, account = currentAccount()
  expired = true
  apiCache.clear()
  ending = (async () => {
    if (Platform.OS !== 'web') await (await import('@/lib/push')).forgetPushToken(account.id).catch(() => undefined)
    await client.signOut().catch(() => undefined)
    client.$store.notify('$sessionSignal')
    await servers.signedOut(account.id).catch(() => undefined)
  })().finally(() => { ending = null })
  return ending
}

let confirming: Promise<void> | null = null

/**
 * A Mikka API request answered 401. Signs out only when the auth server, asked
 * once for this account's session, says there is none; several 401s at once
 * share that one check. A check that fails (no network, a server error) keeps
 * the person signed in, and so does a session the server still knows, so one
 * request's 401 never ends a working session.
 */
export function sessionRefused(): Promise<void> {
  if (ending) return ending
  if (confirming) return confirming
  const client = authClient, account = currentAccount()
  confirming = (async () => {
    const result = await client.getSession({ query: { disableCookieCache: true } }).catch(() => null)
    if (!result || currentAccount().id !== account.id || authClient !== client) return
    if (result.data?.user) return
    if (result.error && result.error.status !== 401) return
    await endLostSession()
  })().finally(() => { confirming = null })
  return confirming
}

export { keepRenewedSession } from './session-cookie'

/** Whether the app signed out because the session was lost, so the sign-in screen can say so. */
export const sessionExpired = () => expired

/** The person is signing in again. */
export function clearSessionExpired() {
  expired = false
}

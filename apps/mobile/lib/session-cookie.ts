import { Platform } from 'react-native'
import { getSetCookie, hasBetterAuthCookies, storageAdapter } from '@better-auth/expo/client'
import { secureStorage } from './secure-storage'
import { accountStorageKey } from './server-store'
import { renewStoredSession } from './session-renewal'

// The same storage object as the Expo plugin's (lib/auth.ts), so reads and writes share its per-key queue.
const storage = storageAdapter(secureStorage)

/**
 * Keeps the keychain session's expiry in step with a renewal the server sent on
 * a Mikka API response (lib/session-renewal.ts). The auth client stores the
 * renewals on its own requests; this covers every other request that carries
 * the session cookie.
 */
export async function keepRenewedSession(accountId: string, response: Response): Promise<void> {
  if (Platform.OS === 'web') return
  const header = response.headers.get('set-cookie')
  if (!header || !hasBetterAuthCookies(header, 'better-auth')) return
  // The cookie jar key the Expo plugin uses for this account (lib/auth.ts storagePrefix + "_cookie").
  const name = `${accountStorageKey(accountId, '').replace(/_$/, '')}_cookie`
  try {
    const next = renewStoredSession(await storage.getItemAsync(name), getSetCookie(header))
    if (next) await storage.setItemAsync(name, next)
  } catch { /* The next renewal or the auth client's own read stores it. */ }
}

import { useSyncExternalStore } from 'react'
import { Platform } from 'react-native'
import { secureStorage as SecureStore } from './secure-storage'
import { authClient } from '@/lib/auth'
import { currentAccount } from '@/lib/config'
import { accountStorageKey } from './server-store'
import { createAccessKeeper, type HeldState, type RefreshCredential, type RotateResult } from './access-keeper'

/**
 * Wires the refresh credential (lib/access-keeper.ts) to the keychain and to
 * the account's auth client. Requests go through the auth client, so the Expo
 * plugin stores the renewed session cookie exactly as it does for a sign-in.
 * On the web the browser keeps its own cookie and nothing here runs.
 */
const REQUEST_TIMEOUT_MS = 15_000
const key = (account: string) => accountStorageKey(account, 'refresh')

function parse(value: unknown): RefreshCredential | null {
  const credential = value as Partial<RefreshCredential> | null
  return credential && typeof credential.userId === 'string' && typeof credential.refreshToken === 'string'
    && typeof credential.refreshExpiresAt === 'string' && typeof credential.accessExpiresAt === 'string'
    ? { userId: credential.userId, refreshToken: credential.refreshToken, refreshExpiresAt: credential.refreshExpiresAt, accessExpiresAt: credential.accessExpiresAt }
    : null
}

type Answer = { status: number; code?: string; data?: unknown }
/** A refresh request as the account's own auth client, or null when it cannot be made (another account is active, no network). */
async function post(account: string, path: string, body: Record<string, string>): Promise<Answer | null> {
  if (currentAccount().id !== account) return null
  const client = authClient
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const result = await client.$fetch(path, { method: 'POST', body, signal: controller.signal }) as { data: unknown; error: { status: number; code?: string } | null }
    if (result.error) return { status: result.error.status, code: result.error.code }
    return { status: 200, data: result.data }
  } catch { return null } finally { clearTimeout(timer) }
}

export const accessKeeper = createAccessKeeper({
  read: async account => {
    const raw = await SecureStore.getItemAsync(key(account))
    if (!raw) return null
    try { return parse(JSON.parse(raw)) } catch { return null }
  },
  write: (account, credential) => SecureStore.setItemAsync(key(account), JSON.stringify(credential)),
  clear: account => SecureStore.deleteItemAsync(key(account)),
  exchange: async account => {
    const answer = await post(account, '/mobile-refresh/exchange', {})
    const credential = answer?.status === 200 ? parse(answer.data) : null
    return credential ? { status: 'ok', credential } : { status: 'unavailable' }
  },
  rotate: async (account, refreshToken): Promise<RotateResult> => {
    const answer = await post(account, '/mobile-refresh/rotate', { refreshToken })
    if (answer?.status === 401 && answer.code === 'refreshRejected') return { status: 'rejected' }
    const credential = answer?.status === 200 ? parse(answer.data) : null
    return credential ? { status: 'ok', credential } : { status: 'unavailable' }
  },
  revoke: async (account, refreshToken) => { await post(account, '/mobile-refresh/revoke', { refreshToken }) },
  now: () => Date.now(),
})

const native = () => Platform.OS !== 'web'

/** Before a request: renew an access session about to end. */
export const prepareAccess = (account: string) => native() ? accessKeeper.prepare(account) : Promise.resolve()
/** After a 401 on a request sent at `generation` (see accessGeneration). */
export const recoverAccess = (account: string, generation: number) => native() ? accessKeeper.recover(account, generation) : Promise.resolve('none' as const)
export const accessGeneration = (account: string) => accessKeeper.generation(account)
/** Signed in on this phone: get a refresh credential once per session per launch or foreground. */
export const keepSignedIn = (account: string, userId: string, session: string) => native() ? accessKeeper.ensureExchanged(account, userId, session) : Promise.resolve()
/** The app came back to the foreground. */
export const accessForeground = (account: string) => native() ? accessKeeper.foreground(account) : Promise.resolve()
/** Signing out or losing the session: end the refresh credential too. */
export const forgetAccess = (account: string) => native() ? accessKeeper.forget(account) : Promise.resolve()

/** Whether this account still holds a refresh credential, for the sign-in gate. */
export function useAccessHeld(account: string): HeldState {
  const held = () => native() ? accessKeeper.held(account) : 'none'
  return useSyncExternalStore(accessKeeper.subscribe, held, held)
}

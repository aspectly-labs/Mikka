/**
 * The iPhone's refresh credential (server: lib/auth-mobile-refresh.ts, decision
 * 2026-11-24 mobile-refresh-credentials), per saved account.
 *
 * The session cookie stays the access credential. Signed in, the app trades it
 * once for a refresh token (`exchange`); when the access session is about to
 * end, or a request answers 401, it rotates the refresh token for a renewed
 * one-hour session cookie and the next refresh token. Every rotation for one
 * account is a single request, however many callers need it. Only the server's
 * `refreshRejected` means the credential is gone; a network failure, a timeout,
 * a 5xx or a 404 (a server without these endpoints) leaves the person signed in
 * and today's behaviour in charge.
 *
 * No timers: it runs before a request, after a 401 and when the app returns to
 * the foreground. Pure, with its storage and server calls injected, so it runs
 * under node:test.
 */
export type RefreshCredential = { userId: string; refreshToken: string; refreshExpiresAt: string; accessExpiresAt: string }
export type RotateResult = { status: 'ok'; credential: RefreshCredential } | { status: 'rejected' } | { status: 'unavailable' }
export type ExchangeResult = { status: 'ok'; credential: RefreshCredential } | { status: 'unavailable' }
/** After a 401: `rotated` replays the request; `rejected` and `none` leave the 401 to the session check; `unavailable` keeps the person signed in. */
export type Recovery = 'rotated' | 'rejected' | 'none' | 'unavailable'
export type HeldState = 'unknown' | 'held' | 'none'

export type AccessKeeperDeps = {
  read(account: string): Promise<RefreshCredential | null>
  write(account: string, credential: RefreshCredential): Promise<void>
  clear(account: string): Promise<void>
  exchange(account: string): Promise<ExchangeResult>
  rotate(account: string, refreshToken: string): Promise<RotateResult>
  revoke(account: string, refreshToken: string): Promise<void>
  now(): number
}

/** Rotate this long before the access session ends, so a request never carries an expired cookie. */
export const ROTATE_BEFORE_MS = 5 * 60_000

export function createAccessKeeper(deps: AccessKeeperDeps) {
  const credentials = new Map<string, RefreshCredential | null>()
  const loading = new Map<string, Promise<RefreshCredential | null>>()
  const rotating = new Map<string, Promise<RotateResult>>()
  const exchanging = new Map<string, Promise<void>>()
  /** Sessions (account:session) that already tried an exchange in this launch or foreground. */
  const exchanged = new Set<string>()
  /** Bumped by every successful rotation, so a 401 for a request sent before it just replays. */
  const generations = new Map<string, number>()
  const listeners = new Set<() => void>()
  const publish = () => { for (const listener of listeners) listener() }

  function load(account: string): Promise<RefreshCredential | null> {
    if (credentials.has(account)) return Promise.resolve(credentials.get(account) ?? null)
    const pending = loading.get(account) ?? deps.read(account).catch(() => null).then(value => {
      if (loading.get(account) === pending) { loading.delete(account); if (!credentials.has(account)) { credentials.set(account, value); publish() } }
      return credentials.get(account) ?? null
    })
    loading.set(account, pending)
    return pending
  }

  async function store(account: string, credential: RefreshCredential | null) {
    credentials.set(account, credential)
    loading.delete(account)
    publish()
    if (credential) await deps.write(account, credential).catch(() => undefined)
    else await deps.clear(account).catch(() => undefined)
  }

  /** One rotation per account at a time; a lost answer is retried once at once, inside the server's grace window. */
  function rotate(account: string, credential: RefreshCredential): Promise<RotateResult> {
    const running = rotating.get(account)
    if (running) return running
    const work = (async (): Promise<RotateResult> => {
      let result = await deps.rotate(account, credential.refreshToken).catch((): RotateResult => ({ status: 'unavailable' }))
      if (result.status === 'unavailable') result = await deps.rotate(account, credential.refreshToken).catch((): RotateResult => ({ status: 'unavailable' }))
      // A sign-out or a new sign-in meanwhile owns the slot now.
      if (credentials.get(account)?.refreshToken !== credential.refreshToken) return result.status === 'ok' ? { status: 'unavailable' } : result
      if (result.status === 'ok') {
        generations.set(account, (generations.get(account) ?? 0) + 1)
        await store(account, result.credential)
      } else if (result.status === 'rejected') await store(account, null)
      return result
    })().finally(() => { rotating.delete(account) })
    rotating.set(account, work)
    return work
  }

  return {
    /** For the sign-in gate: whether this account holds a refresh credential (`unknown` until the keychain answered). */
    held(account: string): HeldState {
      if (!credentials.has(account)) { void load(account); return 'unknown' }
      return credentials.get(account) ? 'held' : 'none'
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    /** The user the credential belongs to, so a slot never rotates into another person's session. */
    async userOf(account: string) { return (await load(account))?.userId ?? null },
    generation(account: string) { return generations.get(account) ?? 0 },

    /** Before a request: renew an access session that is about to end. Never throws, never signs out. */
    async prepare(account: string): Promise<void> {
      const credential = await load(account)
      if (!credential || Date.parse(credential.accessExpiresAt) - deps.now() > ROTATE_BEFORE_MS) return
      await rotate(account, credential)
    },

    /**
     * After a 401 on a request sent at `generation`. A rotation that finished
     * since then needs no other; otherwise every caller shares one rotation.
     */
    async recover(account: string, generation: number): Promise<Recovery> {
      if (this.generation(account) > generation) return 'rotated'
      const credential = await load(account)
      if (!credential) return 'none'
      const result = await rotate(account, credential)
      return result.status === 'ok' ? 'rotated' : result.status
    },

    /** Signed in without a refresh credential: get one, at most once per session per launch or foreground. */
    async ensureExchanged(account: string, userId: string, session: string): Promise<void> {
      const key = `${account}:${session}`
      if (exchanged.has(key)) return exchanging.get(account)
      exchanged.add(key)
      const work = (async () => {
        const current = await load(account)
        if (current?.userId === userId) return
        // A credential for someone else in this slot is stale; never use it.
        if (current) await store(account, null)
        const result = await deps.exchange(account).catch((): ExchangeResult => ({ status: 'unavailable' }))
        if (result.status === 'ok' && result.credential.userId === userId && !credentials.get(account)) await store(account, result.credential)
      })().finally(() => { exchanging.delete(account) })
      exchanging.set(account, work)
      return work
    },

    /** The app came back to the foreground: a new chance to exchange, and renew a session about to end. */
    foreground(account: string): Promise<void> {
      for (const key of exchanged) if (key.startsWith(`${account}:`)) exchanged.delete(key)
      return this.prepare(account)
    },

    /** Signing out: the server ends the family (best effort) and the keychain forgets it. */
    async forget(account: string): Promise<void> {
      const credential = await load(account)
      await store(account, null)
      if (credential) await deps.revoke(account, credential.refreshToken).catch(() => undefined)
    },
  }
}
export type AccessKeeper = ReturnType<typeof createAccessKeeper>

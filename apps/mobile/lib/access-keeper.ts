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
 * No timers and no foreground listener: it runs when the app is signed in,
 * before a request and after a 401. An exchange that got no answer (an offline
 * launch) is tried again before the next request, so reconnecting with the
 * same session is enough. Pure, with its storage and server calls injected, so
 * it runs under node:test.
 */
/** What the server issues: the person, the access session it renewed and the next refresh token. */
export type IssuedCredential = { userId: string; sessionId: string; refreshToken: string; refreshExpiresAt: string; accessExpiresAt: string }
/**
 * `bindingSessionId` is the session the sign-in started with. It stays when a
 * rotation has to mint a replacement session, so the app's outbox and cache,
 * bound to it, survive (app/_layout.tsx).
 */
export type RefreshCredential = IssuedCredential & { bindingSessionId: string }
export type RotateResult = { status: 'ok'; credential: IssuedCredential } | { status: 'rejected' } | { status: 'unavailable' }
/** `refused`: the server answered no (an organization SSO session, a server without the endpoint); not asked again for that session. */
export type ExchangeResult = { status: 'ok'; credential: IssuedCredential } | { status: 'refused' } | { status: 'unavailable' }
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
  /** The person this account slot is signed in as, when known. */
  owner?(account: string): string | null
  now(): number
}

/** Rotate this long before the access session ends, so a request never carries an expired cookie. */
export const ROTATE_BEFORE_MS = 5 * 60_000

export function createAccessKeeper(deps: AccessKeeperDeps) {
  const credentials = new Map<string, RefreshCredential | null>()
  const loading = new Map<string, Promise<RefreshCredential | null>>()
  const rotating = new Map<string, Promise<RotateResult>>()
  const exchanging = new Map<string, Promise<void>>()
  /** Sessions (account:session) that already asked for an exchange in this launch. */
  const exchanged = new Set<string>()
  /** A signed-in session whose exchange got no answer, tried again before the account's next request. */
  const unanswered = new Map<string, { userId: string; session: string }>()
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

  /** Credentials the keychain has not taken yet (locked phone, storage error); written again before the next use. */
  const unsaved = new Set<string>()
  async function persist(account: string) {
    const credential = credentials.get(account)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (credential) await deps.write(account, credential); else await deps.clear(account)
        if (credentials.get(account) === credential) unsaved.delete(account)
        return
      } catch { /* tried again below, then before the next use */ }
    }
    if (credentials.get(account) === credential) unsaved.add(account)
  }
  async function store(account: string, credential: RefreshCredential | null) {
    credentials.set(account, credential)
    loading.delete(account)
    publish()
    await persist(account)
  }

  /** One rotation per account at a time; a lost answer is retried once at once, inside the server's grace window. */
  function rotate(account: string, credential: RefreshCredential): Promise<RotateResult> {
    const running = rotating.get(account)
    if (running) return running
    const work = (async (): Promise<RotateResult> => {
      // A credential left by someone else in this slot is never used to sign in as them.
      const owner = deps.owner?.(account) ?? null
      if (owner !== null && owner !== credential.userId) { await store(account, null); return { status: 'rejected' } }
      let result = await deps.rotate(account, credential.refreshToken).catch((): RotateResult => ({ status: 'unavailable' }))
      if (result.status === 'unavailable') result = await deps.rotate(account, credential.refreshToken).catch((): RotateResult => ({ status: 'unavailable' }))
      // A sign-out or a new sign-in meanwhile owns the slot now.
      if (credentials.get(account)?.refreshToken !== credential.refreshToken) return result.status === 'ok' ? { status: 'unavailable' } : result
      if (result.status === 'ok') {
        generations.set(account, (generations.get(account) ?? 0) + 1)
        await store(account, { ...result.credential, bindingSessionId: credential.bindingSessionId })
      } else if (result.status === 'rejected') await store(account, null)
      return result
    })().finally(() => { rotating.delete(account) })
    rotating.set(account, work)
    return work
  }

  function exchange(account: string, userId: string, session: string): Promise<void> {
    const running = exchanging.get(account)
    if (running) return running
    unanswered.delete(account)
    const work = (async () => {
      const current = await load(account)
      if (current?.userId === userId) return
      // A credential for someone else in this slot is stale; never use it.
      if (current) await store(account, null)
      const result = await deps.exchange(account).catch((): ExchangeResult => ({ status: 'unavailable' }))
      if (credentials.get(account)) return
      if (result.status === 'unavailable') unanswered.set(account, { userId, session })
      else if (result.status === 'ok' && result.credential.userId === userId) await store(account, { ...result.credential, bindingSessionId: result.credential.sessionId })
    })().finally(() => { exchanging.delete(account) })
    exchanging.set(account, work)
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
    /** The session this account's sign-in is bound to while the credential renews `session`, else null. */
    binding(account: string, user: string, session: string | null): string | null {
      const credential = credentials.get(account)
      if (!credential || credential.userId !== user) return null
      return session === null || session === credential.sessionId || session === credential.bindingSessionId ? credential.bindingSessionId : null
    },

    /**
     * Before a request: renew an access session that is about to end, or ask
     * again for the exchange an offline launch could not make (in the
     * background: this request goes out with the cookie either way). Never
     * throws, never signs out.
     */
    async prepare(account: string): Promise<void> {
      if (unsaved.has(account)) await persist(account)
      const credential = await load(account)
      const waiting = credential ? null : unanswered.get(account)
      if (waiting) {
        const owner = deps.owner?.(account) ?? null
        if (owner === null || owner === waiting.userId) void exchange(account, waiting.userId, waiting.session).catch(() => undefined)
        else unanswered.delete(account)
      }
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

    /**
     * Signed in without a refresh credential: get one, once per session per
     * launch. Unanswered, the next request asks again (see prepare); refused,
     * it is not asked again in this launch.
     */
    async ensureExchanged(account: string, userId: string, session: string): Promise<void> {
      const key = `${account}:${session}`
      if (exchanged.has(key)) return exchanging.get(account)
      exchanged.add(key)
      return exchange(account, userId, session)
    },

    /** Signing out: the server ends the family (best effort) and the keychain forgets it. */
    async forget(account: string): Promise<void> {
      unanswered.delete(account)
      const credential = await load(account)
      await store(account, null)
      if (credential) await deps.revoke(account, credential.refreshToken).catch(() => undefined)
    },
  }
}
export type AccessKeeper = ReturnType<typeof createAccessKeeper>

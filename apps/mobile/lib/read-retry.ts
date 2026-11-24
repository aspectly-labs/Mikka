/**
 * How a read recovers from a failure that is not an answer: a dropped
 * connection, a timeout or a busy server. Pure, so it runs under node:test.
 *
 * iOS suspends the app soon after it leaves the foreground. A request that is
 * in flight then, or the first one sent on a pooled connection the server
 * closed meanwhile, fails as a network error although nothing is wrong. Like
 * TanStack Query's default (three retries, exponential backoff) and
 * URLSession's own guidance, a read tries again a few times before anything
 * reaches the screen, and a refresh nobody asked for keeps the content it has.
 */

/** The waits before the second, third and fourth attempt; each is jittered by ±25%. */
export const READ_RETRY_DELAYS_MS = [400, 1_200, 3_000] as const

/** The wait before retry number `attempt` (0-based), or null once retries are spent. */
export function readRetryDelay(attempt: number, random: () => number = Math.random): number | null {
  const base = READ_RETRY_DELAYS_MS[attempt]
  if (base === undefined) return null
  return Math.round(base * (0.75 + random() * 0.5))
}

/**
 * True for a failure another attempt can fix: the transport (fetch's
 * "Network request failed", the request timeout's abort, a keychain read that
 * was briefly unavailable) or a server status that says "later" (408, 429, 5xx).
 * Any other status is the server's answer and is shown at once.
 */
export function isTransientReadFailure(failure: unknown): boolean {
  const status = typeof failure === 'object' && failure !== null ? (failure as { status?: unknown }).status : undefined
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  return true
}

/**
 * Runs `attempt`, trying again after a transient failure while `canRetry`
 * holds (the read is still current and the app is in the foreground).
 */
export async function readWithRetry<T>(attempt: () => Promise<T>, options: {
  canRetry: () => boolean
  wait: (ms: number) => Promise<void>
  random?: () => number
}): Promise<T> {
  for (let tries = 0; ; tries++) {
    try { return await attempt() }
    catch (failure) {
      const delay = readRetryDelay(tries, options.random)
      if (delay === null || !isTransientReadFailure(failure) || !options.canRetry()) throw failure
      await options.wait(delay)
      if (!options.canRetry()) throw failure
    }
  }
}

/** Why a read ran: the person asked (first load, Retry, pull to refresh, after a write), or the app refreshed on its own. */
export type ReadMode = 'shown' | 'quiet'

/**
 * What a failed read does to the screen. `hold` keeps what is drawn and marks
 * the read failed, so the next foreground (or the person's own refresh) tries
 * again; `show` surfaces the error.
 *
 * A transient failure is held when the app left the foreground during the
 * read (iOS cut it off) or when a refresh nobody asked for fails while the
 * screen already has content: Apple's own apps keep the last content then
 * instead of showing an error the person did not cause.
 */
export function readFailureOutcome(input: { transient: boolean; interrupted: boolean; mode: ReadMode; hasData: boolean }): 'show' | 'hold' {
  if (!input.transient) return 'show'
  if (input.interrupted) return 'hold'
  return input.mode === 'quiet' && input.hasData ? 'hold' : 'show'
}

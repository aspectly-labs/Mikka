/**
 * The keychain cookie jar is the Expo plugin's JSON: `{ name: { value, expires } }`
 * (`@better-auth/expo/client`, getSetCookie). The plugin drops a cookie whose
 * stored `expires` has passed before it sends anything, so the stored date has
 * to follow the server's.
 *
 * The server renews a session (7 days, at most once a day) on whichever request
 * reads it first, and answers that request with the new Set-Cookie. Only the
 * auth client's own requests stored that answer; renewals on Mikka API reads
 * were lost, so a session used every day still expired on the phone a week
 * after the last stored renewal, every request then went out without it, and
 * the app signed out (the 401s at 2026-11-24 03:08 UTC).
 *
 * Pure, so it runs under node:test.
 */
type Jar = Record<string, { value: string; expires: string | null }>

const parse = (json: string | null | undefined): Jar => {
  if (!json) return {}
  try {
    const value: unknown = JSON.parse(json)
    return value && typeof value === 'object' ? value as Jar : {}
  } catch { return {} }
}

/**
 * Applies the renewed expiry of each cookie the jar already holds with the same
 * value. A cookie the jar does not hold, or holds with another value (a new
 * sign-in, another account, a sign-out in between), is left to the auth client.
 * Returns the jar to store, or null when nothing changes.
 */
export function renewStoredSession(stored: string | null, renewed: string): string | null {
  const jar = parse(stored), next = parse(renewed)
  let changed = false
  for (const [name, cookie] of Object.entries(next)) {
    const current = jar[name]
    if (!current || current.value !== cookie.value || current.expires === cookie.expires || !cookie.expires) continue
    if (current.expires && Date.parse(cookie.expires) <= Date.parse(current.expires)) continue
    jar[name] = { value: current.value, expires: cookie.expires }
    changed = true
  }
  return changed ? JSON.stringify(jar) : null
}

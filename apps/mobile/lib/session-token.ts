/**
 * The session token in a Cookie header the app sends (`…session_token=value`,
 * with or without the `__Secure-` prefix), or null when it carries none. It
 * names which sign-in a request spoke for: the auth client keeps the same
 * account and client across a sign-out and a new sign-in, so only the token
 * tells an old session's 401 from the new one. Pure, so it runs under node:test.
 */
export function sessionTokenOf(cookie: string | null | undefined): string | null {
  for (const part of (cookie ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index > 0 && part.slice(0, index).trim().endsWith('session_token')) return part.slice(index + 1).trim() || null
  }
  return null
}

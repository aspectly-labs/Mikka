const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** A loopback host as `URL.hostname` gives it (`[::1]`), or with the IPv6 brackets stripped (`::1`). */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname)
}

/**
 * The desktop app's one-shot loopback return (RFC 8252 §7.3): the browser's
 * last redirect lands on http://127.0.0.1:<port>/return?state=…&result=…,
 * which only the app that opened it can be listening for. Shared by the
 * Plugins → GitHub and Composio links.
 */
export const B64URL_43 = /^[A-Za-z0-9_-]{43}$/

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const randomKey = () => base64url(crypto.getRandomValues(new Uint8Array(32)))
export const s256 = async (value: string) => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))

/** http://127.0.0.1:<port>/return and nothing else — the address the app's listener gave out. */
export function loopbackReturn(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/return') return null
    return `${url.origin}${url.pathname}`
  } catch { return null }
}

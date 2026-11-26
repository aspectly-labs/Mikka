/**
 * Pure zero-dependency ESM host and loopback constants shared across TypeScript
 * modules, `.mjs` scripts, and Cloudflare Worker bundles.
 */
export const LOOPBACK_IPV4 = '127.0.0.1'
export const LOCALHOST_HOSTNAME = 'localhost'
export const LOOPBACK_IPV6 = '::1'
export const LOOPBACK_IPV6_BRACKETED = '[::1]'

export const LOOPBACK_HOSTS = Object.freeze([
  LOOPBACK_IPV4,
  LOCALHOST_HOSTNAME,
  LOOPBACK_IPV6_BRACKETED,
  LOOPBACK_IPV6,
])

export const DEFAULT_LOCAL_APP_ORIGIN = `http://${LOOPBACK_IPV4}:3000`
export const DEFAULT_LOCAL_DEV_ORIGIN = `http://${LOCALHOST_HOSTNAME}:3000`
export const DEFAULT_LOCAL_EVE_ORIGIN = `http://${LOOPBACK_IPV4}:3002`
export const DEFAULT_LOCAL_SYNTHETIC_ORIGIN = `http://${LOCALHOST_HOSTNAME}`
export const INTERNAL_PRODUCT_HOSTNAME = 'product.internal'
export const INTERNAL_PRODUCT_ORIGIN = `https://${INTERNAL_PRODUCT_HOSTNAME}`

/** Fixed loopback port/path used by Claude Code desktop OAuth return callbacks. */
export const CLAUDE_DESKTOP_CALLBACK_URL = `http://${LOCALHOST_HOSTNAME}:54545/callback`

/** Fixed in-sandbox loopback endpoints probed inside isolated cloud task machines. */
export const SANDBOX_RUNTIME_VERSION_URL = `http://${LOOPBACK_IPV4}:6082/version`
export const SANDBOX_VNC_PROBE_URL = `http://${LOOPBACK_IPV4}:6080/vnc`

/** Builds an `http://127.0.0.1:<port><path>` URL string for local loopback listeners. */
export function loopbackUrl(port, path = '/') {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `http://${LOOPBACK_IPV4}:${port}${normalizedPath}`
}

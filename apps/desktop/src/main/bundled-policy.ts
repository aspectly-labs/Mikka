import { resolve, sep } from 'node:path'
import generated from '../../../api/generated/routes.json'

export const RENDERER_ORIGIN = 'mikka://app'
export const RENDERER_URL = `${RENDERER_ORIGIN}/mikka`

/** No remote scripts, eval, workers or remote websocket connections. */
export const RENDERER_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:", "font-src 'self' data:", "connect-src 'self'",
  "media-src 'self' blob:", "frame-src 'self' https:", "object-src 'none'", "base-uri 'none'",
  "form-action 'none'", "frame-ancestors 'none'", "worker-src 'none'",
].join('; ')

const DRIVE_VOLUME_ID = 'vol_[0-9A-HJKMNP-TV-Z]{26}'
/** The protocol streams this route's body instead of buffering it (bundled-protocol.ts). */
export const DRIVE_BLOB_UPLOAD = new RegExp(`^/api/drive/volumes/${DRIVE_VOLUME_ID}/blobs$`)
type ServerRoute = { template: string }
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The server's matcher for a route template (apps/api/src/routes.ts), in its matching order. */
function serverPattern(template: string): RegExp {
  const pattern = template.split('/').map(segment => {
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) return '(.*)'
    if (/^\[\.\.\.[^\]]+\]$/.test(segment)) return '(.+)'
    if (/^\[[^\]]+\]$/.test(segment)) return '([^/]+)'
    return escape(segment)
  }).join('/')
  return new RegExp(`^${pattern.replace('/(.*)', '(?:/(.*))?')}$`)
}

/** Every API route the server has, only so a report can name a template instead of a path with ids. */
const SERVER_ROUTES = (generated.routes as readonly ServerRoute[])
  .filter(route => route.template.startsWith('/api/'))
  .map(route => ({ template: route.template, pattern: serverPattern(route.template) }))

/** Check before URL construction: WHATWG URL normalization must not erase traversal evidence. */
export function normalizedRendererPath(value: string): string | null {
  // oxlint-disable-next-line no-control-regex -- Reject NUL, controls and URL whitespace before parsing.
  if (!value.startsWith('/') || value.startsWith('//') || value.length > 8192 || /[\\\x00-\x20\x7f]/.test(value)) return null
  const raw = value.split(/[?#]/, 1)[0]!
  if (/%(?:2e|2f|5c|00|25)/i.test(raw) || raw.split('/').some(part => part === '.' || part === '..')) return null
  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { return null }
  // Decoding can produce controls or whitespace (`.%0A.` is `.\n.`), which URL
  // construction strips later (`..`), so the decoded path is checked again.
  // oxlint-disable-next-line no-control-regex -- Reject decoded NUL, controls and URL whitespace.
  if (decoded.includes('\\') || /[\x00-\x20\x7f]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) return null
  return decoded === '/mikka' ? '/' : decoded.startsWith('/mikka/') ? decoded.slice(6) : null
}

/**
 * Whether main may forward this already-normalized renderer path to the
 * current account's server: an API path, no empty segment, bounded. There is no
 * per-route list; the server authorizes the person, workspace and permission
 * (bundled-auth.ts only ever addresses the account's own server origin).
 */
export function forwardableApiPath(path: string): boolean {
  return path.startsWith('/api/') && path.length <= 4096 && !path.includes('//') && !path.endsWith('/')
}

/** The template of the route that would serve this path, for reports that must not carry its ids. */
export function desktopRouteTemplate(path: string): string | null {
  return SERVER_ROUTES.find(route => route.pattern.test(path))?.template ?? null
}

export function rendererAssetPath(root: string, urlPath: string): string | null {
  const path = normalizedRendererPath(urlPath)
  if (!path || path.startsWith('/api/')) return null
  const absolute = resolve(root, `.${path}`)
  return absolute === resolve(root) || absolute.startsWith(`${resolve(root)}${sep}`) ? absolute : null
}

export function safeAppNext(value: unknown): string {
  // oxlint-disable-next-line no-control-regex -- Return targets cannot contain controls or whitespace.
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\#\x00-\x20]/.test(value) || /%(?:2f|5c|00)/i.test(value)) return '/'
  return value
}

export function remoteBase(value: string): URL {
  const url = new URL(value)
  if (url.username || url.password || url.hash || url.search || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid desktop server / 桌面服务地址无效')
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Desktop server requires HTTPS / 桌面服务必须使用 HTTPS')
  return url
}

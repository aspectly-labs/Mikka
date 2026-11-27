import { resolve, sep } from 'node:path'
import generated from '../../../api/generated/desktop-routes.json'

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

type DesktopMethods = Readonly<Record<string, true | readonly string[]>>
type DesktopRoute = { template: string; desktop?: DesktopMethods }

/**
 * One path segment a route parameter may hold: an opaque id, token or name.
 * normalizedRendererPath has already refused traversal, encoded separators
 * and controls; the handler validates the value itself.
 */
const SEGMENT = '[A-Za-z0-9_.~-]{1,128}'
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The server's matcher for a route template (apps/api/src/routes.ts), so a path resolves to the route that would serve it. */
function serverPattern(template: string): RegExp {
  const pattern = template.split('/').map(segment => {
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) return '(.*)'
    if (/^\[\.\.\.[^\]]+\]$/.test(segment)) return '(.+)'
    if (/^\[[^\]]+\]$/.test(segment)) return '([^/]+)'
    return escape(segment)
  }).join('/')
  return new RegExp(`^${pattern.replace('/(.*)', '(?:/(.*))?')}$`)
}

/** What the desktop may send: each template segment literal, or one safe segment per parameter. */
function desktopPattern(template: string): RegExp {
  return new RegExp(`^${template.split('/').map(segment => (/^\[[^\]]+\]$/.test(segment) ? SEGMENT : escape(segment))).join('/')}$`)
}

/**
 * The API routes and methods the bundled renderer may reach, generated from the
 * `desktop` field of each route's `defineRoute` spec
 * (apps/api/scripts/generate-routes.mjs). There is deliberately no generic
 * /api/* forwarding and no hand-written list to drift from the server.
 */
const DESKTOP_ROUTES = (generated.routes as readonly DesktopRoute[]).map(route => ({
  template: route.template,
  server: serverPattern(route.template),
  methods: Object.fromEntries(Object.entries(route.desktop ?? {}).map(([method, value]) => [
    method, value === true ? [desktopPattern(route.template)] : value.map(desktopPattern),
  ])) as Record<string, RegExp[]>,
}))

/** Viewer and takeover grants are capabilities: the renderer obtains them only through owner-bound IPC. */
const CAPABILITY_GRANTS = /^\/api\/bots\/[^/]+\/(?:computer\/(?:viewer|takeover)|subagents\/[^/]+\/viewer)$/

/** Check before URL construction: WHATWG URL normalization must not erase traversal evidence. */
export function normalizedRendererPath(value: string): string | null {
  // oxlint-disable-next-line no-control-regex -- Reject NUL, controls and URL whitespace before parsing.
  if (!value.startsWith('/') || value.startsWith('//') || value.length > 8192 || /[\\\x00-\x20\x7f]/.test(value)) return null
  const raw = value.split(/[?#]/, 1)[0]!
  if (/%(?:2e|2f|5c|00|25)/i.test(raw) || raw.split('/').some(part => part === '.' || part === '..')) return null
  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { return null }
  if (decoded.includes('\\') || decoded.split('/').some(part => part === '.' || part === '..')) return null
  return decoded === '/mikka' ? '/' : decoded.startsWith('/mikka/') ? decoded.slice(6) : null
}

/**
 * Whether main forwards this renderer request: the route that would serve the
 * path declares the method for the desktop (HEAD reads as GET, as the server
 * answers it), and every parameter is one plain segment.
 */
export function allowedApiPath(path: string, method: string): boolean {
  if (!path.startsWith('/api/') || CAPABILITY_GRANTS.test(path)) return false
  const route = DESKTOP_ROUTES.find(candidate => candidate.server.test(path))
  const allowed = route?.methods[method === 'HEAD' ? 'GET' : method]
  return Boolean(allowed?.some(pattern => pattern.test(path)))
}

/** The template of the route that would serve this path, for reports that must not carry its ids. */
export function desktopRouteTemplate(path: string): string | null {
  return DESKTOP_ROUTES.find(candidate => candidate.server.test(path))?.template ?? null
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

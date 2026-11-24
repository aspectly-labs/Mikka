import { createHash } from 'node:crypto'
import { publishedActions, readRendererActions } from '../../lib/renderer-actions.mjs'
import { isValidDeploymentId } from '../../lib/deployment-id.mjs'
import { decode, DESKTOP_RPC_VERSION, encode } from '../../lib/desktop-rpc/wire.ts'

// The Vite web build names its entry as /mikka/assets/<name>.js, pinned to one
// release with ?dpl=<deployment id>. The browser calls a server action by its
// registered name through POST /mikka/api/rpc (lib/browser-rpc/handler.ts), and
// the release publishes the names its UI uses in renderer-actions.json
// (apps/frontend/scripts/build.mjs, lib/renderer-actions.mjs).

/** The release pin of a same-origin Vite entry: '' when unpinned, null when not an entry. */
export function webEntryPin(value, origin, basePath = '/mikka') {
  try {
    const url = new URL(value, origin)
    if (value.includes('\\') || url.origin !== origin || url.username || url.password || url.hash
      || !new RegExp(`^${basePath}/assets/[A-Za-z0-9_-]+\\.js$`).test(url.pathname)) return null
    if (!url.search) return ''
    const entries = [...url.searchParams]
    return entries.length === 1 && entries[0][0] === 'dpl' && isValidDeploymentId(entries[0][1]) ? entries[0][1] : null
  } catch { return null }
}

/** Which of the wanted actions ({ name: 'module.export' }) this release's web UI
 * publishes. Reads public documents and the public action list only; it never
 * evaluates JavaScript or calls an action. */
export async function discoverRpcActions(request, { origin, pages, actions, basePath = '/mikka', maxBytes = 8_000_000 }) {
  const names = Object.keys(actions), refs = {}, pins = new Set()
  const diagnostics = { transport: 'rpc', rpcVersion: DESKTOP_RPC_VERSION, required: names, found: [], missing: [...names],
    pagesRead: 0, pagesFailed: 0, manifestsRead: 0, manifestsFailed: 0 }
  for (const page of pages) {
    const response = await request(page).catch(() => null)
    if (!response?.ok) { diagnostics.pagesFailed++; continue }
    const html = await response.text()
    if (html.length > maxBytes) { diagnostics.pagesFailed++; continue }
    diagnostics.pagesRead++
    for (const match of html.matchAll(/(?:src|href)\s*=\s*(["'])([^"']+\.js(?:\?[^"']*)?)\1/g)) {
      const pin = webEntryPin(match[2].replaceAll('&amp;', '&'), origin, basePath)
      if (pin !== null) pins.add(pin)
    }
  }
  // No entry, or documents from two releases: nothing is published to read.
  if (pins.size === 1) {
    try {
      const response = await readRendererActions(request, basePath, [...pins][0])
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('manifest_unavailable')
      const text = await response.text()
      if (Buffer.byteLength(text) > maxBytes) throw new Error('manifest_invalid')
      const manifest = JSON.parse(text), published = publishedActions(manifest), found = {}
      if (!/^[a-f0-9]{64}$/.test(manifest.rendererBuild ?? '') || !manifest.modules
        || typeof manifest.modules !== 'object' || Array.isArray(manifest.modules)) throw new Error('manifest_invalid')
      for (const [name, action] of Object.entries(actions)) {
        if (!published.has(action)) continue
        const [module, exported] = action.split('.')
        if (!Object.hasOwn(manifest.modules, module) || !Array.isArray(manifest.modules[module])
          || manifest.modules[module].filter(value => value === exported).length !== 1) throw new Error('manifest_invalid')
        found[name] = action
      }
      Object.assign(refs, found)
      diagnostics.manifestsRead++
      diagnostics.rendererBuild = manifest.rendererBuild
      diagnostics.manifestSha256 = createHash('sha256').update(text).digest('hex')
    } catch { diagnostics.manifestsFailed++ }
  } else if (pins.size > 1) diagnostics.manifestsFailed++
  diagnostics.found = names.filter(name => refs[name])
  diagnostics.missing = names.filter(name => !refs[name])
  return { refs, diagnostics }
}

/** The browser's own RPC request headers; the session cookie is added by the caller. */
export const RPC_HEADERS = Object.freeze({ accept: 'application/json', 'x-mikka-rpc': '1' })
export const rpcBody = (action, args) => ({ version: DESKTOP_RPC_VERSION, action, args: encode(args) })

/** The decoded action result, or { failure } with the server's closed error code. */
export function rpcResult(data) {
  if (data?.version !== DESKTOP_RPC_VERSION || typeof data.ok !== 'boolean') return { failure: 'response_invalid' }
  if (!data.ok) return { failure: typeof data.error?.code === 'string' ? data.error.code : 'response_invalid' }
  if (!Object.hasOwn(data, 'result')) return { failure: 'response_invalid' }
  try { return { result: decode(data.result) } } catch { return { failure: 'response_invalid' } }
}

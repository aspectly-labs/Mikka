// The hosted UI layer (docs/ui-overlay.md, decision 2026-11-06-2000).
// Without MIKKA_UI_OVERLAY_DIR every slot is its default in components/slots/;
// with it, each required provider resolves to the private layer's slots/<name>.tsx and
// `@hosted/*` to the layer's own files. The web and desktop Vite builds both
// read this (apps/frontend/scripts/application-plugin.mjs), so the two cannot
// disagree.
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/** Web and Desktop share these bindings. Native slots are registered separately. */
export const UI_SLOTS = ['auth-sso', 'workspace-entry']

// Unpinned development layers can use these public no-content contracts.
// A pinned official renderer requires a provider for every registered slot.
export const PUBLIC_CONTRACT_SLOTS = new Set(['auth-sso'])
export const UI_SLOT_EXPORTS = {
  'auth-sso': ['AuthSso'],
  'workspace-entry': ['Workspace'],
}

export const SLOT_PREFIX = '@ui-slot/'
export const HOSTED_PREFIX = '@hosted/'

const inside = (root, path) => {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Where each slot and the layer's own `@hosted/` imports resolve for this
 * build. Paths are absolute.
 */
export function uiOverlay(repository, env = process.env) {
  const configured = env.MIKKA_UI_OVERLAY_DIR?.trim()
  const slots = Object.fromEntries(UI_SLOTS.map(name => [name, resolve(repository, 'components/slots', `${name}.tsx`)]))
  if (!configured) {
    if (env.MIKKA_UI_OVERLAY_SHA) throw new Error('UI_OVERLAY_DIR_REQUIRED_FOR_RELEASE')
    return { dir: null, slots }
  }
  const dir = resolve(repository, configured)
  if (!existsSync(dir)) throw new Error(`UI_OVERLAY_DIR_MISSING: ${configured}`)
  // The layer must resolve react and the app's own modules from this
  // repository's node_modules, so it lives inside the repository.
  if (!inside(realpathSync(repository), realpathSync(dir))) throw new Error(`UI_OVERLAY_DIR_OUTSIDE_REPOSITORY: ${configured}`)
  for (const name of UI_SLOTS) {
    const file = resolve(dir, 'slots', `${name}.tsx`)
    if (!existsSync(file)) {
      if (!env.MIKKA_UI_OVERLAY_SHA && PUBLIC_CONTRACT_SLOTS.has(name)) continue
      throw new Error(`UI_OVERLAY_SLOT_REQUIRED: ${name}`)
    }
    if (!inside(realpathSync(dir), realpathSync(file)) || !statSync(file).isFile()) throw new Error(`UI_OVERLAY_SLOT_INVALID: ${name}`)
    slots[name] = file
  }
  return { dir, slots }
}

/** The Vite plugin's aliases for this build: each slot's absolute file, and the layer's directory. */
export function overlayAliases(repository, env = process.env) {
  const { dir, slots } = uiOverlay(repository, env)
  const absolute = Object.fromEntries(Object.entries(slots).map(([name, file]) => [`${SLOT_PREFIX}${name}`, file]))
  return { dir, absolute }
}

/** Resolve one import specifier for the Vite plugin, or null when it is not a slot or `@hosted/` import. */
export function resolveOverlaySpecifier(source, aliases) {
  if (source.startsWith(SLOT_PREFIX)) {
    const file = aliases.absolute[source]
    if (!file) throw new Error(`UI_SLOT_UNKNOWN: ${source}`)
    return file
  }
  if (source.startsWith(HOSTED_PREFIX)) {
    if (!aliases.dir) throw new Error(`UI_OVERLAY_IMPORT_WITHOUT_OVERLAY: ${source}`)
    return resolve(aliases.dir, source.slice(HOSTED_PREFIX.length))
  }
  return null
}

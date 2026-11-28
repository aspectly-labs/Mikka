// The official UI (docs/ui-overlay.md, decisions 2026-11-06-2000 and 2026-11-22-2205).
// This repository carries no product interface. The web and desktop Vite builds
// (apps/frontend/scripts/application-plugin.mjs) compile the private
// `mikka-hosted-ui` checkout named by MIKKA_UI_OVERLAY_DIR: its `core/renderer/`
// is the whole client application, and `@hosted/*` resolves to the checkout's
// own files. Without a checkout, the build compiles a page that only says this
// server has no interface of its own (apps/frontend/src/headless.ts).
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { runtimeEnv } from './env/runtime.mjs'

export const HOSTED_PREFIX = '@hosted/'

/** The client application inside the checkout. Every file must exist in an official build. */
export const OVERLAY_APPLICATION = {
  entry: 'core/renderer/index.tsx',
  desktopPlatform: 'core/renderer/platform.tsx',
  webPlatform: 'core/renderer/web/platform.tsx',
  desktopAuthForm: 'core/renderer/auth-form.tsx',
  styles: 'core/renderer/styles.css',
}

const inside = (root, path) => {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * The checkout this build compiles, or `null` for a build without one. A pinned
 * release (MIKKA_UI_OVERLAY_SHA) must name a checkout inside this repository:
 * the bundler resolves react and the runtime's own modules from here.
 */
export function uiOverlay(repository, env = runtimeEnv()) {
  const configured = env.MIKKA_UI_OVERLAY_DIR?.trim()
  if (!configured) {
    if (env.MIKKA_UI_OVERLAY_SHA) throw new Error('UI_OVERLAY_DIR_REQUIRED_FOR_RELEASE')
    return { dir: null, application: null }
  }
  const dir = resolve(repository, configured)
  if (!existsSync(dir)) throw new Error(`UI_OVERLAY_DIR_MISSING: ${configured}`)
  if (!inside(realpathSync(repository), realpathSync(dir))) throw new Error(`UI_OVERLAY_DIR_OUTSIDE_REPOSITORY: ${configured}`)
  const application = {}
  for (const [name, path] of Object.entries(OVERLAY_APPLICATION)) {
    const file = resolve(dir, path)
    if (!existsSync(file)) throw new Error(`UI_OVERLAY_APPLICATION_REQUIRED: ${path}`)
    if (!inside(realpathSync(dir), realpathSync(file)) || !statSync(file).isFile()) throw new Error(`UI_OVERLAY_APPLICATION_INVALID: ${path}`)
    application[name] = file
  }
  return { dir, application }
}

/** Resolve one import specifier for the Vite plugin, or null when it is not an `@hosted/` import. */
export function resolveOverlaySpecifier(source, overlay) {
  if (!source.startsWith(HOSTED_PREFIX)) return null
  if (!overlay.dir) throw new Error(`UI_OVERLAY_IMPORT_WITHOUT_OVERLAY: ${source}`)
  return resolve(overlay.dir, source.slice(HOSTED_PREFIX.length))
}

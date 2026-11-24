import { resolve } from 'node:path'

/** The target's small runtime is evaluated before the shared application graph.
 * Web installs this repository's transport; Desktop starts the official UI's
 * installed-workspace hint (core/renderer/installed-startup.ts in the checkout). */
export function frontendRuntimeSource(target, { development = false, frontend, overlay }) {
  if (!['web', 'desktop'].includes(target)) throw new Error('FRONTEND_TARGET_INVALID')
  if (!overlay) throw new Error('FRONTEND_RUNTIME_REQUIRES_UI')
  const runtime = target === 'web'
    ? resolve(frontend, 'src/web/runtime.ts')
    : resolve(overlay, 'core/renderer/installed-startup.ts')
  return `${development ? 'globalThis[Symbol.for("openui.devtools.autoMount")] = true;\n' : ''}import ${JSON.stringify(runtime)};\n`
}

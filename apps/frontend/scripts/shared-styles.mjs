import { existsSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import tailwind from '@tailwindcss/postcss'
import { transform } from 'lightningcss'
import { uiOverlay } from '../../../lib/ui-overlay.mjs'
import { sharedCssTargets } from './css-targets.mjs'

const slash = value => value.split(sep).join('/')
const OVERLAY_CSS_DIRECTORIES = ['web', 'slots', 'lib']

/** Use the same Tailwind and build-only Lightning CSS pass the application
 * shipped with. Vite must not perform a second, different color conversion.
 *
 * The version is pinned so the emitted bytes stay put across installs. Tailwind
 * expands `@apply` before this pass, so the pinned version only sees plain CSS;
 * a Lightning CSS pass that ran first would parse a nested `@apply` differently
 * in 1.30 and 1.32 and drop the surrounding selector. See css-targets.mjs for
 * the targets. */
export function sharedStylePlugins(repository, { development = false, env = process.env, serverPages = false } = {}) {
  const entryStylesheets = new Set([
    resolve(repository, 'app/globals.css'),
    resolve(repository, 'apps/desktop/src/renderer/styles.css'),
  ])
  return [{
    postcssPlugin: 'mikka-ui-overlay-sources',
    async Once(root, { result }) {
      if (serverPages) return
      const from = result.opts.from ? resolve(repository, result.opts.from) : null
      if (!from || !entryStylesheets.has(from)) return
      const { dir } = uiOverlay(repository, env)
      if (!dir) return
      const sources = OVERLAY_CSS_DIRECTORIES
        .map(directory => resolve(dir, directory))
        .filter(directory => existsSync(directory))
        .map(directory => `@source ${JSON.stringify(slash(relative(dirname(from), directory)))};`)
      if (!sources.length) return
      const { default: postcss } = await import('postcss')
      const next = postcss.parse(`${root.toString()}\n${sources.join('\n')}\n`, { from: result.opts.from })
      root.removeAll()
      root.append(next.nodes)
      root.source = next.source
    },
  }, tailwind({ base: repository, optimize: true }), {
    postcssPlugin: 'mikka-shared-lightning-css',
    async OnceExit(root, { result }) {
      const transformed = transform({
        filename: result.opts.from ?? 'mikka-shared.css', code: Buffer.from(root.toString()), minify: !development,
        targets: sharedCssTargets,
      })
      const { default: postcss } = await import('postcss')
      root.removeAll()
      root.append(postcss.parse(Buffer.from(transformed.code).toString(), { from: result.opts.from }).nodes)
    },
  }]
}

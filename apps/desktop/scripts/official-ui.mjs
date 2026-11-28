// Tests of the desktop renderer's startup read the official UI's client application (core/renderer in the
// mikka-hosted-ui checkout, lib/ui-overlay.mjs). Without the checkout they skip; mikka-hosted-ui's CI runs them with
// its checkout mounted (scripts/core-ui.test.mjs there).
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { uiOverlay } from '../../../lib/ui-overlay.mjs'
import { officialUiSkip } from '../../../scripts/official-ui-requirement.mjs'

export const repository = fileURLToPath(new URL('../../../', import.meta.url))
export const officialUi = uiOverlay(repository)
export const officialRenderer = officialUi.dir ? join(officialUi.dir, 'core/renderer') : join(repository, '.hosted-ui/core/renderer')
export const needsOfficialUi = officialUiSkip(officialUi.dir, 'MIKKA_UI_OVERLAY_DIR')

const workspace = createRequire(join(repository, 'package.json'))

/** esbuild resolution as the official build has it: `@hosted/` is the checkout, React is this repository's one copy,
 * and the checkout's stylesheets are not part of a test bundle. Register it after a test's own fixtures. */
export const officialUiResolution = { name: 'official-ui-resolution', setup(builder) {
  builder.onResolve({ filter: /^@hosted\// }, args => builder.resolve(`./${args.path.slice('@hosted/'.length)}`, { resolveDir: officialUi.dir, kind: args.kind, importer: args.importer }))
  builder.onResolve({ filter: /^react(?:-dom)?(?:\/|$)/ }, args => ({ path: workspace.resolve(args.path) }))
  builder.onResolve({ filter: /\.css$/ }, () => ({ path: 'stylesheet', namespace: 'official-ui-stylesheet' }))
  builder.onLoad({ filter: /.*/, namespace: 'official-ui-stylesheet' }, () => ({ contents: '', loader: 'js' }))
} }

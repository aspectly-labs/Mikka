import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { build } from 'vite'
import { OVERLAY_APPLICATION, uiOverlay } from '../../../lib/ui-overlay.mjs'
import { applicationPlugin, repository } from './application-plugin.mjs'

/** The official UI checkout this test process builds with (MIKKA_UI_OVERLAY_DIR), or none. A test that needs the real
 * interface skips without it; mikka-hosted-ui's CI runs these tests with its checkout mounted (scripts/core-ui.test.mjs). */
export const officialUi = uiOverlay(repository)
export const needsOfficialUi = !officialUi.dir && 'needs the official UI checkout (MIKKA_UI_OVERLAY_DIR); mikka-hosted-ui CI runs it'

/** A minimal stand-in checkout with every application file the build requires (lib/ui-overlay.mjs), inside this
 * repository as a real checkout is. `files` adds or replaces files by checkout-relative path. */
export async function uiFixture(files = {}) {
  // Git-ignored like a real checkout, so Tailwind's own source detection skips it (shared-styles.mjs names its directories).
  await mkdir(join(repository, '.cache/fixtures'), { recursive: true })
  const dir = await mkdtemp(join(repository, '.cache/fixtures/ui-checkout-'))
  const defaults = Object.fromEntries(Object.values(OVERLAY_APPLICATION).map(path => [path, path.endsWith('.css') ? '' : 'export {}']))
  for (const [path, source] of Object.entries({ ...defaults, 'core/renderer/installed-startup.ts': 'export {}', ...files })) {
    if (source === null) continue
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), source)
  }
  return { dir, overlay: () => uiOverlay(repository, { MIKKA_UI_OVERLAY_DIR: dir }), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

export async function compileApplication(source, target = 'web', external = [], overlay) {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-vite-contract-'))
  const entry = join(directory, 'contract.ts')
  await writeFile(entry, source)
  const fixture = overlay ? null : await uiFixture()
  const plugin = await applicationPlugin(target, { overlay: overlay ?? fixture.overlay() })
  try {
    const output = await build({
      configFile: false, root: repository, publicDir: false, envDir: false, envPrefix: [], logLevel: 'silent',
      plugins: [plugin],
      define: { 'process.env.NODE_ENV': '"production"', 'process.env.MIKKA_BASE_PATH': '"/mikka"', 'process.env': '{}' },
      build: { write: false, minify: false, target: 'es2023', rolldownOptions: { input: entry, external, preserveEntrySignatures: 'strict' } },
    })
    const entryChunk = output.output.find(chunk => chunk.type === 'chunk' && chunk.isEntry)
    assert.ok(entryChunk)
    return { code: entryChunk.code, inventory: plugin.api.inventory() }
  } finally {
    await rm(directory, { recursive: true, force: true })
    await fixture?.cleanup()
  }
}

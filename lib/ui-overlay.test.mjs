import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { OVERLAY_APPLICATION, resolveOverlaySpecifier, uiOverlay } from './ui-overlay.mjs'
import { verifyServiceOverlay } from '../scripts/release/service-build-ci.mjs'

function repository() {
  return mkdtempSync(join(tmpdir(), 'ui-overlay-'))
}

/** Every application file an official checkout must carry, under `dir`. */
function writeApplication(dir, except = []) {
  for (const path of Object.values(OVERLAY_APPLICATION)) {
    if (except.includes(path)) continue
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), '')
  }
}

test('the official checkout carries the whole client application under core/renderer', () => {
  assert.deepEqual(OVERLAY_APPLICATION, {
    entry: 'core/renderer/index.tsx',
    desktopPlatform: 'core/renderer/platform.tsx',
    webPlatform: 'core/renderer/web/platform.tsx',
    desktopAuthForm: 'core/renderer/auth-form.tsx',
    styles: 'core/renderer/styles.css',
  })
})

test('the automatic service preflight rejects an incomplete official UI before dependency installation', async t => {
  const root = repository()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, '.hosted-ui')
  mkdirSync(directory, { recursive: true })
  for (const missing of Object.values(OVERLAY_APPLICATION)) {
    rmSync(directory, { recursive: true, force: true })
    writeApplication(directory, [missing])
    assert.throws(() => verifyServiceOverlay(root, 'a'.repeat(40)), { message: `UI_OVERLAY_APPLICATION_REQUIRED: ${missing}` })
  }
  writeApplication(directory)
  assert.doesNotThrow(() => verifyServiceOverlay(root, 'b'.repeat(40)))
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../scripts/release/service-build-ci.mjs', import.meta.url), 'utf8')
  const install = source.slice(source.indexOf('async function install('), source.indexOf('export async function stageContext('))
  const ancestry = install.indexOf('verifyOverlayMain(overlay, context.overlayCommit, env)')
  const preflight = install.indexOf('verifyServiceOverlay(root, context.overlayCommit)')
  assert.ok(ancestry >= 0 && preflight > ancestry && preflight < install.indexOf("stage: 'SERVICE_INSTALL'"))
})

test('without MIKKA_UI_OVERLAY_DIR there is no checkout, @hosted/ does not resolve and a pinned release refuses', t => {
  const root = repository()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const overlay = uiOverlay(root, {})
  assert.deepEqual(overlay, { dir: null, application: null })
  assert.throws(() => resolveOverlaySpecifier('@hosted/utils/cx', overlay), /UI_OVERLAY_IMPORT_WITHOUT_OVERLAY/)
  assert.equal(resolveOverlaySpecifier('@/lib/utils', overlay), null)
  assert.throws(() => uiOverlay(root, { MIKKA_UI_OVERLAY_SHA: 'a'.repeat(40) }), /UI_OVERLAY_DIR_REQUIRED_FOR_RELEASE/)
})

test('with MIKKA_UI_OVERLAY_DIR the application and @hosted/ resolve into the checkout', t => {
  const root = repository()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, '.hosted-ui')
  writeApplication(dir)
  const overlay = uiOverlay(root, { MIKKA_UI_OVERLAY_DIR: '.hosted-ui' })
  assert.equal(overlay.dir, dir)
  assert.deepEqual(overlay.application, Object.fromEntries(Object.entries(OVERLAY_APPLICATION).map(([name, path]) => [name, join(dir, path)])))
  assert.equal(resolveOverlaySpecifier('@hosted/utils/cx', overlay), join(dir, 'utils/cx'))
  assert.equal(resolveOverlaySpecifier('@hosted/core/components/ui/button', overlay), join(dir, 'core/components/ui/button'))
})

test('an application file that is a directory or leaves the checkout fails the build', t => {
  const root = repository()
  const outside = mkdtempSync(join(tmpdir(), 'ui-overlay-outside-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })
  const dir = join(root, '.hosted-ui')
  writeApplication(dir, [OVERLAY_APPLICATION.entry])
  mkdirSync(join(dir, OVERLAY_APPLICATION.entry))
  assert.throws(() => uiOverlay(root, { MIKKA_UI_OVERLAY_DIR: '.hosted-ui' }), { message: `UI_OVERLAY_APPLICATION_INVALID: ${OVERLAY_APPLICATION.entry}` })
  rmSync(join(dir, OVERLAY_APPLICATION.entry), { recursive: true })
  writeFileSync(join(outside, 'index.tsx'), '')
  symlinkSync(join(outside, 'index.tsx'), join(dir, OVERLAY_APPLICATION.entry))
  assert.throws(() => uiOverlay(root, { MIKKA_UI_OVERLAY_DIR: '.hosted-ui' }), { message: `UI_OVERLAY_APPLICATION_INVALID: ${OVERLAY_APPLICATION.entry}` })
})

test('a missing layer or one outside the repository fails the build', t => {
  const root = repository()
  const outside = mkdtempSync(join(tmpdir(), 'ui-overlay-outside-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })
  assert.throws(() => uiOverlay(root, { MIKKA_UI_OVERLAY_DIR: '.hosted-ui' }), /UI_OVERLAY_DIR_MISSING/)
  assert.throws(() => uiOverlay(root, { MIKKA_UI_OVERLAY_DIR: outside }), /UI_OVERLAY_DIR_OUTSIDE_REPOSITORY/)
  symlinkSync(outside, join(root, 'linked'))
  assert.throws(() => uiOverlay(root, { MIKKA_UI_OVERLAY_DIR: 'linked' }), /UI_OVERLAY_DIR_OUTSIDE_REPOSITORY/)
  assert.throws(() => uiOverlay(root, { MIKKA_UI_OVERLAY_DIR: '.' }), /UI_OVERLAY_DIR_OUTSIDE_REPOSITORY/)
})

// This repository carries no web, desktop, or mobile interface (decisions 2026-11-24-1000-all-ui-in-hosted
// and 2026-11-25-0915-delete-legacy-apps-mobile). All Web, Desktop, and iOS interfaces live in the private
// mikka-hosted-ui checkout (core/, web/, slots/, mobile-next/); the public build compiles that checkout
// (lib/ui-overlay.mjs) or a page that says the server has no interface (apps/frontend/src/headless.ts).
// This test keeps any UI source, stylesheet, font, or paid library from returning to public Mikka.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const overlay = process.env.MIKKA_UI_OVERLAY_DIR?.trim().replace(/^\.\//, '').replace(/\/$/, '')
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0').filter(Boolean)
  // The checkout is mounted inside this repository for official builds; it is not part of it.
  .filter(file => !file.startsWith('.hosted-ui/') && !(overlay && file.startsWith(`${overlay}/`)))
/** An import of `prefix` in any form: static, dynamic, require or re-export. */
const imports = (prefix, text) => new RegExp(`(?:\\bfrom|\\bimport\\s*\\(?|\\brequire\\()\\s*['"\`]${prefix}`).test(text)
const sources = tracked.filter(file => /\.(?:[cm]?[jt]sx?)$/.test(file) && !/^(?:docs|plans)\//.test(file))

test('no interface source, stylesheet, font, or legacy apps/mobile tree exists in public Mikka', () => {
  assert.deepEqual(tracked.filter(file => file.startsWith('apps/mobile/')), [])
  assert.deepEqual(tracked.filter(file => /\.(?:jsx|tsx|css|scss|sass|less|woff2?|ttf|otf)$/.test(file)), [])
})

test('no components/ or hooks/ tree: base components and interface hooks live in the official UI checkout', () => {
  assert.deepEqual(tracked.filter(file => /^(?:components|hooks|app\/fonts)\//.test(file)), [])
})

test('the retired @ui-slot/ seam is not imported again', () => {
  // The build's tests import the seam only to show the build refuses it.
  assert.deepEqual(sources.filter(file => file !== 'apps/frontend/scripts/application-plugin.test.mjs' && imports('@ui-slot/', readFileSync(file, 'utf8'))), [])
})

test('only the build glue and its tests name the checkout through @hosted/', () => {
  // Runtime code here must work without the checkout; only the code that builds or tests the official UI may reach it.
  const glue = /^(?:apps\/(?:frontend|desktop)\/scripts\/|lib\/ui-overlay\.|tests\/byos-application\.test\.mjs$|scripts\/no-public-ui\.test\.mjs$)/
  assert.deepEqual(sources.filter(file => !glue.test(file) && imports('@hosted/', readFileSync(file, 'utf8'))), [])
})

test('no paid component library is a dependency or an import here', () => {
  const paid = /['"`](?:@affectui|@beui(?:-pro)?|@collectui\/(?!bdui['"`])|@boardui)\b/
  assert.deepEqual(sources.filter(file => file !== 'scripts/no-public-ui.test.mjs' && paid.test(readFileSync(file, 'utf8'))), [])
  for (const manifest of tracked.filter(file => /(?:^|\/)package\.json$/.test(file))) {
    const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync(manifest, 'utf8'))
    assert.deepEqual(Object.keys({ ...dependencies, ...devDependencies }).filter(name => /^@(?:affectui|beui|boardui)\b/.test(name)), [], manifest)
  }
})

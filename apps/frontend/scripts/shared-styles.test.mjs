import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import postcss from 'postcss'
import { repository } from './application-plugin.mjs'
import { needsOfficialUi, officialUi, uiFixture } from './application-test-build.mjs'
import { sharedStylePlugins } from './shared-styles.mjs'
import { sharedCssTargets } from './css-targets.mjs'

const runNode = promisify(execFile)

// The shipped stylesheet is the official UI's (core/app/globals.css in its checkout).
const globalsPath = () => join(officialUi.dir, 'core/app/globals.css')
const css = () => readFile(globalsPath(), 'utf8')

/** Run the real build pass: Tailwind expands `@apply`, then Lightning CSS
 * compiles for the frozen targets. This is the order the application ships. */
async function compileThroughSharedStyles(source, { from = globalsPath(), overlay = officialUi } = {}) {
  const result = await postcss(sharedStylePlugins(repository, { overlay })).process(source, { from })
  return result.css
}

test('the shared targets are the frozen baseline from the application\'s Next-era build', () => {
  assert.deepEqual({ ...sharedCssTargets }, { chrome: 7274496, edge: 7274496, firefox: 7274496, safari: 1049600 })
})

test('the shipped stylesheet has no unexpanded @apply, so Tailwind ran before Lightning CSS', { skip: needsOfficialUi }, async () => {
  const output = await compileThroughSharedStyles(await css())
  assert.ok(!output.includes('@apply'), 'Tailwind expanded every @apply')
})

test('the base layer still applies the border color to every element', { skip: needsOfficialUi }, async () => {
  // `* { @apply border-border outline-ring/50; }` is what gives every element
  // its border and focus-ring color. Lightning CSS 1.30 and 1.32 drop the
  // selector when they see a nested `@apply`; the pinned 1.33 keeps it. If the
  // Tailwind pass ever moves after Lightning CSS, this is the rule that breaks.
  const output = await compileThroughSharedStyles(await css())
  assert.ok(
    output.includes('*{border-color:var(--border);outline-color:var(--ring)}'),
    'the universal rule keeps its border and ring colors',
  )
})

test('the shipped stylesheet keeps its color and type tokens', { skip: needsOfficialUi }, async () => {
  const output = await compileThroughSharedStyles(await css())
  for (const token of ['--color-brand-claude:', '--text-xs:', '--text-md:', '--font-sans:']) {
    assert.ok(output.includes(token), `${token} survives the shared pass`)
  }
})

// The checkout's colours are spelled once, in its styles/tokens.css (core/renderer/styles.css imports it right after
// core/app/globals.css, whose values name them); the shipped colours are the two together.
const tokensCss = () => readFile(join(officialUi.dir, 'styles/tokens.css'), 'utf8').catch(() => '')

test('the shipped stylesheet guards its lab() colors behind a support query', { skip: needsOfficialUi }, async () => {
  const output = await compileThroughSharedStyles(`${await css()}\n${await tokensCss()}`)
  assert.ok(
    output.includes('@supports (color:lab(0% 0 0))'),
    'lab() colors only apply where the browser supports them',
  )
})

test('the pass is deterministic for the same source', { skip: needsOfficialUi }, async () => {
  const source = await css()
  assert.equal(await compileThroughSharedStyles(source), await compileThroughSharedStyles(source))
})

test('official builds scan the checkout\'s gitignored layered and legacy directories, not components/, and a build without one scans nothing of it', async t => {
  // Build utility strings dynamically so Tailwind scanning this test file does not match them.
  const pxClass = (prefix, size) => `${prefix}-[${size}px]`
  const fixture = await uiFixture({
    'core/app/globals.css': '@import "tailwindcss";\n',
    'core/renderer/styles.css': '@import "../app/globals.css";\n',
    'core/components/base.tsx': `<div className="${pxClass('m', 31345)}" />`,
    'slots/workspace-entry.tsx': `<div className="${pxClass('w', 31339)}" />`,
    'web/views/screen.tsx': `<div className="${pxClass('text', 31337)}" />`,
    'lib/helper.tsx': `<div className="${pxClass('h', 31341)}" />`,
    'ui/button.tsx': `<div className="${pxClass('gap', 31347)}" />`,
    'shared/avatar.tsx': `<div className="${pxClass('pl', 31349)}" />`,
    'features/desktop/index.tsx': `<div className="${pxClass('pr', 31351)}" />`,
    'routes/app.tsx': `<div className="${pxClass('pt', 31353)}" />`,
    'components/paid.tsx': `<div className="${pxClass('p', 31343)}" />`,
  })
  t.after(fixture.cleanup)
  const overlay = fixture.overlay()
  const globals = join(fixture.dir, 'core/app/globals.css')
  const source = await readFile(globals, 'utf8')

  const compiled = await compileThroughSharedStyles(source, { from: globals, overlay })
  assert.ok(compiled.includes('31345px'), 'compiles core/ classes')
  assert.ok(compiled.includes('31337px'), 'compiles web/ classes')
  assert.ok(compiled.includes('31339px'), 'compiles slots/ classes')
  assert.ok(compiled.includes('31341px'), 'compiles lib/ classes')
  assert.ok(compiled.includes('31347px'), 'compiles ui/ classes')
  assert.ok(compiled.includes('31349px'), 'compiles shared/ classes')
  assert.ok(compiled.includes('31351px'), 'compiles features/ classes')
  assert.ok(compiled.includes('31353px'), 'compiles routes/ classes')
  assert.ok(!compiled.includes('31343px'), 'skips components/ so overlay.css retains component layer order')

  const headless = await compileThroughSharedStyles(source, { from: globals, overlay: { dir: null, application: null } })
  assert.ok(!['31337px', '31339px', '31341px', '31345px', '31347px', '31349px', '31351px', '31353px'].some(size => headless.includes(size)), 'no checkout, no checkout sources')

  const { stdout } = await runNode(process.execPath, [
    '--input-type=module',
    '-e',
    `import { readFileSync } from 'node:fs'; import postcss from 'postcss'; import { uiOverlay } from '../../lib/ui-overlay.mjs'; import { sharedStylePlugins } from './scripts/shared-styles.mjs';`
      + `const overlay = uiOverlay(${JSON.stringify(repository)}, { MIKKA_UI_OVERLAY_DIR: ${JSON.stringify(fixture.dir)} });`
      + `const res = await postcss(sharedStylePlugins(${JSON.stringify(repository)}, { overlay })).process(readFileSync(${JSON.stringify(globals)}, 'utf8'), { from: ${JSON.stringify(globals)} });`
      + `if (!res.css.includes('31337px') || !res.css.includes('31345px')) throw new Error('MISSING_OVERLAY_UTILITIES_FROM_FRONTEND_CWD');`
      + `console.log('ok');`,
  ], { cwd: join(repository, 'apps/frontend') })
  assert.equal(stdout.trim(), 'ok')
})

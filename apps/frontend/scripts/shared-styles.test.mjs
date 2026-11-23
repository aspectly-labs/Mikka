import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import postcss from 'postcss'
import { repository } from './application-plugin.mjs'
import { sharedStylePlugins } from './shared-styles.mjs'
import { sharedCssTargets } from './css-targets.mjs'

const css = name => readFile(new URL(`../../../app/${name}`, import.meta.url), 'utf8')

/** Run the real build pass: Tailwind expands `@apply`, then Lightning CSS
 * compiles for the frozen targets. This is the order the application ships. */
async function compileThroughSharedStyles(source, { from = 'app/globals.css', env, serverPages } = {}) {
  const result = await postcss(sharedStylePlugins(repository, { env, serverPages })).process(source, { from })
  return result.css
}

test('the shared targets are the frozen baseline from the application\'s Next-era build', () => {
  assert.deepEqual({ ...sharedCssTargets }, { chrome: 7274496, edge: 7274496, firefox: 7274496, safari: 1049600 })
})

test('the shipped stylesheet has no unexpanded @apply, so Tailwind ran before Lightning CSS', async () => {
  const output = await compileThroughSharedStyles(await css('globals.css'))
  assert.ok(!output.includes('@apply'), 'Tailwind expanded every @apply')
})

test('the base layer still applies the border color to every element', async () => {
  // `* { @apply border-border outline-ring/50; }` is what gives every element
  // its border and focus-ring color. Lightning CSS 1.30 and 1.32 drop the
  // selector when they see a nested `@apply`; the pinned 1.33 keeps it. If the
  // Tailwind pass ever moves after Lightning CSS, this is the rule that breaks.
  const output = await compileThroughSharedStyles(await css('globals.css'))
  assert.ok(
    output.includes('*{border-color:var(--border);outline-color:var(--ring)}'),
    'the universal rule keeps its border and ring colors',
  )
})

test('the shipped stylesheet keeps its color and type tokens', async () => {
  const output = await compileThroughSharedStyles(await css('globals.css'))
  for (const token of ['--color-brand-claude:', '--text-xs:', '--text-md:', '--font-sans:']) {
    assert.ok(output.includes(token), `${token} survives the shared pass`)
  }
})

test('the shipped stylesheet guards its lab() colors behind a support query', async () => {
  const output = await compileThroughSharedStyles(await css('globals.css'))
  assert.ok(
    output.includes('@supports (color:lab(0% 0 0))'),
    'lab() colors only apply where the browser supports them',
  )
})

test('the pass is deterministic for the same source', async () => {
  const source = await css('globals.css')
  assert.equal(await compileThroughSharedStyles(source), await compileThroughSharedStyles(source))
})

test('official builds scan gitignored overlay web/slots/lib utilities while serverPages and clean builds do not', async t => {
  await mkdir(join(repository, '.cache/typecheck'), { recursive: true })
  const overlay = await mkdtemp(join(repository, '.cache/typecheck/overlay-'))
  t.after(() => rm(overlay, { recursive: true, force: true }))
  await mkdir(join(overlay, 'slots'), { recursive: true })
  await mkdir(join(overlay, 'web/views'), { recursive: true })
  await mkdir(join(overlay, 'lib'), { recursive: true })
  await mkdir(join(overlay, 'components'), { recursive: true })
  // Build utility strings dynamically so Tailwind scanning this test file does not match them.
  const pxClass = (prefix, size) => `${prefix}-[${size}px]`
  await writeFile(join(overlay, 'slots/workspace-entry.tsx'), `<div className="${pxClass('w', 31339)}" />`)
  await writeFile(join(overlay, 'web/views/screen.tsx'), `<div className="${pxClass('text', 31337)}" />`)
  await writeFile(join(overlay, 'lib/helper.tsx'), `<div className="${pxClass('h', 31341)}" />`)
  await writeFile(join(overlay, 'components/paid.tsx'), `<div className="${pxClass('p', 31343)}" />`)

  const globals = await css('globals.css')
  const rendererStyles = await readFile(join(repository, 'apps/desktop/src/renderer/styles.css'), 'utf8')

  const baseline = await compileThroughSharedStyles(globals, { env: {} })
  assert.ok(!baseline.includes('31337px') && !baseline.includes('31339px') && !baseline.includes('31341px') && !baseline.includes('31343px'))

  const env = { MIKKA_UI_OVERLAY_DIR: overlay }
  for (const [source, from] of [[globals, 'app/globals.css'], [rendererStyles, 'apps/desktop/src/renderer/styles.css']]) {
    const compiled = await compileThroughSharedStyles(source, { from, env })
    assert.ok(compiled.includes('31337px'), `${from} compiles .hosted-ui/web classes`)
    assert.ok(compiled.includes('31339px'), `${from} compiles .hosted-ui/slots classes`)
    assert.ok(compiled.includes('31341px'), `${from} compiles .hosted-ui/lib classes`)
    assert.ok(!compiled.includes('31343px'), `${from} skips .hosted-ui/components so overlay.css retains component layer order`)
  }

  const afterWithoutOverlay = await compileThroughSharedStyles(globals, { env: {} })
  assert.ok(!afterWithoutOverlay.includes('31337px'), 'Tailwind cache is not poisoned across builds without MIKKA_UI_OVERLAY_DIR')

  const serverPagesCss = await compileThroughSharedStyles(globals, { env, serverPages: true })
  assert.ok(!serverPagesCss.includes('31337px') && !serverPagesCss.includes('31339px'), 'serverPages skips overlay @source scanning')
})

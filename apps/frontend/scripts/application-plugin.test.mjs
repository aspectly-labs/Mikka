import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import postcss from 'postcss'
import { repository } from './application-plugin.mjs'
import { compileApplication as compile, needsOfficialUi, officialUi, uiFixture } from './application-test-build.mjs'
import { sharedStylePlugins } from './shared-styles.mjs'

let sequence = 0
test('the actual Vite graph preserves action arity and the web/native transport separation', async () => {
  const source = 'export { listProjects, listWorkspaceProjects } from "@/app/actions/projects"; export { getArtifact } from "@/app/actions/artifacts"; export { startCardVerification, startPointsPurchase } from "@/lib/billing/verification-client";'
  const windowBefore = globalThis.window
  const fetchBefore = globalThis.fetch
  const workspace = 'bf0f49e9-60ef-42a2-9e46-519b6010d7ef'
  try {
    for (const target of ['web', 'desktop']) {
      const { code, inventory } = await compile(source, target)
      assert.ok(inventory.usedActions.includes('projects.listProjects'))
      assert.ok(inventory.usedActions.includes('billing.startPointsPurchase'))
      assert.deepEqual(inventory.serverModules, [])
      assert.ok(inventory.inputs.every(path => !path.startsWith('app/actions/')))
      const requests = []
      globalThis.window = { location: new URL(target === 'web' ? 'https://app.example/mikka/en' : 'mikka://app/mikka/en') }
      globalThis.fetch = async (url, options) => { requests.push({ url, options }); return Response.json({ version: 1, ok: true, result: null }) }
      const actions = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#vite-contract-${++sequence}`)
      await actions.listProjects('ignored SWR key')
      await actions.listWorkspaceProjects(workspace, 'ignored SWR key')
      await actions.getArtifact('artifact-id', 'ignored extra argument')
      await actions.startCardVerification(workspace)
      await actions.startPointsPurchase(workspace, 25)
      assert.deepEqual(requests.map(request => JSON.parse(request.options.body)), [
        { version: 1, action: 'projects.listProjects', args: [] },
        { version: 1, action: 'projects.listWorkspaceProjects', args: [workspace] },
        { version: 1, action: 'artifacts.getArtifact', args: ['artifact-id'] },
        { version: 1, action: 'billing.startCardVerification', args: [workspace] },
        { version: 1, action: 'billing.startPointsPurchase', args: [workspace, 25] },
      ])
      assert.ok(requests.every(request => request.url === `/mikka/api/${target === 'web' ? '' : 'desktop/'}rpc`))
      assert.ok(requests.every(request => request.options.credentials === (target === 'web' ? 'same-origin' : 'omit')))
      assert.ok(requests.every(request => !Object.hasOwn(request.options.headers, 'authorization')))
    }
  } finally { globalThis.window = windowBefore; globalThis.fetch = fetchBefore }
})

test('actual Vite resolution rejects server runtime and unregistered action consumers before output', async () => {
  for (const source of [
    'import "node:fs"',
    'import "next/headers"',
    'import "server-only"',
    'import "@/lib/auth"',
    // Server translations read the request scope and ship both message catalogs;
    // a component that needs them must import the client entry instead. This
    // names a value and calls it, so the bundler cannot drop the import before
    // resolution.
    'import { getTranslations } from "@/lib/intl/i18n-server"; export const read = () => getTranslations("Common")',
  ]) await assert.rejects(compile(source), /FRONTEND_SERVER_(?:IMPORT|MODULE)/)
  await assert.rejects(compile('export { createIssueForTeam } from "@/app/actions/issues"'), /FRONTEND_ACTION_NOT_ALLOWED: issues.createIssueForTeam/)
})

test('actual emitted CommonJS and ESM syntax themes retain their conditional export semantics', async () => {
  const require = createRequire(import.meta.url)
  const commonjs = require.resolve('react-syntax-highlighter/dist/cjs/styles/prism')
  const esm = require.resolve('react-syntax-highlighter/dist/esm/styles/prism/coldark-dark')
  const expected = require('react-syntax-highlighter/dist/cjs/styles/prism').coldarkDark
  const source = `export { coldarkDark as commonjs } from ${JSON.stringify(commonjs)}; export { default as esm } from ${JSON.stringify(esm)};`
  for (const target of ['web', 'desktop']) {
    const { code } = await compile(source, target)
    const themes = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#syntax-exports-${++sequence}`)
    assert.deepEqual(themes.commonjs, expected)
    assert.deepEqual(themes.esm, expected)
  }
})

test('Vite uses the same existing Lightning CSS color space and neutral mixing as hosted CSS', { skip: needsOfficialUi }, async () => {
  const filename = resolve(officialUi.dir, 'core/app/globals.css')
  const css = await postcss(sharedStylePlugins(repository, { overlay: officialUi })).process(await readFile(filename, 'utf8'), { from: filename })
  const declarations = new Map()
  css.root.walkRules(rule => {
    if (rule.selector !== ':root' && rule.selector !== '.dark') return
    for (const node of rule.nodes) if (node.type === 'decl') declarations.set(`${rule.selector}/${node.prop}`, node.value)
  })
  assert.equal(declarations.get(':root/--sidebar-primary'), 'lab(44.0605% 29.0279 -86.0352)')
  assert.equal(declarations.get(':root/--sidebar'), 'lab(98.26% 0 0)')
  assert.equal(declarations.get('.dark/--sidebar-primary'), 'lab(36.9089% 35.0961 -85.6872)')
  assert.equal(declarations.get('.dark/--sidebar'), 'lab(1.3738% 0 0)')
  // Cartesian mixing keeps the primary blue on the neutral sidebar ground.
  assert.match(declarations.get(':root/--sidebar-primary-soft'), /color-mix\(in oklab,\s*var\(--sidebar-primary\)\s*15%,\s*var\(--sidebar\)\)/)
  assert.match(declarations.get('.dark/--sidebar-primary-soft'), /color-mix\(in oklab,\s*var\(--sidebar-primary\)\s*40%,\s*var\(--sidebar\)\)/)
})

test('the application is the checkout\'s core/renderer, every file of it is required, and without a checkout only the headless page builds', async t => {
  const { OVERLAY_APPLICATION, uiOverlay } = await import('../../../lib/ui-overlay.mjs')
  const fixture = await uiFixture({
    'core/renderer/index.tsx': 'globalThis.officialEntry = "official-entry"',
    'core/renderer/platform.tsx': 'export const platform = "desktop-platform"',
    'core/renderer/web/platform.tsx': 'export const platform = "web-platform"',
    'core/renderer/auth-form.tsx': 'export const AuthForm = "desktop-auth-form"',
    'core/components/auth-form.tsx': 'export const AuthForm = "web-auth-form"',
  })
  t.after(fixture.cleanup)
  const overlay = fixture.overlay()
  const relDir = relative(repository, fixture.dir).split(sep).join('/')

  const application = 'import "mikka:application"; export const ready = true'
  for (const target of ['web', 'desktop']) {
    const { code, inventory } = await compile(application, target, [], overlay)
    assert.match(code, /official-entry/)
    assert.ok(inventory.inputs.includes(`${relDir}/core/renderer/index.tsx`))
    assert.ok(!inventory.inputs.includes('apps/frontend/src/headless.ts'))
    assert.equal(inventory.headless, undefined)
  }
  const platform = 'export { platform } from "mikka:platform"; export { AuthForm } from "@hosted/core/components/auth-form"'
  assert.match((await compile(platform, 'web', [], overlay)).code, /web-platform[\s\S]*web-auth-form|web-auth-form[\s\S]*web-platform/)
  assert.match((await compile(platform, 'desktop', [], overlay)).code, /desktop-platform[\s\S]*desktop-auth-form|desktop-auth-form[\s\S]*desktop-platform/)
  for (const target of ['web', 'desktop']) await assert.rejects(compile('import "@ui-slot/workspace-entry"', target, [], overlay), /UI_SLOT_RETIRED: @ui-slot\/workspace-entry/)

  for (const path of Object.values(OVERLAY_APPLICATION)) {
    const file = join(fixture.dir, path)
    const source = await readFile(file, 'utf8')
    await rm(file)
    assert.throws(() => uiOverlay(repository, { MIKKA_UI_OVERLAY_DIR: fixture.dir }), { message: `UI_OVERLAY_APPLICATION_REQUIRED: ${path}` })
    await writeFile(file, source)
  }

  const headless = { dir: null, application: null }
  const { code, inventory } = await compile(application, 'web', [], headless)
  assert.deepEqual(inventory.inputs.filter(path => !path.endsWith('/contract.ts')), ['apps/frontend/src/headless.ts'])
  assert.equal(inventory.headless, true)
  assert.doesNotMatch(code, /official-entry/)
  await assert.rejects(compile('export { platform } from "mikka:platform"', 'web', [], headless), /FRONTEND_PLATFORM_WITHOUT_UI/)
  await assert.rejects(compile('import "@hosted/core/renderer/app"', 'web', [], headless), /UI_OVERLAY_IMPORT_WITHOUT_OVERLAY/)
  // A desktop test build without the checkout shows the same page; apps/desktop/scripts/build.mjs refuses a production one.
  const desktop = await compile(application, 'desktop', [], headless)
  assert.deepEqual(desktop.inventory.inputs.filter(path => !path.endsWith('/contract.ts')), ['apps/frontend/src/headless.ts'])
})

test('official builds compile @hosted/web and the desktop feature override', async t => {
  const fixture = await uiFixture({
    'web/hooks/use-feature-availability.ts': 'import "posthog-js"; export function useFeatureAvailability() { return "hosted-posthog" }',
    'web/entry.tsx': 'import { useFeatureAvailability } from "@hosted/web/hooks/use-feature-availability"\n'
      + 'import { listProjects } from "@/app/actions/projects"\n'
      + 'export function Workspace() { return { useFeatureAvailability, listProjects } }\n',
  })
  t.after(fixture.cleanup)
  const overlay = fixture.overlay()
  const relDir = relative(repository, fixture.dir).split(sep).join('/')
  const consumer = 'export { Workspace } from "@hosted/web/entry"'
  const external = ['posthog-js', 'react', 'react/jsx-runtime', 'use-intl']
  const webCompiled = await compile(consumer, 'web', external, overlay)
  assert.ok(webCompiled.inventory.usedActions.includes('projects.listProjects'))
  assert.ok(webCompiled.inventory.inputs.includes(`${relDir}/web/entry.tsx`))
  assert.ok(webCompiled.inventory.inputs.includes(`${relDir}/web/hooks/use-feature-availability.ts`))

  const desktopCompiled = await compile(consumer, 'desktop', external, overlay)
  assert.ok(desktopCompiled.inventory.inputs.includes('apps/desktop/src/renderer/feature-availability.ts'))
  assert.ok(!desktopCompiled.inventory.inputs.includes(`${relDir}/web/hooks/use-feature-availability.ts`))
  assert.doesNotMatch(desktopCompiled.code, /hosted-posthog|posthog-js/)
})

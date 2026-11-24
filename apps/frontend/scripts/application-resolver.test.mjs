import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { applicationPlugin, repository } from './application-plugin.mjs'
import { uiFixture } from './application-test-build.mjs'

test('redirected and canonical imports retain the same complete resolution metadata', async t => {
  const fixture = await uiFixture()
  t.after(fixture.cleanup)
  const plugin = await applicationPlugin('desktop', { overlay: fixture.overlay() })
  // Desktop redirects the browser auth client to its own (application-plugin.mjs desktopAliases).
  const id = resolve(repository, 'apps/desktop/src/renderer/auth-client.ts')
  const importer = resolve(fixture.dir, 'core/components/auth-form.tsx')
  const options = { isEntry: false, attributes: { type: 'javascript' } }
  const resolved = { id, moduleSideEffects: false, meta: { packageJsonPath: resolve(repository, 'package.json') } }
  const calls = []
  const context = { async resolve(source, parent, selected) {
    calls.push({ source, parent, selected })
    return resolved
  } }
  const redirected = await plugin.resolveId.call(context, '@/lib/auth-client', importer, options)
  const canonical = await plugin.resolveId.call(context, '@/apps/desktop/src/renderer/auth-client', importer, options)
  assert.equal(redirected, resolved, 'a redirect must retain package format and side-effect metadata')
  assert.equal(canonical, resolved)
  assert.deepEqual(calls, [id, id.slice(0, -3)].map(source => ({ source, parent: importer, selected: { ...options, skipSelf: true } })))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { DESKTOP_ROOT_SCRIPTS, desktopLockClosure, lockfileTouchesDesktop, manifestTouchesDesktop } from './desktop-inputs.mjs'

const lock = body => yaml.dump({ lockfileVersion: '9.0', settings: { autoInstallPeers: true }, ...body })
const base = {
  importers: {
    '.': { dependencies: { shared: { specifier: '^1', version: '1.0.0' } } },
    'apps/desktop': { devDependencies: { '@mikka/protocol': { specifier: 'workspace:*', version: 'link:../../packages/protocol' } } },
    'packages/protocol': { dependencies: { zod: { specifier: '^4', version: '4.0.0' } } },
    'apps/mobile': { dependencies: { expo: { specifier: '^55', version: '55.0.0' } } },
  },
  packages: { 'shared@1.0.0': { resolution: { integrity: 'a' } }, 'zod@4.0.0': { resolution: { integrity: 'z' } }, 'expo@55.0.0': { resolution: { integrity: 'e' } }, 'dep@2.0.0': { resolution: { integrity: 'd' } } },
  snapshots: { 'shared@1.0.0': { dependencies: { dep: '2.0.0' } }, 'zod@4.0.0': {}, 'expo@55.0.0': {}, 'dep@2.0.0': {} },
}
const changed = mutate => { const copy = structuredClone(base); mutate(copy); return lock(copy) }

test('a lockfile change outside the root, Desktop and its workspace links does not reach Desktop', () => {
  assert.equal(lockfileTouchesDesktop(lock(base), changed(l => { l.importers['apps/mobile'].dependencies.expo.version = '55.0.1'; l.packages['expo@55.0.1'] = {}; l.snapshots['expo@55.0.1'] = {} })), false)
})

test('a change in the root importer, a linked workspace package, a transitive package or a global setting reaches Desktop', () => {
  for (const mutate of [
    l => { l.importers['.'].dependencies.shared.version = '1.0.1'; l.snapshots['shared@1.0.1'] = {} },
    l => { l.importers['packages/protocol'].dependencies.zod.version = '4.0.1'; l.snapshots['zod@4.0.1'] = {} },
    l => { l.snapshots['shared@1.0.0'].dependencies.dep = '2.0.1'; l.snapshots['dep@2.0.1'] = {} },
    l => { l.packages['dep@2.0.0'].resolution.integrity = 'tampered' },
    l => { l.overrides = { dep: '2.0.1' } },
  ]) assert.equal(lockfileTouchesDesktop(lock(base), changed(mutate)), true, String(mutate))
  assert.equal(lockfileTouchesDesktop(lock(base), 'not: [yaml'), true, 'unreadable input counts as a change')
})

test('the real lockfile yields a closure that includes Desktop and its linked packages', () => {
  const entries = desktopLockClosure(readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8'))
  for (const importer of ['.', 'apps/desktop', 'packages/protocol', 'packages/daemon']) assert.ok(entries.includes(`importer:${importer}=present`), importer)
  assert.ok(entries.some(entry => entry.startsWith('snapshot:electron@')))
})

test('only the root scripts desktop.yml runs, dependencies and install settings in package.json reach Desktop', () => {
  const manifest = { scripts: { 'test:platform': 'a', 'test:other': 'b' }, devDependencies: { x: '1' } }
  const edit = mutate => { const copy = structuredClone(manifest); mutate(copy); return JSON.stringify(copy) }
  assert.equal(manifestTouchesDesktop(JSON.stringify(manifest), edit(m => { m.scripts['test:other'] = 'c' })), false)
  for (const mutate of [m => { m.scripts['test:platform'] = 'z' }, m => { m.devDependencies.x = '2' }, m => { m.pnpm = { overrides: {} } }])
    assert.equal(manifestTouchesDesktop(JSON.stringify(manifest), edit(mutate)), true, String(mutate))
  const workflow = readFileSync(new URL('../../.github/workflows/desktop.yml', import.meta.url), 'utf8')
  for (const name of DESKTOP_ROOT_SCRIPTS) assert.match(workflow, new RegExp(`pnpm (?:run )?${name.replace(/[:]/g, '\\:')}\\b`), `desktop.yml runs ${name}`)
})

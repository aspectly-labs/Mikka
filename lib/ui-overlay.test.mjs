import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { overlayAliases, resolveOverlaySpecifier, PUBLIC_CONTRACT_SLOTS, UI_SLOTS, UI_SLOT_EXPORTS } from './ui-overlay.mjs'
import { verifyServiceOverlay } from '../scripts/release/service-build-ci.mjs'

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'ui-overlay-'))
  mkdirSync(join(root, 'components/slots'), { recursive: true })
  return root
}

test('the automatic service preflight rejects an incomplete 2-entry official UI before dependency installation', async t => {
  const root = repository()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, '.hosted-ui/slots')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'auth-sso.tsx'), '')
  assert.throws(() => verifyServiceOverlay(root, 'a'.repeat(40)), /UI_OVERLAY_SLOT_REQUIRED: workspace-entry/)
  rmSync(join(directory, 'auth-sso.tsx'))
  writeFileSync(join(directory, 'workspace-entry.tsx'), '')
  assert.throws(() => verifyServiceOverlay(root, 'a'.repeat(40)), /UI_OVERLAY_SLOT_REQUIRED: auth-sso/)
  writeFileSync(join(directory, 'auth-sso.tsx'), '')
  assert.doesNotThrow(() => verifyServiceOverlay(root, 'b'.repeat(40)))
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../scripts/release/service-build-ci.mjs', import.meta.url), 'utf8')
  const install = source.slice(source.indexOf('async function install('), source.indexOf('export async function stageContext('))
  const ancestry = install.indexOf('verifyOverlayMain(overlay, context.overlayCommit, env)')
  const preflight = install.indexOf('verifyServiceOverlay(root, context.overlayCommit)')
  assert.ok(ancestry >= 0 && preflight > ancestry && preflight < install.indexOf("stage: 'SERVICE_INSTALL'"))
})

test('without MIKKA_UI_OVERLAY_DIR only the 2 entry slots resolve to public contracts and @hosted/ does not resolve', t => {
  const root = repository()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.deepEqual(UI_SLOTS, ['auth-sso', 'workspace-entry'])
  assert.deepEqual(UI_SLOT_EXPORTS, { 'auth-sso': ['AuthSso'], 'workspace-entry': ['Workspace'] })
  const aliases = overlayAliases(root, {})
  assert.equal(aliases.dir, null)
  assert.deepEqual(Object.keys(aliases.absolute), ['@ui-slot/auth-sso', '@ui-slot/workspace-entry'])
  assert.equal(aliases.absolute['@ui-slot/auth-sso'], join(root, 'components/slots/auth-sso.tsx'))
  assert.equal(aliases.absolute['@ui-slot/workspace-entry'], join(root, 'components/slots/workspace-entry.tsx'))
  assert.equal(Object.hasOwn(aliases, 'turbopack'), false)
  assert.equal(resolveOverlaySpecifier('@ui-slot/workspace-entry', aliases), join(root, 'components/slots/workspace-entry.tsx'))
  assert.throws(() => resolveOverlaySpecifier('@hosted/utils/cx', aliases), /UI_OVERLAY_IMPORT_WITHOUT_OVERLAY/)
  assert.equal(resolveOverlaySpecifier('@/lib/utils', aliases), null)
})

test('with MIKKA_UI_OVERLAY_DIR workspace-entry resolves into the hosted layer and @hosted/ to the layer root', t => {
  const root = repository()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.hosted-ui/slots'), { recursive: true })
  for (const name of UI_SLOTS) if (!PUBLIC_CONTRACT_SLOTS.has(name)) writeFileSync(join(root, '.hosted-ui/slots', name + '.tsx'), '')
  const aliases = overlayAliases(root, { MIKKA_UI_OVERLAY_DIR: '.hosted-ui' })
  assert.equal(aliases.dir, join(root, '.hosted-ui'))
  assert.equal(aliases.absolute['@ui-slot/workspace-entry'], join(root, '.hosted-ui/slots/workspace-entry.tsx'))
  assert.equal(resolveOverlaySpecifier('@hosted/utils/cx', aliases), join(root, '.hosted-ui/utils/cx'))
  assert.throws(() => resolveOverlaySpecifier('@ui-slot/nothing', aliases), /UI_SLOT_UNKNOWN/)
  assert.throws(() => resolveOverlaySpecifier('@ui-slot/bot-avatar', aliases), /UI_SLOT_UNKNOWN/)
})

test('an unpinned development overlay keeps auth-sso optional as a public contract and requires workspace-entry', t => {
  const root = repository()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, '.hosted-ui')
  mkdirSync(join(dir, 'slots'), { recursive: true })
  assert.deepEqual([...PUBLIC_CONTRACT_SLOTS], ['auth-sso'])
  const env = { MIKKA_UI_OVERLAY_DIR: dir }
  assert.throws(() => overlayAliases(root, env), { message: 'UI_OVERLAY_SLOT_REQUIRED: workspace-entry' })
  writeFileSync(join(dir, 'slots/workspace-entry.tsx'), '')
  const aliases = overlayAliases(root, env)
  assert.equal(aliases.absolute['@ui-slot/auth-sso'], join(root, 'components/slots/auth-sso.tsx'))
  assert.equal(aliases.absolute['@ui-slot/workspace-entry'], join(dir, 'slots/workspace-entry.tsx'))
  assert.throws(() => overlayAliases(root, { MIKKA_UI_OVERLAY_SHA: 'a'.repeat(40) }), /UI_OVERLAY_DIR_REQUIRED_FOR_RELEASE/)
})

test('a missing layer or one outside the repository fails the build', t => {
  const root = repository()
  const outside = mkdtempSync(join(tmpdir(), 'ui-overlay-outside-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })
  assert.throws(() => overlayAliases(root, { MIKKA_UI_OVERLAY_DIR: '.hosted-ui' }), /UI_OVERLAY_DIR_MISSING/)
  assert.throws(() => overlayAliases(root, { MIKKA_UI_OVERLAY_DIR: outside }), /UI_OVERLAY_DIR_OUTSIDE_REPOSITORY/)
  symlinkSync(outside, join(root, 'linked'))
  assert.throws(() => overlayAliases(root, { MIKKA_UI_OVERLAY_DIR: 'linked' }), /UI_OVERLAY_DIR_OUTSIDE_REPOSITORY/)
  assert.throws(() => overlayAliases(root, { MIKKA_UI_OVERLAY_DIR: '.' }), /UI_OVERLAY_DIR_OUTSIDE_REPOSITORY/)
})

// A slot's required exports (UI_SLOT_EXPORTS) are what a deployed layer must
// provide. A named import of anything else fails the hosted production build
// when the deployed layer predates it, so optional exports go through a
// namespace import (docs/ui-overlay.md).
test('callers import only the registered 2-entry slot exports, nav/bot-avatar is decoupled, and each default exports them', async () => {
  // A worktree path can hold a space, and `.pathname` would leave it as `%20`.
  const root = fileURLToPath(new URL('..', import.meta.url))
  assert.deepEqual(Object.keys(UI_SLOT_EXPORTS).sort(), [...UI_SLOTS].sort())

  const botAvatarSource = readFileSync(join(root, 'components/nav/bot-avatar.tsx'), 'utf8')
  assert.doesNotMatch(botAvatarSource, /@ui-slot\/|components\/slots\/bot-avatar/)

  const sources = []
  const walk = dir => {
    const abs = join(root, dir)
    if (!existsSync(abs)) return
    for (const entry of readdirSync(abs)) {
      const path = join(dir, entry)
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      if (statSync(join(root, path)).isDirectory()) walk(path)
      else if (/\.(?:tsx?|mjs|jsx?)$/.test(entry)) sources.push(path)
    }
  }
  for (const dir of ['app', 'lib', 'apps/desktop/src', 'apps/frontend/src']) walk(dir)
  // Server-pages components must stay free of legacy slots even before Wave 2 prunes unused public UI.
  const wave2Pruned = !existsSync(join(root, 'components/app-shell.tsx'))
  if (wave2Pruned) {
    for (const dir of ['components', 'hooks']) walk(dir)
  } else {
    for (const file of ['components/auth-form.tsx', 'components/nav/bot-avatar.tsx', 'components/plugins/github-settings.tsx',
      'components/settings/primitives.tsx', 'components/settings/web-server-control.tsx',
      'components/workspace/create-workspace-form.tsx', 'components/workspace/invitation-card.tsx', 'components/workspace/workspace-loading.tsx']) {
      if (existsSync(join(root, file))) sources.push(file)
    }
    for (const dir of ['components/artifacts', 'components/auth', 'components/blocks/auth-19', 'components/brand', 'components/desktop', 'components/icons', 'components/labels', 'components/ui']) {
      walk(dir)
    }
  }

  const named = /(?:import|export)\s*(?:type\s+)?\{([^}]*)\}\s*from\s*'@ui-slot\/([^']+)'/g
  const anySlotImport = /(?:from|import\()\s*'@ui-slot\/([^']+)'/g
  const problems = []
  for (const file of sources) {
    if (file.startsWith('components/slots/') || file.startsWith('lib/ui-overlay')) continue
    const text = readFileSync(join(root, file), 'utf8')
    for (const [, slot] of text.matchAll(anySlotImport)) {
      if (!Object.hasOwn(UI_SLOT_EXPORTS, slot)) problems.push(`${file} references unknown slot @ui-slot/${slot}`)
    }
    for (const [, names, slot] of text.matchAll(named)) {
      for (const name of names.split(',').map(part => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean)) {
        if (!UI_SLOT_EXPORTS[slot]?.includes(name)) problems.push(`${file} imports ${name} from @ui-slot/${slot}`)
      }
    }
  }
  for (const [slot, names] of Object.entries(UI_SLOT_EXPORTS)) {
    const text = readFileSync(join(root, `components/slots/${slot}.tsx`), 'utf8')
    for (const name of names) {
      if (!new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(text)) problems.push(`components/slots/${slot}.tsx does not export ${name}`)
    }
  }
  assert.deepEqual(problems, [])
})

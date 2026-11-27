import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REQUIRE_OFFICIAL_UI, officialUiRequired, officialUiSkip } from './official-ui-requirement.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))

test('a present checkout never skips, with or without the requirement', () => {
  for (const value of [undefined, '', '0', '1']) assert.equal(officialUiSkip('/checkout/core', 'x', { [REQUIRE_OFFICIAL_UI]: value }), false)
})

test('a missing checkout skips with a reason unless the requirement is set', () => {
  for (const value of [undefined, '', ' ', '0']) {
    assert.equal(officialUiRequired({ [REQUIRE_OFFICIAL_UI]: value }), false)
    assert.match(officialUiSkip(null, '.hosted-ui', { [REQUIRE_OFFICIAL_UI]: value }), /^needs the official UI checkout \(\.hosted-ui\)/)
  }
  assert.throws(() => officialUiSkip(null, '.hosted-ui', { [REQUIRE_OFFICIAL_UI]: '1' }), /^Error: OFFICIAL_UI_REQUIRED: MIKKA_REQUIRE_OFFICIAL_UI=1 .*\(\.hosted-ui\)/)
})

test('a malformed requirement fails closed instead of reading as off', () => {
  for (const value of ['true', 'yes', '2']) {
    assert.throws(() => officialUiRequired({ [REQUIRE_OFFICIAL_UI]: value }), /OFFICIAL_UI_REQUIREMENT_INVALID/)
    assert.throws(() => officialUiSkip(null, 'x', { [REQUIRE_OFFICIAL_UI]: value }), /OFFICIAL_UI_REQUIREMENT_INVALID/)
  }
})

// The real helpers in a child process without any checkout: the repository-view one is pointed at a directory that
// does not exist, the overlay ones get no MIKKA_UI_OVERLAY_DIR.
const { NODE_TEST_CONTEXT: _context, MIKKA_UI_OVERLAY_DIR: _dir, MIKKA_UI_OVERLAY_SHA: _sha, [REQUIRE_OFFICIAL_UI]: _required, ...inherited } = process.env
const missing = { ...inherited, MIKKA_UI_OVERLAY_DIR: '.cache/no-official-ui-checkout' }
const helpers = [
  ['scripts/official-ui-tree.mjs', missing],
  ['apps/desktop/scripts/official-ui.mjs', inherited],
  ['apps/frontend/scripts/application-test-build.mjs', inherited],
]
const run = (args, env) => spawnSync(process.execPath, args, { cwd: repository, env, encoding: 'utf8', timeout: 120_000 })
const probe = (module, env) => run(['--input-type=module', '-e', `const { needsOfficialUi } = await import(${JSON.stringify(new URL(module, new URL('..', import.meta.url)).href)}); console.log(JSON.stringify(needsOfficialUi))`], env)

for (const [module, env] of helpers) test(`${module} skips without the checkout and fails when it is required`, () => {
  const skipped = probe(module, env)
  assert.equal(skipped.status, 0, skipped.stderr)
  assert.match(JSON.parse(skipped.stdout.trim().split('\n').at(-1)), /^needs the official UI checkout/)
  const required = probe(module, { ...env, [REQUIRE_OFFICIAL_UI]: '1' })
  assert.notEqual(required.status, 0, 'a required checkout that is missing must not import cleanly')
  assert.match(required.stderr, /OFFICIAL_UI_REQUIRED/)
})

test('a real official-UI test file skips by default and fails under the requirement', () => {
  const file = 'scripts/badge-size-policy.test.mjs'
  const skipped = run(['--test', '--test-reporter=tap', file], missing)
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr)
  assert.match(skipped.stdout, /# SKIP needs the official UI checkout/)
  const required = run(['--test', '--test-reporter=tap', file], { ...missing, [REQUIRE_OFFICIAL_UI]: '1' })
  assert.notEqual(required.status, 0, 'the file must fail, not skip')
  assert.match(required.stdout + required.stderr, /OFFICIAL_UI_REQUIRED/)
  assert.doesNotMatch(required.stdout, /# SKIP/)
})

test('a fixture repository run from another directory is not held to the requirement', () => {
  const tree = new URL('./official-ui-tree.mjs', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `const { needsOfficialUi } = await import(${JSON.stringify(tree)}); console.log(JSON.stringify(needsOfficialUi))`],
    { cwd: fileURLToPath(new URL('./ci/fixtures/', import.meta.url)), env: { ...inherited, [REQUIRE_OFFICIAL_UI]: '1' }, encoding: 'utf8', timeout: 60_000 })
  assert.equal(result.status, 0, result.stderr)
  assert.match(JSON.parse(result.stdout.trim()), /^needs the official UI checkout/)
})

test('no test skips on a missing official UI checkout on its own', () => {
  // A hand-written skip bypasses the switch: under MIKKA_REQUIRE_OFFICIAL_UI=1 it would still pass by skipping.
  const listed = spawnSync('git', ['ls-files', '-z', '*.test.*'], { cwd: repository, encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  const offenders = []
  for (const file of listed.stdout.split('\0').filter(Boolean)) {
    if (file.startsWith('scripts/official-ui-requirement')) continue
    const source = readFileSync(join(repository, file), 'utf8')
    if (/skip\(\s*['"`][^'"`]*hosted-ui not checked out/.test(source) || /MIKKA_REQUIRE_OFFICIAL_UI\s*===?/.test(source)) offenders.push(file)
  }
  assert.deepEqual(offenders, [], 'route these through officialUiSkip')
})

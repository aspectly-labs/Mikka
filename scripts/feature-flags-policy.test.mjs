import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  declaredFlagKeys,
  flagKeyReads,
  releaseFlagEntries,
  releaseFlagProblems,
  undeclaredFlagKeyProblems,
} from './feature-flags-policy.mjs'

const registry = body => `export interface ReleaseFlagDefinition { owner: string; removeBy: string; description: string }
export const releaseFlags = {${body}} as const satisfies Record<string, ReleaseFlagDefinition>
`
const entry = (key, { owner = 'release-owner', removeBy = '2026-12-11', description = 'New checkout' } = {}) =>
  `\n  '${key}': { owner: '${owner}', removeBy: '${removeBy}', description: '${description}' },`

test('the release-flag registry exists and every entry is before its removeBy date', () => {
  assert.ok(Array.isArray(releaseFlagEntries()), 'lib/feature-flags.ts must export releaseFlags')
  assert.deepEqual(releaseFlagProblems(), [])
})

test('every flag key read in shipped code is declared in a flag registry', () => {
  assert.deepEqual(undeclaredFlagKeyProblems(), [])
})

test('a release flag past its removeBy date fails; on the date it still passes', () => {
  const source = registry(entry('mikka-new-checkout', { removeBy: '2026-12-11' }))
  assert.deepEqual(releaseFlagProblems({ source, today: '2026-12-11' }), [])
  const problems = releaseFlagProblems({ source, today: '2026-12-12' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /mikka-new-checkout.*past its removeBy date 2026-12-11/)
})

test('a release flag needs an owner, a description, a real date and a gate key', () => {
  const problems = releaseFlagProblems({ today: '2026-11-27', source: registry(
    entry('mikka-a', { owner: '' })
    + entry('mikka-b', { description: ' ' })
    + entry('mikka-c', { removeBy: '2026-02-30' })
    + entry('mikka-d', { removeBy: 'soon' })
    + entry('mikka-e-off')
    + entry('Not A Key')
    + "\n  'mikka-f': { owner: someone, removeBy: '2026-12-01', description: 'x' },",
  ) })
  for (const expected of [
    /releaseFlags\[mikka-a\]: owner/, /releaseFlags\[mikka-b\]: description/,
    /releaseFlags\[mikka-c\]: removeBy/, /releaseFlags\[mikka-d\]: removeBy/,
    /releaseFlags\[mikka-e-off\]: .*gate/, /releaseFlags\[Not A Key\]: key/, /releaseFlags\[mikka-f\]: owner/,
  ]) assert.ok(problems.some(problem => expected.test(problem)), `${expected} in ${problems.join('\n')}`)
})

test('a missing registry fails', () => {
  assert.match(releaseFlagProblems({ source: 'export const gatedFeatures = {}' })[0], /releaseFlags.*missing/)
})

test('the registry is empty-safe: zero entries pass', () => {
  assert.deepEqual(releaseFlagProblems({ source: registry(''), today: '2099-01-01' }), [])
})

test('flag reads are found by literal, same-file constant and flags[...] index', () => {
  const source = `
    const NEW_FLAG = 'mikka-new-thing'
    postHogFlag('mikka-literal')
    await serverFlagEnabled(NEW_FLAG, userId)
    client.getFeatureFlag(\`mikka-template\`, { send_event: false })
    useFeatureFlagEnabled('mikka-hook')
    features.flags['mikka-indexed']
    serverFlagEnabled(killSwitches.emailSignIn, 'auth-pages')
    postHogFlag(key)
    other('mikka-ignored')
  `
  assert.deepEqual(flagKeyReads('lib/example.ts', source).map(read => read.key),
    ['mikka-literal', 'mikka-new-thing', 'mikka-template', 'mikka-hook', 'mikka-indexed'])
})

test('an undeclared flag key fails; a declared key, a registry export and a test file pass', () => {
  const declared = new Set(['mikka-memory'])
  const files = [
    { file: 'lib/new.ts', source: "export const on = () => postHogFlag('mikka-new-surface')" },
    { file: 'lib/declared.ts', source: "export const on = () => postHogFlag('mikka-memory')" },
    { file: 'lib/registry.ts', source: 'export const on = () => postHogFlag(gatedFeatures.memory.key)' },
    { file: 'lib/fixture.ts', source: "import test from 'node:test'\npostHogFlag('mikka-fixture')" },
  ]
  const problems = undeclaredFlagKeyProblems({ files, declared })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /^lib\/new\.ts:1: flag key mikka-new-surface is not declared/)
})

test('the registries declare the flags the app reads today', () => {
  const declared = declaredFlagKeys()
  for (const key of ['mikka-memory', 'mikka-computer-tab-off', 'mikka-personal-writes-off', 'mikka-linear-sync',
    'mikka-byos-subscription-chat', 'mikka-config-announcement-banner']) assert.ok(declared.has(key), key)
  assert.match(readFileSync('lib/feature-flags.ts', 'utf8'), /\.\.\.Object\.fromEntries\(Object\.keys\(releaseFlags\)\.map\(key => \[key, false\]\)\)/,
    'release flags default off when PostHog is absent')
})

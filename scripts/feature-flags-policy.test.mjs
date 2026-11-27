import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  declaredFlagKeys,
  flagKeyReads,
  flagPolicyFiles,
  isScannedSource,
  readRegistries,
  releaseFlagEntries,
  releaseFlagProblems,
  releaseFlagWarnings,
  undeclaredFlagKeyProblems,
  flagBypassProblems,
} from './feature-flags-policy.mjs'
import { releaseFlagRows } from './docs-generated.mjs'

const registry = body => `export interface ReleaseFlagDefinition { owner: string; description: string; added: string; fullAt?: string; removeBy: string }
export const releaseFlags = {${body}} as const satisfies Record<string, ReleaseFlagDefinition>
`
const entry = (key, { owner = 'release-owner', description = 'New checkout', added = '2026-11-27', fullAt, removeBy = '2026-12-20' } = {}) =>
  `\n  '${key}': { owner: '${owner}', description: '${description}', added: '${added}', ${fullAt ? `fullAt: '${fullAt}', ` : ''}removeBy: '${removeBy}' },`
const problemsFor = (options, today = '2026-11-27') => releaseFlagProblems({ source: registry(entry('mikka-new-checkout', options)), today })

test('the release-flag registry exists and every entry is within its dates', () => {
  assert.ok(Array.isArray(releaseFlagEntries()), 'lib/feature-flags.ts must export releaseFlags')
  assert.deepEqual(releaseFlagProblems(), [])
})

test('every flag key read in shipped code is declared in a flag registry', () => {
  assert.deepEqual(readRegistries().problems, [])
  assert.deepEqual(undeclaredFlagKeyProblems(), [])
})

test('a release flag past its removeBy date fails; on the date it passes with a warning', () => {
  const source = registry(entry('mikka-new-checkout', { removeBy: '2026-12-11' }))
  assert.deepEqual(releaseFlagProblems({ source, today: '2026-12-11' }), [])
  assert.match(releaseFlagWarnings({ source, today: '2026-12-11' })[0], /removeBy 2026-12-11 is 0 day\(s\) away/)
  const problems = releaseFlagProblems({ source, today: '2026-12-12' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /mikka-new-checkout.*past its removeBy date 2026-12-11/)
})

test('the warning starts 7 days before removeBy and never fails', () => {
  const source = registry(entry('mikka-new-checkout', { removeBy: '2026-12-11' }))
  assert.deepEqual(releaseFlagWarnings({ source, today: '2026-12-03' }), [])
  assert.equal(releaseFlagWarnings({ source, today: '2026-12-04' }).length, 1)
  assert.deepEqual(releaseFlagProblems({ source, today: '2026-12-04' }), [])
})

test('added is required, not in the future and not after removeBy', () => {
  assert.ok(problemsFor({ added: '' }).some(problem => /added must be a YYYY-MM-DD/.test(problem)))
  assert.deepEqual(problemsFor({ added: '2026-11-28' }), [], 'tomorrow in UTC is today for an author at UTC+8')
  assert.ok(problemsFor({ added: '2026-11-29' }).some(problem => /added 2026-11-29 is in the future \(UTC\)/.test(problem)))
  assert.ok(problemsFor({ added: '2026-11-20', removeBy: '2026-11-19' }, '2026-11-19').some(problem => /added 2026-11-20 is after removeBy 2026-11-19/.test(problem)))
})

test('removeBy is at most 60 days after added', () => {
  assert.deepEqual(problemsFor({ added: '2026-11-27', removeBy: '2027-01-26' }), [])
  assert.ok(problemsFor({ added: '2026-11-27', removeBy: '2027-01-27' }).some(problem => /more than 60 days after added/.test(problem)))
})

test('once fullAt is set, removeBy is at most 14 days after it', () => {
  assert.deepEqual(problemsFor({ added: '2026-11-01', fullAt: '2026-11-20', removeBy: '2026-12-04' }), [])
  assert.ok(problemsFor({ added: '2026-11-01', fullAt: '2026-11-20', removeBy: '2026-12-05' }).some(problem => /more than 14 days after fullAt 2026-11-20/.test(problem)))
  assert.ok(problemsFor({ added: '2026-11-01', fullAt: '2026-11-30', removeBy: '2026-12-05' }).some(problem => /fullAt 2026-11-30 is in the future/.test(problem)))
  assert.ok(problemsFor({ added: '2026-11-10', fullAt: '2026-11-09', removeBy: '2026-11-20' }).some(problem => /fullAt 2026-11-09 is before added/.test(problem)))
  assert.ok(problemsFor({ added: '2026-11-10', fullAt: '2026-11-31', removeBy: '2026-11-20' }).some(problem => /fullAt, once set/.test(problem)))
})

test('a release flag needs an owner, a description, real dates and a gate key', () => {
  const problems = releaseFlagProblems({ today: '2026-11-27', source: registry(
    entry('mikka-a', { owner: '' })
    + entry('mikka-b', { description: ' ' })
    + entry('mikka-c', { removeBy: '2026-02-30' })
    + entry('mikka-d', { removeBy: 'soon' })
    + entry('mikka-e-off')
    + entry('Not A Key')
    + "\n  'mikka-f': { owner: someone, description: 'x', added: '2026-11-27', removeBy: '2026-12-01' },",
  ) })
  for (const expected of [
    /releaseFlags\[mikka-a\]: owner/, /releaseFlags\[mikka-b\]: description/,
    /releaseFlags\[mikka-c\]: removeBy/, /releaseFlags\[mikka-d\]: removeBy/,
    /releaseFlags\[mikka-e-off\]: .*gate/, /releaseFlags\[Not A Key\]: key/, /releaseFlags\[mikka-f\]: owner/,
  ]) assert.ok(problems.some(problem => expected.test(problem)), `${expected} in ${problems.join('\n')}`)
})

test('a missing registry fails; zero entries pass', () => {
  assert.match(releaseFlagProblems({ source: 'export const gatedFeatures = {}' })[0], /releaseFlags.*missing/)
  assert.deepEqual(releaseFlagProblems({ source: registry(''), today: '2099-01-01' }), [])
})

test('declared means declared as a flag in a registry, not any mikka-* literal in its file', () => {
  const files = {
    'flags.ts': `export const DISTINCT_ID = 'mikka-deployment'
      export const switches = { a: { flag: 'mikka-a-off', note: 'mikka-not-a-flag' } } as const
      export const names = { 'mikka-b': { owner: 'x' } } as const
      export const values = { c: 'mikka-c' } as const
      export const ONE_FLAG = 'mikka-d'`,
  }
  const spec = { 'flags.ts': { switches: 'flag', names: 'names', values: 'values', ONE_FLAG: 'value' } }
  const { keys, problems } = readRegistries(path => files[path], spec)
  assert.deepEqual([...keys].sort(), ['mikka-a-off', 'mikka-b', 'mikka-c', 'mikka-d'])
  assert.deepEqual(problems, [])
  assert.match(readRegistries(path => files[path], { 'flags.ts': { renamed: 'flag' } }).problems[0], /flag registry renamed is missing/)
  const real = declaredFlagKeys()
  for (const key of ['mikka-memory', 'mikka-computer-tab-off', 'mikka-personal-writes-off', 'mikka-linear-sync',
    'mikka-byos-subscription-chat', 'mikka-config-announcement-banner', 'mikka-proactive-profile']) assert.ok(real.has(key), key)
  for (const key of ['mikka-deployment', 'mikka-linear-sync-service']) assert.equal(real.has(key), false, `${key} is a distinct id, not a flag`)
})

test('flag reads are found by literal, same-file constant and flags[...] index', () => {
  const source = `
    const NEW_FLAG = 'mikka-new-thing'
    postHogFlag('mikka-literal')
    await serverFlagEnabled(NEW_FLAG, userId)
    client.getFeatureFlag(\`mikka-template\`, { send_event: false })
    useFeatureFlagEnabled('mikka-hook')
    productionFlagDefault('mikka-default')
    features.flags['mikka-indexed']
    flags['fail-fast']
    serverFlagEnabled(killSwitches.emailSignIn, 'auth-pages')
    postHogFlag(key)
    other('mikka-ignored')
  `
  assert.deepEqual(flagKeyReads('lib/example.ts', source).map(read => read.key),
    ['mikka-literal', 'mikka-new-thing', 'mikka-template', 'mikka-hook', 'mikka-default', 'mikka-indexed'])
})

test('an undeclared flag key fails; a declared key and a registry export pass', () => {
  const declared = new Set(['mikka-memory'])
  const files = [
    { file: 'lib/new.ts', source: "export const on = () => postHogFlag('mikka-new-surface')" },
    { file: 'lib/declared.ts', source: "export const on = () => postHogFlag('mikka-memory')" },
    { file: 'lib/registry.ts', source: 'export const on = () => postHogFlag(gatedFeatures.memory.key)' },
  ]
  const problems = undeclaredFlagKeyProblems({ files, declared })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /^lib\/new\.ts:1: flag key mikka-new-surface is not declared/)
})

test('tests are skipped by path or name, not by what they import', () => {
  for (const file of ['.agents/acceptance/a.mjs', 'lib/a.test.ts', 'lib/a.spec.tsx', 'packages/x/test/a.node-test.ts', 'tests/a.ts', 'e2e/a.mjs', 'lib/__tests__/a.ts', 'lib/a.d.ts'])
    assert.equal(isScannedSource(file), false, file)
  for (const file of ['lib/a.ts', 'web/hooks/use-flags.tsx', 'scripts/acceptance/probe.mjs'])
    assert.equal(isScannedSource(file), true, file)
})

test('the overlay walk skips git-ignored build output and labels files with the real checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-flags-root-'))
  try {
    const overlay = join(root, 'ui-checkout')
    for (const dir of ['web', 'dist-app', 'dist-design-system', 'generated']) mkdirSync(join(overlay, dir), { recursive: true })
    writeFileSync(join(overlay, '.gitignore'), 'generated/\n')
    for (const dir of ['web', 'dist-app', 'dist-design-system', 'generated']) writeFileSync(join(overlay, dir, 'a.ts'), "postHogFlag('mikka-x')\n")
    execFileSync('git', ['init', '-q'], { cwd: overlay })
    const files = flagPolicyFiles(root, { own: false, env: { MIKKA_UI_OVERLAY_DIR: 'ui-checkout' } }).map(({ file }) => file)
    assert.deepEqual(files, ['ui-checkout/web/a.ts'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generated release-flag rows escape table separators', () => {
  const [row] = releaseFlagRows([{ key: 'mikka-a', owner: 'o|p', added: '2026-11-27', removeBy: '2026-12-20', description: 'pay | bill\nnext' }])
  assert.equal(row, '| `mikka-a` | o\\|p | 2026-11-27 | — | 2026-12-20 | pay \\| bill next |')
  assert.equal(row.split(/(?<!\\)\|/).length - 2, 6)
})

test('release flags default off without PostHog', () => {
  assert.match(readFileSync('lib/feature-flags.ts', 'utf8'), /\.\.\.Object\.fromEntries\(Object\.keys\(releaseFlags\)\.map\(key => \[key, false\]\)\)/)
})

test('releaseFlagEnabled holds the strict-true rule and refuses undeclared keys', async () => {
  const { releaseFlagEnabled } = await import('../lib/feature-flags.ts')
  for (const value of [true, false, undefined, 'true', 'variant']) assert.equal(releaseFlagEnabled('mikka-not-declared', value), false, String(value))
})

test('SDK flag reads outside their wrappers and `as FlagKey` casts fail', () => {
  const files = [
    { file: 'lib/analytics/posthog.ts', source: "export const postHogFlag = (key: FlagKey) => client?.getFeatureFlag(key)" },
    { file: 'lib/posthog-server.ts', source: 'await posthog.getFeatureFlag(key, userId)' },
    { file: 'lib/sneaky.ts', source: "export const on = () => posthog.isFeatureEnabled(someString)" },
    { file: 'lib/all.ts', source: 'export const all = () => posthog.getAllFlags()' },
    { file: 'lib/listen.ts', source: 'posthog.onFeatureFlags(flags => console.log(flags))' },
    { file: '.hosted-ui/web/hooks/sdk.tsx', source: "export const useX = () => useFeatureFlagEnabled('mikka-memory')" },
    { file: 'lib/cast.ts', source: "export const on = () => postHogFlag(value as FlagKey)" },
    { file: 'lib/reload.ts', source: 'posthog.reloadFeatureFlags()' },
  ]
  const problems = flagBypassProblems({ files })
  assert.deepEqual(problems.map(problem => problem.split(':').slice(0, 2).join(':')),
    ['lib/sneaky.ts:1', 'lib/all.ts:1', 'lib/listen.ts:1', '.hosted-ui/web/hooks/sdk.tsx:1', 'lib/cast.ts:1'])
  assert.match(problems.at(-1), /as FlagKey/)
  assert.deepEqual(flagBypassProblems(), [], 'shipped code has no bypass')
})

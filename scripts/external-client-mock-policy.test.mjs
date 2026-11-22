import assert from 'node:assert/strict'
import { test } from 'node:test'
import { auditExternalClientMocks, externalClientMocks } from './external-client-mock-policy.mjs'

test('provider mocks fail across package, alias, relative and URL module names', () => {
  for (const code of [
    `mock.module('e2b', {})`,
    `t.mock.module('@/lib/computer/e2b-provider', {})`,
    `mock.module('../lib/slack/automation-notice.ts', {})`,
    `mock.module(new URL('../lib/github/user-access.ts', import.meta.url).href, {})`,
    `renamedMock.module('@slack/web-api', {})`,
  ]) {
    const found = externalClientMocks('tests/provider.test.ts', code)
    assert.equal(found.length, 1)
    assert.equal(auditExternalClientMocks(found, {}).length, 1)
  }
  assert.deepEqual(externalClientMocks('tests/provider.test.ts', `import { Sandbox } from 'e2b'; mock.module('../lib/db/index.ts', {})`), [])
})

test('the exact existing file/module count is allowed, while added mocks and baseline expansion fail', () => {
  const found = externalClientMocks('tests/provider.test.ts', `mock.module('e2b', {})`)
  const baseline = { 'tests/provider.test.ts:e2b': 1 }
  assert.deepEqual(auditExternalClientMocks(found, baseline), [])
  assert.equal(auditExternalClientMocks([...found, ...found], baseline).length, 1)
  assert.equal(auditExternalClientMocks(found, { ...baseline, 'tests/another.test.ts:e2b': 1 }, baseline).length, 1)
  assert.deepEqual(auditExternalClientMocks([], {}, baseline), [])
})

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trustedPolicyBase } from './external-client-mock-policy.mjs'

test('the merge-queue checkout resolves the base side, never the candidate itself', t => {
  const dir = mkdtempSync(join(tmpdir(), 'mock-policy-base-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'policy@test.local')
  git('config', 'user.name', 'Policy Test')
  writeFileSync(join(dir, 'base.txt'), 'main')
  git('add', '.')
  git('commit', '-qm', 'base')
  const mainHead = git('rev-parse', 'HEAD')
  git('checkout', '-qb', 'pr')
  writeFileSync(join(dir, 'base.txt'), 'pr')
  git('commit', '-qam', 'pr change')
  git('checkout', '-q', 'main')
  git('merge', '--no-ff', '-qm', 'queue candidate', 'pr')
  // actions/checkout leaves FETCH_HEAD pointing at the ref it fetched: the candidate.
  writeFileSync(join(dir, '.git', 'FETCH_HEAD'), `${git('rev-parse', 'HEAD')}\t\t\n`)
  // With no origin/main and no event payload, the merge commit's first parent
  // (the base side) is the trusted base; the candidate itself must be rejected.
  assert.equal(trustedPolicyBase(dir), mainHead)
  // On a plain head the same self-pointing FETCH_HEAD must yield no trusted
  // base: nothing exists to compare against and fetch has no origin to try.
  git('checkout', '-q', 'pr')
  writeFileSync(join(dir, '.git', 'FETCH_HEAD'), `${git('rev-parse', 'HEAD')}\t\t\n`)
  assert.equal(trustedPolicyBase(dir), '')
})

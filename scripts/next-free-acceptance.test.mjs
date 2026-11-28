import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'

/**
 * Mikka's web build is Vite (apps/frontend), served under /mikka/assets/, and
 * the browser calls server actions through POST /mikka/api/rpc
 * (lib/browser-rpc/handler.ts). Nothing of Mikka's own is served under
 * /_next/ any more, so a script that reads or requests such a path checks
 * nothing against a real deployment and passes or fails for the wrong reason.
 *
 * This file names the retired path on purpose, so it excludes itself.
 */
const root = resolve(import.meta.dirname, '..')
const SELF = 'scripts/next-free-acceptance.test.mjs'

/** The same source directories as scripts/next-free.test.mjs. Docs may still mention history. */
const SOURCE = ['app', 'lib', 'components', 'hooks', 'apps', 'tests', 'scripts', 'i18n', 'types', 'packages']

/** These open the hot-reload socket of a user's own Next.js dev server inside a
 * sandbox preview: a third-party framework the product supports, not Mikka's build. */
const THIRD_PARTY_HMR = new Set([
  'scripts/acceptance/task-review-preview.mjs',
  'scripts/e2b/workspace-ingress-acceptance.mjs',
  'scripts/e2b/preview-frameworks.test.py',
])

function grep(pattern) {
  try {
    const out = execFileSync('git', ['grep', '-nE', pattern, '--', ...SOURCE, `:!${SELF}`], { cwd: root, encoding: 'utf8' })
    return out.split('\n').filter(Boolean)
  } catch (error) {
    // git grep exits 1 with no matches, which is the passing case.
    if (error.status === 1) return []
    throw error
  }
}

test("no source or script reads a /_next/ path from Mikka's own build", () => {
  const hits = grep('/_next/')
  const own = hits.filter(hit => !THIRD_PARTY_HMR.has(hit.slice(0, hit.indexOf(':'))))
  assert.deepEqual(own, [], 'read assets under /mikka/assets/ and call actions through /mikka/api/rpc')
})

test('the sandbox preview exceptions reach only the third-party hot-reload socket', () => {
  const hits = grep('/_next/').filter(hit => THIRD_PARTY_HMR.has(hit.slice(0, hit.indexOf(':'))))
  for (const hit of hits) assert.match(hit, /\/_next\/hmr\?id=/, hit)
})

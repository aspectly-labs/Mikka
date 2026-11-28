import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { LEGACY_PUBLIC_ENV } from '../lib/public-env.mjs'

/**
 * Phase 1 of the public configuration rename (docs/operations/public-env-rename.md)
 * keeps the retired framework's NEXT_PUBLIC_* names only where production
 * configuration still needs them. This test keeps every other reader on the new
 * names, so phase 2 can delete the legacy table without a hidden reader left.
 *
 * Allowed: the legacy table, workflow fallbacks to an old secret or variable
 * (`NEW: ${{ secrets.NEW || secrets.NEXT_PUBLIC_OLD }}`) and Infisical keys a
 * workflow still reads by their old name, docs, tests, and .claude/ (third-party
 * skill docs). A name in prose written as NEXT_PUBLIC_* is not a variable.
 */
const root = resolve(import.meta.dirname, '..')
const SELF = 'scripts/next-free-env.test.mjs'
const TABLE = 'lib/public-env.mjs'
const CHECKLIST = 'docs/operations/public-env-rename.md'
const LEGACY = new Set(Object.values(LEGACY_PUBLIC_ENV))

function grep(pattern, paths) {
  try {
    const out = execFileSync('git', ['grep', '-nE', pattern, '--', ...paths], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return out.split('\n').filter(Boolean)
  } catch (error) {
    // git grep exits 1 with no matches, which is the passing case.
    if (error.status === 1) return []
    throw error
  }
}

const hits = grep('NEXT_PUBLIC_([^*]|$)', ['.', ':!.claude', ':!docs', ':!*.md', ':!*.test.*', ':!*.spec.*', ':!tests',
  `:!${TABLE}`, `:!${SELF}`])

/** `NEW: ${{ secrets.NEW || secrets.NEXT_PUBLIC_OLD }}`, where the table maps NEW to NEXT_PUBLIC_OLD. */
function workflowFallback(text) {
  const match = /^\s*([A-Z][A-Z0-9_]*):\s*\$\{\{\s*(secrets|vars)\.([A-Z][A-Z0-9_]*)\s*\|\|\s*(secrets|vars)\.(NEXT_PUBLIC_[A-Z0-9_]+)\s*\}\}\s*$/.exec(text)
  return Boolean(match && match[1] === match[3] && LEGACY_PUBLIC_ENV[match[3]] === match[5])
}

/** An Infisical read of a key that keeps its old name until phase 2; code reads it through the fallback. */
function infisicalLegacyKey(text) {
  const match = /^\s*secret-name:\s*(NEXT_PUBLIC_[A-Z0-9_]+)\s*$/.exec(text)
  return Boolean(match && LEGACY.has(match[1]))
}

test('only the legacy table names a NEXT_PUBLIC_* variable in code, scripts and configuration', () => {
  const unexpected = hits.filter(hit => {
    const [, path, text] = /^([^:]+):\d+:(.*)$/.exec(hit)
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return !workflowFallback(text) && !infisicalLegacyKey(text)
    return true
  })
  assert.deepEqual(unexpected, [], 'read the new name through lib/public-env.mjs instead')
})

test('the legacy table is marked for removal in phase 2', async () => {
  const table = await readFile(join(root, TABLE), 'utf8')
  assert.match(table, /legacy NEXT_PUBLIC_\* names, read only until production config is renamed; remove in phase 2/)
  assert.ok(LEGACY.size > 0)
})

test('the phase 2 checklist names every legacy key the workflows still read', async () => {
  const checklist = await readFile(join(root, CHECKLIST), 'utf8')
  for (const [name, legacy] of Object.entries(LEGACY_PUBLIC_ENV)) {
    assert.ok(checklist.includes(name), `${CHECKLIST} must name ${name}`)
    assert.ok(checklist.includes(legacy), `${CHECKLIST} must name ${legacy}`)
  }
  const workflowKeys = hits.filter(hit => hit.startsWith('.github/workflows/'))
    .map(hit => /(NEXT_PUBLIC_[A-Z0-9_]+)/.exec(hit)[1])
  for (const key of workflowKeys) assert.ok(checklist.includes(key), `${CHECKLIST} must say how to retire ${key}`)
})

test('the guard recognizes only exact fallbacks', () => {
  const [name, legacy] = Object.entries(LEGACY_PUBLIC_ENV)[0]
  assert.equal(workflowFallback(`          ${name}: \${{ secrets.${name} || secrets.${legacy} }}`), true)
  assert.equal(workflowFallback(`          ${name}: \${{ vars.${name} || vars.${legacy} }}`), true)
  assert.equal(workflowFallback(`          ${legacy}: \${{ secrets.${legacy} }}`), false)
  assert.equal(workflowFallback(`          OTHER: \${{ secrets.OTHER || secrets.${legacy} }}`), false)
  assert.equal(infisicalLegacyKey(`          secret-name: ${legacy}`), true)
  assert.equal(infisicalLegacyKey('          secret-name: NEXT_PUBLIC_UNLISTED'), false)
})

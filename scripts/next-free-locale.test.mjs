import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'

/**
 * The locale cookie is `mikka-locale`. Its pre-rename name stays in exactly one
 * constant, `LEGACY_LOCALE_COOKIE` in i18n/locale-cookie.mjs, which retires in
 * release phases: expand (read both, write both), stop writing, stop reading
 * (mikka-hosted-ui/docs/design/decisions/2026-11-18-1500-retire-next-dependency.md). This test
 * keeps the name in that one module: a reader or writer of the old name
 * elsewhere would otherwise pass CI silently and outlive the migration, and
 * each phase would have to find every use again.
 *
 * Tests may name the old cookie, because they exercise the migration. This
 * file names it too, so it excludes itself.
 */
const root = resolve(import.meta.dirname, '..')
const SELF = 'scripts/next-free-locale.test.mjs'
const CONSTANT_FILE = 'i18n/locale-cookie.mjs'
const LEGACY = 'NEXT_LOCALE'

/** Docs may tell the history; tests drive the migration. */
const NOT_SOURCE = [':!*.md', ':!**/*.md', ':!**/*.test.*', ':!**/test/**', ':!tests/**', ':!.claude/**']

function grep(pattern, extra = []) {
  try {
    const out = execFileSync('git', ['grep', '-nE', pattern, '--', '.', ...NOT_SOURCE, `:!${SELF}`, ...extra], { cwd: root, encoding: 'utf8' })
    return out.split('\n').filter(Boolean)
  } catch (error) {
    // git grep exits 1 with no matches, which is the passing case.
    if (error.status === 1) return []
    throw error
  }
}

test(`no source file outside ${CONSTANT_FILE} names the legacy locale cookie`, () => {
  assert.deepEqual(grep(LEGACY, [`:!${CONSTANT_FILE}`]), [],
    'read with storedLocale and write with localeCookies from i18n/locale-cookie.mjs instead')
})

test('the legacy name is one named constant whose comment names the retirement phases', async () => {
  const source = await readFile(join(root, CONSTANT_FILE), 'utf8')
  assert.equal(source.split(LEGACY).length - 1, 1, `${CONSTANT_FILE} names the legacy cookie exactly once`)
  assert.match(source, new RegExp(`^export const LEGACY_LOCALE_COOKIE = '${LEGACY}'$`, 'm'))
  assert.match(source, /^export const LOCALE_COOKIE = 'mikka-locale'$/m)
  // No calendar date: self-hosted servers upgrade late and keep writing the old
  // name, so retirement follows releases, and the comment must say which.
  assert.match(source, /Phase 1 \(expand[^]*every writer writes both names/)
  assert.match(source, /Phase 2 \(stop writing\)[^]*rollback window/)
  assert.match(source, /Phase 3 \(stop reading\)[^]*oldest supported self-hosted release[^]*one cookie lifetime/)
})

test('only the locale-cookie module uses the legacy constant; readers and writers call its helpers', () => {
  const users = new Set(grep('\\bLEGACY_LOCALE_COOKIE\\b').map(hit => hit.slice(0, hit.indexOf(':'))))
  assert.deepEqual([...users], [CONSTANT_FILE])
})

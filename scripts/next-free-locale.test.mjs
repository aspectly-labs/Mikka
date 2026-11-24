import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'

/**
 * The locale cookie is `mikka-locale`. Its pre-rename name stays in exactly one
 * constant, `LEGACY_LOCALE_COOKIE` in i18n/locale-cookie.mjs, which is read only
 * to migrate people who chose a language before the rename
 * (docs/design/decisions/2026-11-18-1500-retire-next-dependency.md). This test
 * keeps it that way: a new reader or writer of the old name elsewhere would
 * otherwise pass CI silently and outlive the migration.
 *
 * Tests may name the old cookie, because they exercise the migration. This
 * file names it too, so it excludes itself.
 */
const root = resolve(import.meta.dirname, '..')
const SELF = 'scripts/next-free-locale.test.mjs'
const CONSTANT_FILE = 'i18n/locale-cookie.mjs'
const LEGACY = 'NEXT_LOCALE'
/** One cookie lifetime (Max-Age one year) after the rename on 2026-11-24. */
const EARLIEST_REMOVAL = '2027-11-24'

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
    'import LEGACY_LOCALE_COOKIE from i18n/locale-cookie.mjs, or use LOCALE_COOKIE to read or write the choice')
})

test('the legacy name is one named constant with a removal date at least one cookie lifetime away', async () => {
  const source = await readFile(join(root, CONSTANT_FILE), 'utf8')
  assert.equal(source.split(LEGACY).length - 1, 1, `${CONSTANT_FILE} names the legacy cookie exactly once`)
  assert.match(source, new RegExp(`^export const LEGACY_LOCALE_COOKIE = '${LEGACY}'$`, 'm'))
  assert.match(source, /^export const LOCALE_COOKIE = 'mikka-locale'$/m)
  const removal = /on or after (\d{4}-\d\d-\d\d)/.exec(source)?.[1]
  assert.ok(removal, 'the constant says on or after which date it can be deleted')
  assert.ok(removal >= EARLIEST_REMOVAL, `${removal} is earlier than ${EARLIEST_REMOVAL}`)
  // The only Set-Cookie the module builds for the old name expires it.
  for (const match of source.matchAll(/\$\{LEGACY_LOCALE_COOKIE\}=([^`]*)`/g)) assert.match(match[1], /^; Max-Age=0;/)
})

test('only the locale readers use the legacy constant, so deleting it is a small change', () => {
  const users = new Set(grep('\\bLEGACY_LOCALE_COOKIE\\b').map(hit => hit.slice(0, hit.indexOf(':'))))
  assert.deepEqual([...users].sort(), [CONSTANT_FILE, 'apps/api/runtime/http-policy.mjs'].sort())
})

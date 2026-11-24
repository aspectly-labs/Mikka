// R-42: every visible string lives in messages/. The mobile app was written before
// the check covered it, so this file freezes how many hardcoded Chinese strings each
// file still holds. The list only shrinks: migrate a string, lower its number; a file
// at 0 leaves the list. A new file, or one more string in a frozen file, fails the
// check — a whole-file freeze would let new strings in unnoticed.
//
// Regenerate only after migrating (never to admit new strings): run
// `node scripts/check-i18n.mjs`; it names each frozen file whose count no longer matches
// the tree, and each migrated file to drop.
const BASELINE = {}

/** How many hardcoded strings each frozen file is allowed to keep, by repository-relative path. */
export function frozenMobileFiles() {
  return new Map(Object.entries(BASELINE))
}

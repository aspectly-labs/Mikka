import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

// Every badge in the app is drawn on one ladder (`components/ui/badge-size.ts`).
// Two modules with their own heights and type sizes is what put a row of chips
// on two baselines (2026-11-19): `components/ui/badge` drew 20px at 12px type
// while `components/reui/badge` drew 16/18/20/22/24px at 9.6/11/12/12/13px.
// This holds the ladder in one place and refuses a second one.
const ladder = readFileSync('components/ui/badge-size.ts', 'utf8')
const uiBadge = readFileSync('components/ui/badge.tsx', 'utf8')
const reuiBadgePath = existsSync('components/reui/badge.tsx')
  ? 'components/reui/badge.tsx'
  : existsSync('.hosted-ui/web/components/reui/badge.tsx')
    ? '.hosted-ui/web/components/reui/badge.tsx'
    : null
const reuiBadge = reuiBadgePath ? readFileSync(reuiBadgePath, 'utf8') : null
const theme = readFileSync('app/globals.css', 'utf8')

/** The rungs a badge may stand on, as `role: "classes"` entries. */
const rungs = [...ladder.matchAll(/^\s{2}(\w+): "([^"]+)",$/gm)].map(([, name, classes]) => ({ name, classes }))

test('the badge ladder names every rung it defines', () => {
  assert.deepEqual(rungs.map(rung => rung.name), ['xs', 'sm', 'md', 'lg', 'xl'])
  for (const rung of rungs) {
    assert.match(rung.classes, /\bh-\S+/, `${rung.name} needs a height`)
    assert.match(rung.classes, /\btext-(?:3xs|2xs|xs|sm|md|lg|xl)\b/, `${rung.name} reads a type role, never an arbitrary size`)
    assert.doesNotMatch(rung.classes, /text-\[/, `${rung.name} spells no type size of its own`)
    assert.doesNotMatch(rung.classes, /\bh-\[/, `${rung.name} spells no height of its own`)
  }
})

test('both badge modules stand on the ladder and keep no size map of their own', () => {
  const targets = [['ui/badge', uiBadge]]
  if (reuiBadge !== null) targets.push(['reui/badge', reuiBadge])
  for (const [name, source] of targets) {
    assert.match(source, /BADGE_SIZE/, `${name} must import the shared ladder`)
    // A height or an arbitrary type size in either module is a second ladder.
    assert.doesNotMatch(source, /\bh-(?:[0-9]|px|\[)/, `${name} must not draw its own height`)
    assert.doesNotMatch(source, /text-\[/, `${name} must not spell an arbitrary type size`)
  }
})

test('the type roles the ladder reads exist in the theme', () => {
  for (const role of ['--text-3xs', '--text-2xs']) {
    assert.ok(theme.includes(`${role}:`), `${role} must be declared in app/globals.css`)
  }
})

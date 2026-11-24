import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mock, test } from 'node:test'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('react-native-svg', {
  namedExports: {
    Svg: ({ accessible, ...props }: { accessible?: boolean; children?: ReactNode }) => createElement('svg', { ...props, 'aria-hidden': !accessible }),
    Path: 'path',
  },
})
mock.module(new URL('../lib/theme.ts', import.meta.url).href, { namedExports: { colors: { text: 'currentColor' } } })
const { MikkaMark, MIKKA_MARK_PATH } = await import('../components/MikkaMark.tsx')
const canonical = readFileSync(new URL('../../../app/icon.svg', import.meta.url), 'utf8')

test('the native sign-in mark matches the canonical geometric ribbon M without legacy dot-grid circles', () => {
  const svg = renderToStaticMarkup(createElement(MikkaMark))
  const canonicalPath = canonical.match(/<path\b[^>]*\bd="([^"]+)"/)?.[1] ?? ''
  const renderedPath = svg.match(/<path\b[^>]*\bd="([^"]+)"/)?.[1] ?? ''
  assert.equal(canonicalPath, 'M3 6H9V12L3 18V6ZM9 12L15 6H21V18L15 12L9 18V12Z')
  assert.equal(renderedPath, canonicalPath)
  assert.equal(MIKKA_MARK_PATH, canonicalPath)
  assert.doesNotMatch(svg, /<circle\b/)
  assert.doesNotMatch(canonical, /<circle\b/)
  assert.match(svg, /width="56" height="56" viewBox="0 0 24 24" fill="none"/)
  assert.match(svg, /fill="currentColor"/)
})

test('native sign-in identifies Mikka with the brand mark', () => {
  const signIn = readFileSync(new URL('../components/SignIn.tsx', import.meta.url), 'utf8')
  assert.match(signIn, /<MikkaMark \/>/)
  assert.doesNotMatch(signIn, /BotAvatar/)
})

test('brand SVGs and shared Apple Icon Composer bundles use the geometric ribbon M with zero legacy dot-grid layers', () => {
  const repoRoot = new URL('../../../', import.meta.url)
  const masterPath = 'M197 320H407V530L197 740V320ZM407 530L617 320H827V740L617 530L407 740V530Z'
  for (const rel of ['public/brand/mikka-icon-light.svg', 'public/brand/mikka-icon-dark.svg', 'apps/mobile/assets/icon.icon/Assets/mark.svg', 'apps/desktop/build/icon.icon/Assets/mark.svg']) {
    const svg = readFileSync(new URL(rel, repoRoot), 'utf8')
    assert.ok(svg.includes(`d="${masterPath}"`), `${rel} must contain the exact Figma 1:127 path`)
    assert.doesNotMatch(svg, /<circle\b/, `${rel} must not contain legacy dot-grid circles`)
  }
  for (const base of ['apps/mobile/assets/icon.icon', 'apps/desktop/build/icon.icon']) {
    assert.equal(existsSync(new URL(`${base}/Assets/on.svg`, repoRoot)), false, `${base}/Assets/on.svg must be deleted`)
    assert.equal(existsSync(new URL(`${base}/Assets/off.svg`, repoRoot)), false, `${base}/Assets/off.svg must be deleted`)
  }
  assert.equal(
    readFileSync(new URL('apps/mobile/assets/icon.icon/icon.json', repoRoot), 'utf8'),
    readFileSync(new URL('apps/desktop/build/icon.icon/icon.json', repoRoot), 'utf8'),
  )
  assert.equal(
    readFileSync(new URL('apps/mobile/assets/icon.icon/Assets/mark.svg', repoRoot), 'utf8'),
    readFileSync(new URL('apps/desktop/build/icon.icon/Assets/mark.svg', repoRoot), 'utf8'),
  )
})

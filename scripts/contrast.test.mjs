// R-104's quiet text level has to be legible where it actually sits. The token
// was once picked against the page alone and came out at 4.498:1 in dark, then
// failed outright at 3.97:1 on a `bg-muted/80` chip — a hand-computed value is
// not a check, so the numbers are computed here from the tokens themselves.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { needsOfficialUi, officialCore, readUi } from './official-ui-tree.mjs'

// The tokens live in the official UI checkout's core/app/globals.css; without it there is nothing to compute. Their
// values name Mikka's colour primitives (`var(--mk-gray-l540)`), which the checkout's styles/tokens.css spells: a
// value is resolved through the same block, then tokens.css (the theme's block, then its theme-invariant :root).
const css = needsOfficialUi ? '' : readUi('app/globals.css')
const tokensCss = needsOfficialUi ? '' : readFileSync(join(officialCore, '..', 'styles/tokens.css'), 'utf8')

/** Every top-level `selector { … }` block of a stylesheet with that exact selector, merged in order. */
function declarationsOf(text, selector) {
  const out = {}
  for (const match of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/^([^\s{}][^{}\n]*?)\s*\{([^{}]*)\}/gm)) {
    if (match[1].trim() !== selector) continue
    for (const [, name, value] of match[2].matchAll(/--([\w-]+):\s*([^;]+);/g)) out[name] = value.trim()
  }
  return out
}
const tokenBlocks = {
  ':root': [
    declarationsOf(tokensCss, ':root:not(.dark)'),
    declarationsOf(tokensCss, ':root, .dark'),
    declarationsOf(tokensCss, ':root'),
  ],
  '.dark': [
    declarationsOf(tokensCss, ':root.dark, .dark'),
    declarationsOf(tokensCss, ':root.dark'),
    declarationsOf(tokensCss, ':root, .dark'),
    declarationsOf(tokensCss, ':root'),
  ],
}
/** A token's value with every `var(--name)` it consists of replaced by the name's value, as far as it resolves. */
function resolved(value, own, selector, depth = 0) {
  const match = /^var\(--([\w-]+)\)$/.exec(value.trim())
  if (!match || depth > 8) return value.trim()
  const next = own[match[1]] ?? tokenBlocks[selector].map(block => block[match[1]]).find(v => v != null)
  assert.ok(next != null, `${value} is not defined in core/app/globals.css or styles/tokens.css`)
  return resolved(next, own, selector, depth + 1)
}

/** The declarations of one theme (`:root` or `.dark`), merged across `globals.css` and `tokens.css`. */
function block(selector) {
  const own = selector === ':root'
    ? { ...declarationsOf(tokensCss, ':root'), ...declarationsOf(tokensCss, ':root, .dark'), ...declarationsOf(tokensCss, ':root:not(.dark)'), ...declarationsOf(css, ':root, .dark'), ...declarationsOf(css, ':root') }
    : { ...declarationsOf(tokensCss, ':root'), ...declarationsOf(tokensCss, ':root, .dark'), ...declarationsOf(tokensCss, ':root.dark'), ...declarationsOf(tokensCss, ':root.dark, .dark'), ...declarationsOf(css, ':root, .dark'), ...declarationsOf(css, '.dark') }
  assert.ok(Object.keys(own).length > 0, `${selector} block not found`)
  return Object.fromEntries(Object.entries(own).map(([name, value]) => [name, resolved(value, own, selector)]))
}

const linear = channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
const srgb = channel => channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055
const luminance = channels => {
  const [r, g, b] = channels.map(linear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** A colour token as { y: linear luminance, channels: sRGB 0…1 triple, alpha: 0…1 }. */
function colour(value) {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map(d => d + d).join('') : hex[1]
    value = `rgb(${[0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16)).join(' ')})`
  }
  const oklch = value.match(/^oklch\(\s*([\d.]+)\s+0\s+(?:0|none)\s*\)$/)
  if (oklch) {
    // An achromatic oklch colour has Y = L³; its channels are that grey encoded.
    const y = Number(oklch[1]) ** 3
    return { y, channels: [srgb(y), srgb(y), srgb(y)], alpha: 1 }
  }
  const rgb = value.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/)
  if (rgb) {
    const channels = rgb.slice(1, 4).map(channel => Number(channel) / 255)
    const rawAlpha = rgb[4]
    const alpha = rawAlpha == null ? 1 : rawAlpha.endsWith('%') ? Number(rawAlpha.slice(0, -1)) / 100 : Number(rawAlpha)
    return { y: luminance(channels), channels, alpha }
  }
  assert.fail(`unparsed colour: ${value}`)
}

/** Composite `fg` over opaque `bg` in sRGB, returning { y, channels, alpha: 1 }. */
function composite(fg, bg, alphaScale = 1) {
  const alpha = fg.alpha * alphaScale
  if (alpha >= 1) return { y: fg.y, channels: fg.channels, alpha: 1 }
  const channels = fg.channels.map((channel, index) => alpha * channel + (1 - alpha) * bg.channels[index])
  return { y: luminance(channels), channels, alpha: 1 }
}

const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

for (const selector of [':root', '.dark']) {
  test(`text-tertiary clears 4.5:1 on the page, a card and a muted fill (${selector})`, { skip: needsOfficialUi }, () => {
    const tokens = block(selector)
    const tertiary = colour(tokens.tertiary)
    const page = colour(tokens.background)
    const card = colour(tokens.card)
    const muted = colour(tokens.muted)
    const mutedOnPage = composite(muted, page)
    const muted80OnPage = composite(muted, page, 0.8)
    const muted80OnCard = composite(muted, card, 0.8)
    // `bg-muted` whole, and `bg-muted/80` as the activity rows write it: the fill at 80% over what is behind.
    const surfaces = {
      page,
      card,
      'muted fill': mutedOnPage,
      'muted/80 on page': muted80OnPage,
      'muted/80 on card': muted80OnCard,
    }
    for (const [name, surface] of Object.entries(surfaces)) {
      const measured = ratio(composite(tertiary, surface).y, surface.y)
      // Three decimals: at two, a failing 4.498 reads as "4.50 needs 4.5".
      assert.ok(measured >= 4.5, `${selector} --tertiary on ${name} is ${measured.toFixed(3)}:1, needs 4.5:1`)
    }
  })

  test(`text-tertiary stays a step quieter than foreground while placeholder stays quieter than muted-foreground (${selector})`, { skip: needsOfficialUi }, () => {
    const tokens = block(selector)
    const page = colour(tokens.background)
    const fgY = composite(colour(tokens.foreground), page).y
    const mutedFgY = composite(colour(tokens['muted-foreground']), page).y
    const tertiaryY = composite(colour(tokens.tertiary), page).y
    const placeholderY = composite(colour(tokens['mk-text-tertiary']), page).y
    assert.ok(ratio(fgY, tertiaryY) >= 1.5,
      `${selector}: --tertiary is not visibly quieter than --foreground`)
    assert.ok(ratio(mutedFgY, placeholderY) >= 1.15,
      `${selector}: --mk-text-tertiary is not visibly quieter than --muted-foreground`)
  })
}

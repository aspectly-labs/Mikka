import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { ConversationUsage } from '@/lib/coordinator/context-usage'

// The real Chinese copy, so the test reads what the person sees.
const zh = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown>>
mock.module('@/lib/intl/i18n-client', { namedExports: { useLocale: () => 'en', useTranslations: (namespace: string) => (key: string, values: Record<string, unknown> = {}) => {
  const text = key.split('.').reduce<unknown>((value, name) => (value as Record<string, unknown>)?.[name], zh[namespace])
  if (typeof text !== 'string') throw new Error(`missing copy: ${namespace}.${key}`)
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]))
} } })

const page = new Window({ url: 'https://example.invalid/mikka' })
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let CoordinatorContextUsage: typeof import('./coordinator-context-usage')['CoordinatorContextUsage']

before(async () => {
  Object.assign(globalThis, { window: page, document: page.document, IS_REACT_ACT_ENVIRONMENT: true })
  for (const key of ['navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: page[key] })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ CoordinatorContextUsage } = await import('./coordinator-context-usage'))
  root = createRoot(document.body)
})
after(async () => {
  await act(async () => root.unmount())
  await page.happyDOM.close()
})

const usage = (used: number): ConversationUsage => ({ estimated: true, used, compactAt: 100_000, share: Math.round(used / 1_000), compactsNextTurn: false, keepRecent: 20_000, hasSummary: false, windowTokens: null })

test('the composer shows a ring of the share; the figures are in its name, its tooltip and the panel', async () => {
  await act(async () => root.render(<CoordinatorContextUsage usage={usage(43_000)} />))
  const trigger = document.querySelector('button')!
  // A ring, not 「上下文 43K/100K」 (#2921, Figma 1318:2 sections 01 and 14).
  assert.equal(trigger.textContent, '')
  assert.equal(trigger.querySelector('[data-slot="context-ring"]')?.getAttribute('data-share'), '43')
  assert.equal(trigger.getAttribute('aria-label'), trigger.getAttribute('title'))
  assert.match(trigger.getAttribute('aria-label')!, /43K/)
  assert.match(trigger.getAttribute('aria-label')!, /100K/)
  await act(async () => trigger.click())
  const panel = document.querySelector<HTMLElement>('[role="dialog"]')
  assert.ok(panel)
  assert.match(panel.textContent, /43%/)
})

test('an empty conversation draws no arc, only the track', async () => {
  await act(async () => root.render(<CoordinatorContextUsage usage={usage(0)} />))
  const ring = document.querySelector('[data-slot="context-ring"]')!
  assert.equal(ring.getAttribute('data-share'), '0')
  assert.equal(ring.querySelectorAll('circle').length, 1)
})

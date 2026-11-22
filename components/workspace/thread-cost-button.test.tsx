import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { ThreadCost } from '@/lib/thread-cost'

// The real Chinese copy, so the test reads what the person sees.
const zh = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown>>
mock.module('@/lib/intl/i18n-client', { namedExports: {
  useLocale: () => 'zh-CN',
  // The person's real locale end to end: Chinese copy and zh-CN number formatting.
  useFormatter: () => ({ number: (value: number, options: Intl.NumberFormatOptions) => new Intl.NumberFormat('zh-CN', options).format(value) }),
  useTranslations: (namespace: string) => (key: string, values: Record<string, unknown> = {}) => {
    const text = `${namespace}.${key}`.split('.').reduce<unknown>((value, name) => (value as Record<string, unknown>)?.[name], zh)
    if (typeof text !== 'string') throw new Error(`missing copy: ${namespace}.${key}`)
    return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]))
  },
} })

let reply: unknown = null
const reads: unknown[][] = []
mock.module('@/app/actions/task-runs', { namedExports: { readThreadCost: async (...args: unknown[]) => { reads.push(args); return reply } } })

const page = new Window({ url: 'https://example.invalid/mikka' })
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let SWRConfig: typeof import('swr')['SWRConfig']
let mod: typeof import('./thread-cost-button')

before(async () => {
  Object.assign(globalThis, { window: page, document: page.document, IS_REACT_ACT_ENVIRONMENT: true })
  for (const key of ['navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: page[key] })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig } = await import('swr'))
  mod = await import('./thread-cost-button')
  root = createRoot(document.body)
})
beforeEach(() => { reads.length = 0 })
after(async () => {
  await act(async () => root.unmount())
  await page.happyDOM.close()
})

const none = { microUsd: 0, unpricedReceipts: 0 }
const cost = (credits = none, included = none): ThreadCost => ({
  threadId: 'run-1', groupBy: 'thread',
  totals: { credits, included: { ...included, bySource: { subscription: included, api_key: none } } },
})

let mounts = 0
async function show(node: React.ReactNode) {
  // A fresh tree and cache per render, so one test's open panel or read never carries into the next.
  await act(async () => root.render(<SWRConfig key={++mounts} value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const trigger = () => document.querySelector<HTMLButtonElement>('[data-slot="thread-cost"]')
async function open() {
  await act(async () => { trigger()!.click() })
  return document.body.textContent ?? ''
}

test('the header shows what Mikka charged this thread, from the settled amount', async () => {
  await show(<mod.ThreadCostView cost={cost({ microUsd: 1_240_000, unpricedReceipts: 0 })} />)
  assert.equal(trigger()?.textContent, '$1.24')
  assert.equal(trigger()?.getAttribute('aria-label'), '本线程费用 $1.24')
  const panel = await open()
  assert.match(panel, /Mikka 额度\$1\.24/)
  assert.doesNotMatch(panel, /你的订阅或 API Key/, 'no subscription row when none was used')
})

test('a cost with nothing settled yet reads as settling, never as a zero amount', async () => {
  await show(<mod.ThreadCostView cost={cost({ microUsd: 0, unpricedReceipts: 2 })} />)
  assert.equal(trigger()?.textContent, '结算中')
  assert.equal(trigger()?.getAttribute('aria-label'), '本线程费用还在结算')
  assert.match(await open(), /还有 2 次调用在结算/)
})

test('a partly settled cost is a floor, and a charge under a cent is not shown as zero', async () => {
  await show(<mod.ThreadCostView cost={cost({ microUsd: 4_000, unpricedReceipts: 1 })} />)
  assert.equal(trigger()?.textContent, '<$0.01+')
  assert.equal(trigger()?.getAttribute('aria-label'), '本线程费用至少 <$0.01，还有调用在结算')
})

test('subscription calls are counted apart, never added to the charge or called settling', async () => {
  // A subscription call is recorded with no cost (lib/secrets/run-events.ts): it has no per-call price.
  await show(<mod.ThreadCostView cost={cost({ microUsd: 500_000, unpricedReceipts: 0 }, { microUsd: 0, unpricedReceipts: 12 })} />)
  assert.equal(trigger()?.textContent, '$0.50')
  const panel = await open()
  assert.match(panel, /你的订阅或 API Key12 次调用/)
  assert.match(panel, /订阅不按次计价/)
  assert.doesNotMatch(panel, /在结算/)
})

test('an API key usage with a price is shown as its own amount', async () => {
  await show(<mod.ThreadCostView cost={cost({ microUsd: 500_000, unpricedReceipts: 0 }, { microUsd: 3_000_000, unpricedReceipts: 0 })} />)
  assert.equal(trigger()?.textContent, '$0.50')
  assert.match(await open(), /你的订阅或 API Key\$3\.00/)
})

test('the button reads the thread cost and shows nothing when the read is refused', async () => {
  reply = { error: 'runNotFound' }
  await show(<mod.ThreadCostButton runId="run-1" />)
  assert.deepEqual(reads, [['run-1', 'thread']])
  assert.equal(trigger(), null)

  reply = cost({ microUsd: 2_000_000, unpricedReceipts: 0 })
  await show(<mod.ThreadCostButton runId="run-2" />)
  assert.equal(trigger()?.textContent, '$2.00')
})

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
/** `included` is the sum of the subscription and API key sources, as readThreadCost reports it. */
const nothing = { microUsd: 0, receipts: 0 }
const cost = (credits = none, subscription = none, apiKey = none, funding: { covered?: typeof nothing; fundingUnknown?: typeof nothing } = {}): ThreadCost => ({
  threadId: 'run-1', groupBy: 'thread',
  totals: { credits, included: {
    microUsd: subscription.microUsd + apiKey.microUsd, unpricedReceipts: subscription.unpricedReceipts + apiKey.unpricedReceipts,
    bySource: { subscription, api_key: apiKey },
  }, covered: funding.covered ?? nothing, fundingUnknown: funding.fundingUnknown ?? nothing },
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
  assert.match(panel, /经由 Mikka\$1\.24/)
  assert.doesNotMatch(panel, /你的订阅或 API Key/, 'no subscription row when none was used')
})

test('a cost with nothing settled yet reads as settling, never as a zero amount', async () => {
  await show(<mod.ThreadCostView cost={cost({ microUsd: 0, unpricedReceipts: 2 })} />)
  assert.equal(trigger()?.textContent, '结算中')
  assert.equal(trigger()?.getAttribute('aria-label'), '本线程费用还在结算')
  assert.match(await open(), /还有 2 次调用在结算/)
})

test('a partly settled cost is a floor cut to whole cents, never rounded up', async () => {
  // A default machine chunk settles at $0.016667 while a model call is pending: at least $0.01, not $0.02.
  await show(<mod.ThreadCostView cost={cost({ microUsd: 16_667, unpricedReceipts: 1 })} />)
  assert.equal(trigger()?.textContent, '$0.01+')
  assert.equal(trigger()?.getAttribute('aria-label'), '本线程费用至少 $0.01，还有调用在结算')
})

test('under a cent settled with calls pending is still settling, and a settled charge under a cent is not zero', async () => {
  await show(<mod.ThreadCostView cost={cost({ microUsd: 4_000, unpricedReceipts: 1 })} />)
  assert.equal(trigger()?.textContent, '结算中')
  assert.equal(trigger()?.getAttribute('aria-label'), '本线程费用还在结算')
  assert.match(await open(), /经由 Mikka<\$0\.01还有 1 次调用在结算/, 'the panel still shows what has settled')
  await show(<mod.ThreadCostView cost={cost({ microUsd: 4_000, unpricedReceipts: 0 })} />)
  assert.equal(trigger()?.textContent, '<$0.01')
  assert.equal(trigger()?.getAttribute('aria-label'), '本线程费用 <$0.01')
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
  await show(<mod.ThreadCostView cost={cost({ microUsd: 500_000, unpricedReceipts: 0 }, none, { microUsd: 3_000_000, unpricedReceipts: 0 })} />)
  assert.equal(trigger()?.textContent, '$0.50')
  assert.match(await open(), /你的订阅或 API Key\$3\.00/)
})

test('an API key amount beside subscription calls counts the calls that have no price', async () => {
  await show(<mod.ThreadCostView cost={cost({ microUsd: 500_000, unpricedReceipts: 0 }, { microUsd: 0, unpricedReceipts: 4 }, { microUsd: 3_000_000, unpricedReceipts: 0 })} />)
  const panel = await open()
  assert.match(panel, /你的订阅或 API Key\$3\.00/)
  assert.match(panel, /另有 4 次调用没有单次价格/)
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

/** The breakdown's rows, drawn as plain text so the test reads exactly what each list says. */
function Rows({ breakdown }: { breakdown: import('./thread-cost-button').ThreadCostBreakdown }) {
  const { charged, included } = mod.useThreadCostBreakdownRows(breakdown)
  const list = (name: string, rows: typeof charged) => <ul data-list={name}>{rows.map(row => <li key={row.key}>{[row.label, row.detail, row.value].filter(Boolean).join('|')}</li>)}</ul>
  return <>{list('charged', charged)}{list('included', included)}</>
}
const lines = (name: string) => [...document.querySelectorAll(`[data-list="${name}"] li`)].map(item => item.textContent)
const model = (name: string, calls: number, credits = none, subscription = none, apiKey = none, covered = nothing, fundingUnknown = nothing) => ({
  model: name, calls, inputTokens: 0, outputTokens: 0, bySource: { credits, subscription, api_key: apiKey }, covered, fundingUnknown,
})
const machine = { coveredMicroUsd: 0, fundingUnknownMicroUsd: 0 }

test('what went through Mikka and what the person paid themselves are separate lists, never summed', async () => {
  await show(<Rows breakdown={{ machines: [], models: [
    model('claude-opus-5-5', 3, { microUsd: 420_000, unpricedReceipts: 0 }),
    model('gpt-6-luna', 12, none, { microUsd: 0, unpricedReceipts: 12 }),
    model('deepseek-v4.1-flash', 2, { microUsd: 16_667, unpricedReceipts: 1 }, none, { microUsd: 1_600_000, unpricedReceipts: 0 }),
  ] }} />)
  assert.deepEqual(lines('charged'), ['Opus 5.5|$0.42', 'DeepSeek V4.1 Flash|$0.01+'], 'a settling line is a floor with a +; a model Mikka did not charge is left out')
  assert.deepEqual(lines('included'), ['GPT-6 Luna|订阅|12 次调用', 'DeepSeek V4.1 Flash|API Key|$1.60'], 'a subscription call is counted, not priced')
})

test('a model with nothing settled reads as settling, never $0.00, and a zero line is hidden', async () => {
  await show(<Rows breakdown={{ machines: [], models: [model('claude-opus-5-5', 1, { microUsd: 0, unpricedReceipts: 1 }), model('gpt-6-luna', 1)] }} />)
  assert.deepEqual(lines('charged'), ['Opus 5.5|结算中'])
  assert.deepEqual(lines('included'), [])
})

test('machines come first with their running time and prepaid charge; one Mikka did not bill is not listed as a charge', async () => {
  await show(<Rows breakdown={{ models: [model('claude-opus-5-5', 1, { microUsd: 10_000, unpricedReceipts: 0 })], machines: [
    { size: 'standard-3', billing: 'metered', seconds: 7_800, meteredMicroUsd: 433_333, chargedMicroUsd: 450_000, unpricedReceipts: 0, ...machine },
    { size: null, billing: 'unknown_size', seconds: 300, meteredMicroUsd: null, chargedMicroUsd: 0, unpricedReceipts: 1, ...machine },
    { size: null, billing: 'unbilled', seconds: 42, meteredMicroUsd: null, chargedMicroUsd: 0, unpricedReceipts: 0, ...machine },
  ] }} />)
  assert.deepEqual(lines('charged'), ['云机器 · 2 vCPU · 8 GiB|2 小时 10 分钟|$0.45', '云机器|5 分钟|结算中', 'Opus 5.5|$0.01'])
})

test('platform-funded usage is a muted row of its own, never part of the charge', async () => {
  await show(<mod.ThreadCostView cost={cost({ microUsd: 500_000, unpricedReceipts: 0 }, none, none, { covered: { microUsd: 2_000_000, receipts: 3 } })} />)
  assert.equal(trigger()?.textContent, '$0.50')
  assert.match(await open(), /平台承担（不计费）\$2\.00/)
})

test('receipts settled before funding was recorded still count as charged, so an existing thread does not drop', async () => {
  await show(<mod.ThreadCostView cost={cost({ microUsd: 0, unpricedReceipts: 0 }, none, none, { fundingUnknown: { microUsd: 1_240_000, receipts: 4 } })} />)
  assert.equal(trigger()?.textContent, '$1.24')
  assert.match(await open(), /经由 Mikka\$1\.24/)
  await show(<mod.ThreadCostView cost={cost({ microUsd: 0, unpricedReceipts: 1 }, none, none, { fundingUnknown: { microUsd: 1_240_000, receipts: 4 } })} />)
  assert.equal(trigger()?.textContent, '$1.24+', 'a settling receipt still gives the +')
})

test('a breakdown line the platform paid for in full shows $0 with its list cost; unknown funding counts as charged', async () => {
  await show(<Rows breakdown={{ models: [
    model('claude-opus-5-5', 2, none, none, none, { microUsd: 420_000, receipts: 2 }),
    model('claude-sonnet-5-5', 3, { microUsd: 100_000, unpricedReceipts: 0 }, none, none, { microUsd: 50_000, receipts: 1 }, { microUsd: 200_000, receipts: 1 }),
  ], machines: [
    { size: 'standard-3', billing: 'metered', seconds: 600, meteredMicroUsd: 33_333, chargedMicroUsd: 0, unpricedReceipts: 0, coveredMicroUsd: 33_334, fundingUnknownMicroUsd: 0 },
  ] }} />)
  assert.deepEqual(lines('charged'), ['云机器 · 2 vCPU · 8 GiB|10 分钟|$0.00（原价 $0.03）', 'Opus 5.5|$0.00（原价 $0.42）', 'Sonnet 5.5|$0.30'])
})

test('the breakdown reads the model and machine groupings, and a refusal is a failure, not an empty list', async () => {
  function Probe({ runId }: { runId: string }) {
    const { breakdown, failed } = mod.useThreadCostBreakdown(runId, true)
    return <p data-probe="">{failed ? 'failed' : breakdown ? `${breakdown.models.length}/${breakdown.machines.length}` : 'loading'}</p>
  }
  reply = { ...cost(), models: [model('claude-opus-5-5', 1)], machines: [] }
  await show(<Probe runId="run-1" />)
  assert.deepEqual(reads, [['run-1', 'model'], ['run-1', 'machine']])
  assert.equal(document.querySelector('[data-probe]')?.textContent, '1/0')
  reply = { error: 'runNotFound' }
  await show(<Probe runId="run-2" />)
  assert.equal(document.querySelector('[data-probe]')?.textContent, 'failed')
})

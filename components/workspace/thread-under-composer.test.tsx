import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import chinese from '../../messages/zh-CN.json'
import english from '../../messages/en.json'
import type { ThreadMachine } from '../../lib/thread-machine'
import type { ThreadSummary } from '../../lib/thread-summary'

let locale: 'zh-CN' | 'en' = 'en'
const messages = () => locale === 'en' ? english : chinese
const lookup = (path: string, values?: Record<string, unknown>) => {
  const text = path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], messages()) as string
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? `{${key}}`))
}
mock.module('@/lib/intl/i18n-client', { namedExports: {
  useLocale: () => locale, useMessages: messages, useNow: () => new Date('2026-11-20T16:00:00Z'),
  useFormatter: () => ({ dateTime: (date: Date) => date.toISOString().slice(11, 16), relativeTime: () => '' }),
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => lookup(`${namespace}.${key}`, values),
} })
mock.module(new URL('../../i18n/navigation.ts', import.meta.url).href, { namedExports: { Link: (props: ComponentProps<'a'>) => <a {...props} href={props.href} /> } })
mock.module(new URL('../../app/actions/agents.ts', import.meta.url).href, { namedExports: { resumeQuotaPausedRunOnApiKey: async () => {}, retryQuotaPausedRun: async () => {} } })
let machine: ThreadMachine | null = null
let summary: ThreadSummary | null = null
mock.module(new URL('../../hooks/use-thread-run-reads.ts', import.meta.url).href, { namedExports: {
  useThreadMachine: () => ({ data: machine }), useThreadSummary: () => ({ data: summary }),
} })

let Under: typeof import('./thread-under-composer')['ThreadUnderComposer']
let Queued: typeof import('./thread-queued-messages')['ThreadQueuedMessages']
let Paused: typeof import('./thread-quota')['ThreadQuotaPausedCard']
before(async () => {
  ({ ThreadUnderComposer: Under } = await import('./thread-under-composer'))
  ;({ ThreadQueuedMessages: Queued } = await import('./thread-queued-messages'))
  ;({ ThreadQuotaPausedCard: Paused } = await import('./thread-quota'))
})

const cloud: ThreadMachine = { kind: 'cloud', state: 'running', name: null, platform: 'linux', arch: 'x64', hostname: null, lastSeenAt: null,
  cloud: { sandboxId: 'i8k2m3abcdef', template: 'base', createdAt: '2026-11-20T15:00:00Z', endedAt: null } }
const recorded = (patch: Partial<ThreadSummary>): ThreadSummary => ({ threadId: 'thread', cost: { mikka: { usd: 0, unpriced: 0 }, included: { usd: 0, unpriced: 0 } } as unknown as ThreadSummary['cost'],
  machine: { kind: 'cloud', size: 'standard-3', state: 'running' }, repo: { key: 'github.com/alexj11324/Mikka', name: 'alexj11324/Mikka' }, branch: 'main',
  context: { estimated: true, used: 10, max: 100, model: null }, ...patch })

test('the row under the composer names where the thread runs, its repository and branch, and keeps the context ring on the right', () => {
  for (const language of ['en', 'zh-CN'] as const) {
    locale = language
    machine = cloud; summary = recorded({})
    const html = renderToStaticMarkup(<Under issueId="task" runId="run" status="running" context={<i data-ring="" />} />)
    assert.match(html, /data-slot="thread-under-composer"/)
    assert.ok(html.includes(`>${messages().ThreadUnderComposer.cloud}<`), 'a cloud machine is named by its kind, not its sandbox')
    assert.ok(html.includes(lookup('ThreadUnderComposer.machineLabel', { name: messages().ThreadUnderComposer.cloud, state: messages().ThreadUnderComposer.awake })))
    assert.ok(html.includes('alexj11324/Mikka · main'))
    assert.match(html, /data-ring=""/)
    assert.ok(html.indexOf('thread-machine-trigger') < html.indexOf('thread-repository') && html.indexOf('thread-repository') < html.indexOf('data-ring'))
  }
})

test('a computer is named by its device, an asleep cloud says so, and nothing recorded draws nothing', () => {
  locale = 'en'
  machine = { ...cloud, kind: 'laptop', state: 'online', name: 'Alex MacBook Pro', cloud: null }; summary = recorded({ machine: { kind: 'laptop', size: null, state: 'online' }, repo: null, branch: null })
  let html = renderToStaticMarkup(<Under issueId={null} runId="run" status="running" />)
  assert.ok(html.includes('>Alex MacBook Pro<'))
  assert.ok(!html.includes('thread-repository'), 'no repository recorded, no repository shown')
  machine = { ...cloud, state: 'paused' }; summary = recorded({ branch: null })
  html = renderToStaticMarkup(<Under issueId={null} runId="run" status="paused" />)
  assert.ok(html.includes(lookup('ThreadUnderComposer.machineLabel', { name: 'Cloud', state: english.ThreadUnderComposer.asleep })))
  assert.ok(html.includes('>alexj11324/Mikka<'), 'a run that does not push shows the repository without a branch')
  html = renderToStaticMarkup(<Under issueId={null} runId="run" status="paused" />)
  assert.ok(html.includes(lookup('ThreadUnderComposer.context', { used: '10', max: '100' })), 'without the thread read\'s ring, the summary\'s context against the model window')
  assert.match(html, /bg-muted-foreground/, 'an asleep machine has a grey dot')
  machine = cloud
  assert.match(renderToStaticMarkup(<Under issueId={null} runId="run" status="running" />), /bg-success/, 'an awake machine has a green dot')
  machine = null; summary = null
  assert.equal(renderToStaticMarkup(<Under issueId={null} runId="run" status="running" />), '')
})

test('queued messages say how many wait and when they go, with Send now only where the run takes one and Delete while it waits', () => {
  locale = 'en'
  const rows = [
    { id: 'a', text: 'Also add a reduced-motion variant.', onSendNow: () => {}, onDelete: () => {} },
    { id: 'b', text: 'Then rebase on main.', onDelete: () => {} },
    { id: 'c', text: 'This one is going.', note: english.IssueThreads.deliverySending },
  ]
  let html = renderToStaticMarkup(<Queued rows={rows} />)
  assert.ok(html.includes(lookup('ThreadUnderComposer.queued.title', { count: 3 })))
  assert.ok(html.includes(english.ThreadUnderComposer.queued.afterTurn))
  assert.equal(html.split(`>${english.ThreadUnderComposer.queued.sendNow}<`).length - 1, 1)
  assert.equal(html.split(`aria-label="${english.ThreadUnderComposer.queued.delete}"`).length - 1, 2)
  assert.ok(html.includes(english.IssueThreads.deliverySending))
  assert.ok(!/edit/i.test(html), 'no write changes a queued message, so there is no Edit')
  html = renderToStaticMarkup(<Queued rows={rows} paused />)
  assert.ok(html.includes(english.ThreadUnderComposer.queued.whenContinued))
  assert.equal(renderToStaticMarkup(<Queued rows={[]} />), '')
})

test('the usage-limit card says Paused, the subscription and until when, and offers only this thread\'s ways on', () => {
  for (const language of ['en', 'zh-CN'] as const) {
    locale = language
    const paused = { runId: 'run', subscription: 'claude' as const, plan: 'Max', resetsAt: new Date(Date.now() + 3_600_000).toISOString(), keyReady: false }
    const html = renderToStaticMarkup(<Paused paused={paused} onContinued={() => {}} />)
    const copy = messages().ThreadUnderComposer.paused
    assert.match(html, /data-thread-quota-paused/)
    assert.ok(html.includes(`>${copy.badge}<`))
    assert.ok(html.includes(lookup('ThreadUnderComposer.paused.kind', { name: 'Claude Max' })))
    assert.ok(html.includes(lookup('ThreadUnderComposer.paused.until', { name: 'Claude Max', time: paused.resetsAt.slice(11, 16) }).slice(0, 12)))
    assert.match(html, new RegExp(`<button[^>]*disabled[^>]*>${copy.tryNow}<`), 'Try now waits for the reset')
    assert.match(html, /href="\/settings\?section=usage"/)
    assert.match(html, /href="\/settings\?section=models"/)
    assert.ok(!/Try all|Switch all|Later|全部|稍后/.test(html), 'no write acts on every paused thread')
  }
})

import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { TaskPresentation } from '@/lib/task-presentation'

let cards: Record<string, Partial<TaskPresentation>> = {}
const commands: unknown[] = []
let refuse = false
mock.module('@/lib/intl/i18n-client', { namedExports: {
  useLocale: () => 'en',
  useTranslations: (namespace: string) => Object.assign((key: string) => `${namespace}.${key}`, {
    rich: (key: string, parts: Record<string, () => unknown>) => [`${namespace}.${key} `, ...Object.values(parts).map(part => part())],
  }),
} })
mock.module('@/hooks/use-task-cards', { namedExports: { useTaskCards: () => cards } })
mock.module('@/lib/inbox/client', { namedExports: { submitInboxCommand: async (command: unknown) => {
  if (refuse) throw new Error('inboxConflict')
  commands.push(command); return { changed: true }
} } })
mock.module('sonner', { namedExports: { toast: { error: (text: string) => { toasts.push(text) } } } })
const toasts: string[] = []

const browser = new Window({ url: 'https://fixture.example/mikka' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let lineModule: typeof import('./merge-waiting-line')
let PullRequestChip: typeof import('./pull-request-chip')['PullRequestChip']

before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['Node', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  lineModule = await import('./merge-waiting-line')
  ;({ PullRequestChip } = await import('./pull-request-chip'))
})
beforeEach(() => { cards = {}; commands.length = 0; toasts.length = 0; refuse = false; container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())

const url = 'https://github.com/alexj11324/Mikka/pull/2837'

test('a PR chip is the git-pull-request mark in its state colour and repo#n as a link; an unknown state stays uncoloured', async () => {
  await act(async () => root.render(<><PullRequestChip url={url} state="merged" /><PullRequestChip url={url} state={null} /></>))
  const [known, unknown] = [...container.querySelectorAll('a[data-pull-chip]')]
  assert.equal(known.getAttribute('href'), url)
  assert.equal(known.textContent, 'Mikka#2837')
  assert.equal(known.getAttribute('aria-label'), 'Mikka#2837, PullDirectory.states.merged')
  assert.match(known.querySelector('svg')!.getAttribute('class') ?? '', /text-github-pr-merged/)
  assert.equal(unknown.getAttribute('aria-label'), 'Mikka#2837')
  assert.match(unknown.querySelector('svg')!.getAttribute('class') ?? '', /text-muted-foreground/)
})

function Probe({ candidates, workspaceId }: { candidates: Parameters<typeof lineModule.useMergeWaitings>[0]; workspaceId: string | null }) {
  const waitings = lineModule.useMergeWaitings(candidates)
  return <>{waitings.map(waiting => <lineModule.MergeWaitingLine key={waiting.issueId} waiting={waiting} workspaceId={workspaceId} />)}</>
}

test('only a task the Inbox says waits on review, with an open PR, draws the one waiting line', async () => {
  cards = {
    waiting: { inboxReason: 'review', review: { pr: { number: 2837, state: 'open', url }, files: null, additions: null, deletions: null, checks: { failed: 0, passed: 5, pending: 0 }, running: false } },
    dismissed: { inboxReason: null },
    merged: { inboxReason: 'review' },
  }
  await act(async () => root.render(<Probe workspaceId="ws" candidates={[
    { issueId: 'waiting', pulls: [{ url, state: 'open' }] },
    { issueId: 'waiting', pulls: [{ url, state: 'open' }] },
    { issueId: 'dismissed', pulls: [{ url, state: 'open' }] },
    { issueId: 'merged', pulls: [{ url: url.replace('2837', '2838'), state: 'merged' }] },
  ]} />))
  const lines = [...container.querySelectorAll('[data-merge-waiting]')]
  assert.deepEqual(lines.map(line => line.getAttribute('data-merge-waiting')), ['waiting'])
  assert.equal(lines[0].querySelector('a[data-pull-chip]')!.getAttribute('data-pull-chip'), 'ready', 'settled green checks: ready')
  assert.match(lines[0].textContent ?? '', /MergeWaiting\.line/)
})

test('Dismiss is the Inbox\'s own dismissal of the task; a refusal says so and keeps the line', async () => {
  cards = { task: { inboxReason: 'review' } }
  await act(async () => root.render(<Probe workspaceId="ws" candidates={[{ issueId: 'task', pulls: [{ url, state: 'open' }] }]} />))
  const dismiss = () => [...container.querySelectorAll('button')].find(button => button.textContent === 'MergeWaiting.dismiss') as HTMLButtonElement
  assert.equal(container.querySelector('a[data-pull-chip]')!.getAttribute('data-pull-chip'), '', 'an open PR with no checks has no state colour')
  await act(async () => { dismiss().click() })
  assert.deepEqual(commands, [{ workspaceId: 'ws', type: 'task', id: 'task', action: 'dismiss' }])
  refuse = true
  await act(async () => { dismiss().click() })
  assert.deepEqual(toasts, ['MergeWaiting.dismissFailed'])
})

test('without a workspace to write to there is no Dismiss rather than a dead one', async () => {
  cards = { task: { inboxReason: 'review' } }
  await act(async () => root.render(<Probe workspaceId={null} candidates={[{ issueId: 'task', pulls: [{ url, state: 'draft' }] }]} />))
  assert.ok(container.querySelector('[data-merge-waiting]'))
  assert.equal(container.querySelector('button'), null)
})

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'
import { NextIntlClientProvider } from '@/lib/intl/i18n-client'
import messages from '../../messages/en.json'
import type { CitationSource } from '../../lib/coordinator/citations'
import type { AgentCitations } from '../workspace/agent-citations'

// A runtime event line names its thread by its title (a link, no icon or badge) and its task by state icon and code
// (decision 2026-11-10), then what happened.
const browser = new Window({ url: 'https://mikka.example/' })
let createRoot: typeof import('react-dom/client')['createRoot']
import { TaskPresentationsContext } from '@/hooks/use-task-collection'
import { taskPresentation } from '@/lib/task-presentation'
let ChatEventLine: typeof import('./chat-event-line')['ChatEventLine']
before(async () => {
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, location: browser.location, IS_REACT_ACT_ENVIRONMENT: true, Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, ShadowRoot: browser.ShadowRoot, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ChatEventLine } = await import('./chat-event-line'))
})
after(() => browser.happyDOM.close())

const TASK = '00000000-0000-4000-8000-0000000000d1'
const RUN = '00000000-0000-4000-8000-0000000000d2'
const sources: Record<string, CitationSource> = {
  [TASK]: { kind: 'issue', id: TASK, number: 45, identifier: 'ALEX-45', title: 'Create the handoff', status: 'done', priority: 'normal', run: { status: 'succeeded', outcome: 'done' }, pullRequests: [] },
  [RUN]: { kind: 'run', id: RUN, agentName: 'Worker', harness: 'codex', status: 'succeeded', outcome: 'done', issue: { id: TASK, number: 45, identifier: 'ALEX-45', title: 'Create the handoff' }, name: 'Create the handoff in Mikka', summary: null, steps: 3, createdAt: '2026-11-10T00:00:00.000Z', finishedAt: '2026-11-10T00:10:00.000Z' },
}
const citations: AgentCitations = { sources, previews: {}, onOpenIssue: () => {} }

test('an event line reads as its thread title or its task code, then what happened', async () => {
  const container = browser.document.createElement('div') as unknown as HTMLElement
  document.body.append(container)
  const root = createRoot(container)
  const render = (line: Parameters<typeof ChatEventLine>[0]['line']) => act(async () => {
    root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><TaskPresentationsContext value={{ [TASK]: taskPresentation({ status: 'done', metadata: { pullRequests: [] } }, undefined, null, () => false) }}><ChatEventLine line={line} citations={citations} /></TaskPresentationsContext></NextIntlClientProvider>)
  })
  try {
    await render({ kind: 'runFinished', runId: RUN, issueId: null, status: 'succeeded', title: null })
    // The thread is named by the conversation's own short title; the two parts are spaced by the row's gap, not a character.
    assert.equal(container.querySelector('[data-thread-link]')?.textContent, 'Create the handoff in Mikka')
    assert.equal(container.querySelector('[data-event-line] > span:last-child')?.textContent, 'finished')
    assert.equal(container.querySelector('[data-thread-link] svg'), null, 'the thread has no icon')
    await render({ kind: 'issueStatus', runId: null, issueId: TASK, status: 'done', title: null })
    assert.equal(container.querySelector('[data-task-chip]')?.textContent, 'ALEX-45')
    assert.equal(container.querySelector('[data-event-line] > span:last-child')?.textContent, 'moved to Done')
    assert.equal(container.querySelector('[data-task-status]')?.getAttribute('data-task-status'), 'done')
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
  }
})

test("an Agent's message back is one collapsed row in the tool rows' look, not another speaker (Alex, 2026-11-23)", async () => {
  const container = browser.document.createElement('div') as unknown as HTMLElement
  document.body.append(container)
  const root = createRoot(container)
  const withSummary: AgentCitations = { ...citations, sources: { ...sources, [RUN]: { ...sources[RUN] as Extract<CitationSource, { kind: 'run' }>, summary: 'Three checks pass.' } } }
  const render = (line: Parameters<typeof ChatEventLine>[0]['line'], cites = citations) => act(async () => {
    root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><ChatEventLine line={line} citations={cites} /></NextIntlClientProvider>)
  })
  try {
    await render({ kind: 'runFinished', runId: RUN, issueId: null, status: 'succeeded', title: null }, withSummary)
    const row = container.querySelector('[data-agent-message-row]')
    assert.ok(row, 'a collapsed row')
    assert.equal(row?.querySelector('button')?.getAttribute('aria-expanded'), 'false', 'collapsed by default')
    assert.equal(row?.querySelector('button')?.textContent, 'Reply from Codex · ALEX-45 Create the handoff')
    assert.match(row?.querySelector('[data-agent-message-body]')?.textContent ?? '', /Three checks pass\.[\s\S]*Open thread/)
    assert.equal(row?.querySelector('button [data-slot="badge"], button [data-status-icon]'), null, 'no status glyph')
    await render({ kind: 'runReport', runId: RUN, issueId: null, status: null, title: null, message: 'Half way there' })
    assert.equal(container.querySelector('[data-agent-message-row] button')?.textContent, 'Message from Codex · ALEX-45 Create the handoff')
    // Nothing of its own to say: the line stays as it was.
    await render({ kind: 'runFinished', runId: RUN, issueId: null, status: 'succeeded', title: null })
    assert.equal(container.querySelector('[data-agent-message-row]'), null)
    assert.ok(container.querySelector('[data-event-line]'))
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
  }
})

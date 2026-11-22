import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'
import { NextIntlClientProvider } from '@/lib/intl/i18n-client'
import messages from '../messages/zh-CN.json'
import type { CitationSource } from '../lib/coordinator/citations'
import type { AgentCitations } from '../components/workspace/agent-citations'
import type { ThreadToolRow } from '../components/slots/thread-contract'
import type { ChatTool } from '../lib/coordinator/context'

// Alex, 2026-11-22: the Bot chat's tool rows in the thread slot. A tool reads its English name in a Chinese UI;
// Mikka's own tools open to their task chip or not at all (a dispatch's 子 Agent card stands for it); any other tool
// reads its whole call when its row is opened.
const toolCalls: unknown[][] = []
mock.module(new URL('../app/actions/coordinator.ts', import.meta.url).href, { namedExports: {
  coordinatorReasoning: async () => null,
  coordinatorToolCall: async (...args: unknown[]) => { toolCalls.push(args); return { output: 'whole' } },
} })
const browser = new Window({ url: 'https://mikka.example/' })
let createRoot: typeof import('react-dom/client')['createRoot']
before(async () => {
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, location: browser.location, IS_REACT_ACT_ENVIRONMENT: true, Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, MutationObserver: browser.MutationObserver, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), ResizeObserver: browser.ResizeObserver })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
})
after(() => browser.happyDOM.close())

const TASK = '0a5c49d1-0d4d-489c-8f9e-0000000000a1'
const RUN = '2b2ff606-ecb7-4b11-a211-0000000000c3'
const issue: CitationSource = { kind: 'issue', id: TASK, number: 45, identifier: 'ALEX-45', title: 'login redirect', status: 'doing', priority: 'normal' }
const citations: AgentCitations = { sources: { [TASK]: issue }, previews: {}, onOpenIssue: () => {} }

async function rowsOf(tools: ChatTool[], stored?: { botId: string | null; position: number }) {
  const { useThreadToolRows } = await import('../components/coordinator/reply-activity')
  const { AgentCitationsContext } = await import('../components/workspace/agent-citations')
  let rows: ThreadToolRow[] = []
  function Probe() { rows = useThreadToolRows()(tools, { live: false, ...(stored ? { stored } : {}) }); return null }
  const container = browser.document.createElement('div') as unknown as HTMLElement
  const root = createRoot(container)
  await act(async () => root.render(<NextIntlClientProvider locale="zh-CN" timeZone="UTC" messages={messages}><AgentCitationsContext value={citations}><Probe /></AgentCitationsContext></NextIntlClientProvider>))
  await act(async () => root.unmount())
  return rows
}

async function html(node: unknown) {
  const { AgentCitationsContext } = await import('../components/workspace/agent-citations')
  const container = browser.document.createElement('div') as unknown as HTMLElement
  const root = createRoot(container)
  await act(async () => root.render(<NextIntlClientProvider locale="zh-CN" timeZone="UTC" messages={messages}><AgentCitationsContext value={citations}>{node as never}</AgentCitationsContext></NextIntlClientProvider>))
  const text = container.textContent ?? ''
  await act(async () => root.unmount())
  return text
}

test('tool names are English in a Chinese chat, never their identifiers', async () => {
  const rows = await rowsOf([
    { call: 'a', name: 'read_file', state: 'done', input: '{"path": "lib/auth/redirect.ts"}', output: 'x' },
    { call: 'b', name: 'get_issue', state: 'done', input: '{"identifier": "ALEX-45"}' },
    { call: 'c', name: 'dispatch_run', state: 'done', input: '{"prompt": "fix"}', output: `{"runId": "${RUN}", "status": "queued"}` },
  ])
  assert.deepEqual(rows.map(row => row.label), ['Read file', 'Get issue', 'Dispatch run'])
})

test('Get issue opens to its task chip; with nothing beyond its row, or as a dispatch, a row does not open', async () => {
  const [chip, bare, dispatch] = await rowsOf([
    { call: 'b', name: 'get_issue', state: 'done', input: '{"identifier": "ALEX-45"}', output: `{"id": "${TASK}", "identifier": "ALEX-45", "title": "login redirect"}` },
    { call: 'b2', name: 'get_issue', state: 'done', input: '{"identifier": "ALEX-46"}', output: '{"identifier": "ALEX-46"}' },
    { call: 'c', name: 'dispatch_run', state: 'done', input: '{"prompt": "fix"}', output: `{"runId": "${RUN}", "status": "queued"}` },
  ], { botId: null, position: 3 })
  assert.ok(chip.view, 'a chip to open to')
  const shown = await html(chip.view)
  assert.match(shown, /ALEX-45/)
  assert.match(shown, /login redirect/)
  assert.doesNotMatch(shown, /\{|"identifier"/, 'no JSON')
  assert.equal(bare.view, false, 'nothing beyond the row: no chevron')
  assert.equal(dispatch.view, false, 'the 子 Agent card stands for a dispatch')
  assert.equal(chip.full, undefined, 'an app tool reads no raw call')
})

test('any other tool reads its whole call only through `full`, keyed to its reply and call', async () => {
  const [read] = await rowsOf([{ call: 'a', name: 'read_file', state: 'done', input: '{"path": "a.ts"}', output: 'x'.repeat(200) }], { botId: 'bot-1', position: 7 })
  assert.equal(read.view, undefined)
  assert.equal(read.outputTruncated, true, 'a preview at the cut says so until the whole call is read')
  assert.equal(read.full?.key, 'bot-1:7:a')
  assert.deepEqual(await read.full?.load(), { output: 'whole' })
  assert.deepEqual(toolCalls.at(-1), ['bot-1', 7, 'a'])
})

test('a command in the Bot chat opens as its command then its output, as in a thread; a failure says so in words', async () => {
  const [ok, failed] = await rowsOf([
    { call: 'r1', name: 'bash', state: 'done', input: '{"command": "pnpm test auth"}', output: 'ℹ pass 2' },
    { call: 'r2', name: 'bash', state: 'error', input: '{"command": "pnpm lint:ui"}', output: '✖ 1 problem' },
  ])
  assert.deepEqual([ok.label, ok.note, ok.kind, ok.command, ok.detail], ['Run command', 'pnpm test auth', 'shell', 'pnpm test auth', 'ℹ pass 2'])
  assert.equal(failed.status, 'failed')
  assert.equal(failed.command, 'pnpm lint:ui')
  assert.ok(failed.error, 'the reason in words')
})

test('a search in the Bot chat names what it looked for, and the folder unless it is the workspace root', async () => {
  const [inFolder, atRoot] = await rowsOf([
    { call: 's1', name: 'grep', state: 'done', input: '{"pattern": "redirect", "path": "lib/auth"}', output: 'a' },
    { call: 's2', name: 'grep', state: 'done', input: '{"pattern": "redirect", "path": "."}', output: 'a' },
  ])
  assert.deepEqual([inFolder.label, inFolder.note, inFolder.target], ['Search', '"redirect" in lib/auth', 'redirect'])
  assert.equal(atRoot.note, '"redirect"')
})

test('a task the chat cannot show (not loaded, or not the reader\'s) leaves the row closed, never an empty panel', async () => {
  const [row] = await rowsOf([{ call: 'x', name: 'get_issue', state: 'done', input: '{"identifier": "ALEX-99"}', output: '{"id": "9a5c49d1-0d4d-489c-8f9e-0000000000ff"}' }])
  assert.equal(row.view, false)
})

test('the chat hands its citations to the rows: the thread slot draws them outside the chat\'s own context', async () => {
  const { useThreadToolRows } = await import('../components/coordinator/reply-activity')
  let rows: ThreadToolRow[] = []
  function Probe() { rows = useThreadToolRows()([{ call: 'b', name: 'get_issue', state: 'done', input: '{"identifier": "ALEX-45"}', output: `{"id": "${TASK}"}` }], { live: false, citations }); return null }
  const container = browser.document.createElement('div') as unknown as HTMLElement
  const root = createRoot(container)
  await act(async () => root.render(<NextIntlClientProvider locale="zh-CN" timeZone="UTC" messages={messages}><Probe /></NextIntlClientProvider>))
  await act(async () => root.unmount())
  assert.ok(rows[0].view, 'a chip to open to, with no citations context around the hook')
  const container2 = browser.document.createElement('div') as unknown as HTMLElement
  const root2 = createRoot(container2)
  await act(async () => root2.render(<NextIntlClientProvider locale="zh-CN" timeZone="UTC" messages={messages}>{rows[0].view as never}</NextIntlClientProvider>))
  assert.match(container2.textContent ?? '', /ALEX-45/, 'the chip draws from the citations the row carries')
  await act(async () => root2.unmount())
})

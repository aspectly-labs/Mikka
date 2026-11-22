import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

// A reply while it streams, through the streaming engine (agent-stream-markdown.tsx), on real time and real frames.
let codeRenders = 0
mock.module('@/lib/intl/i18n-client', { namedExports: { useMessages: () => ({ AgentCopy: { markdownTable: 'Table', image: 'Image', useTheIllustrationComponentForImages: '', loadingDiagram: '' } }) } })
mock.module(new URL('./agent-citations.tsx', import.meta.url).href, { namedExports: {
  useAgentCitations: () => null,
  CitationAnchor: ({ href, children }: { href?: string; children?: ReactNode }) => <a href={href}>{children}</a>,
} })
mock.module(new URL('./agent-code-block.tsx', import.meta.url).href, { namedExports: { AgentCodeBlock: ({ code }: { code: string }) => { codeRenders++; return <pre>{code}</pre> } } })

const browser = new Window({ url: 'https://mikka.example/en' })
let reduced = false
let createRoot: typeof import('react-dom/client')['createRoot']
let AgentMarkdown: typeof import('./agent-markdown')['AgentMarkdown']
let root: Root
let container: HTMLElement
before(async () => {
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true, Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  Object.defineProperty(browser, 'matchMedia', { configurable: true, value: (query: string) => ({ matches: reduced && query.includes('reduce'), addEventListener() {}, removeEventListener() {} }) })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ AgentMarkdown } = await import('./agent-markdown'))
  await import('./agent-stream-markdown')
})
beforeEach(() => {
  reduced = false
  codeRenders = 0
  container = browser.document.createElement('div') as unknown as HTMLElement
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())

const wait = (ms: number) => act(() => new Promise<void>(resolve => setTimeout(resolve, ms)))
const render = async (text: string, isStreaming: boolean) => { await act(async () => root.render(<AgentMarkdown text={text} isStreaming={isStreaming} />)); await wait(0) }
const engine = () => container.querySelector('.streamdown-animated')
/** Waits until the shown text has caught up with `text`'s words. */
async function settle(done: () => boolean) { for (let tries = 0; tries < 150 && !done(); tries++) await wait(20) }

test('a half-written bold or table never shows its markers while it streams', async () => {
  await render('The fix is **in the redirect', true)
  assert.ok(engine(), 'the streaming engine draws a live reply')
  assert.equal(container.querySelector('strong')?.textContent, 'in the redirect')
  assert.doesNotMatch(container.textContent ?? '', /\*/)

  await render('Steps:\n\n| Step | State |\n| -', true)
  assert.doesNotMatch(container.textContent ?? '', /\||-/, 'a table without its delimiter row stays hidden')
  assert.match(container.textContent ?? '', /Steps:/)
  await render('Steps:\n\n| Step | State |\n| --- | --- |\n| Build | do', true)
  await settle(() => /do$/.test(container.querySelector('tbody')?.textContent ?? ''))
  assert.ok(container.querySelector('table'), 'the table draws once its delimiter row is whole')
  assert.doesNotMatch(container.textContent ?? '', /\|/)
})

test('a finished block is not drawn again as new tokens arrive', { timeout: 20_000 }, async () => {
  const code = 'Here it is:\n\n```ts\nconst a = 1\n```\n\n'
  await render(code + 'Then', true)
  await settle(() => (container.textContent ?? '').endsWith('Then'))
  // Its fade (180 ms) has ended: the next token draws it once more without the fade, and that is the last time.
  await wait(300)
  const tail = ' I ran the tests, and every one of them passed on the first try after the change.'
  await render(code + 'Then' + tail.slice(0, 10), true)
  await settle(() => (container.textContent ?? '').endsWith(tail.slice(0, 10)))
  const before = codeRenders
  assert.ok(before >= 1)
  for (let at = 13; at <= tail.length; at += 3) { await render(code + 'Then' + tail.slice(0, at), true); await wait(16) }
  await settle(() => (container.textContent ?? '').endsWith('first try after the change.'))
  assert.equal(codeRenders, before, 'the finished code block was not drawn again')
})

test('new characters fade in while it streams; the end of the stream shows the whole text at once', async () => {
  await render('Looking into it', true)
  await render('Looking into it now, the build failed on the login redirect', true)
  assert.ok(container.querySelector('.stream-char'), 'new characters fade in')
  await render('Looking into it now, the build failed on the login redirect.', false)
  assert.equal(engine(), null)
  assert.equal(container.querySelector('.stream-char'), null)
  assert.equal(container.textContent, 'Looking into it now, the build failed on the login redirect.', 'no drain: the whole text at once')
})

test('stored text renders whole with no animation', async () => {
  await render('A stored reply, **read back** from the thread.', false)
  assert.equal(engine(), null)
  assert.equal(container.querySelector('.stream-char, .stream-block'), null)
  assert.equal(container.textContent, 'A stored reply, read back from the thread.')
})

test('with reduced motion a streaming reply shows its text at once, with no fade', async () => {
  reduced = true
  await render('Looking into it', true)
  await render('Looking into it now, the build failed on the login redirect.', true)
  assert.equal(engine(), null)
  assert.equal(container.querySelector('.stream-char, .stream-block'), null)
  assert.equal(container.textContent, 'Looking into it now, the build failed on the login redirect.')
})

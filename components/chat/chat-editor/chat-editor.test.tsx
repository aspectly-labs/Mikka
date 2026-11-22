import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, createRef, useState } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

// The chat composer's field as the TipTap chat editor (Alex, 2026-11-22): chips, the stored string, a long paste,
// a pasted image, IME, touch Enter, Up to recall, and drafts that outlive the window.

const task = '0f8fad5b-d9cb-469f-a165-70867728950e'
const uploaded = { id: '10000000-0000-4000-8000-000000000001', name: 'shot.png', mediaType: 'image/png', size: 12 }
let finishUpload: (() => void) | null = null
mock.module(new URL('../../../lib/chat-attachments/client.ts', import.meta.url).href, { namedExports: {
  ChatUploadError: class extends Error {},
  uploadChatFile: () => new Promise(resolve => { finishUpload = () => resolve(uploaded) }),
} })
mock.module(new URL('../../../app/actions/task-runs.ts', import.meta.url).href, { namedExports: {
  findThreadReferences: async () => [{ kind: 'task', id: task, title: 'MIK-12 Fix the login loop' }],
} })
mock.module(new URL('../../../hooks/use-thread-workspace.ts', import.meta.url).href, { namedExports: {
  useThreadWorkspace: (runId: string | null) => ({ data: runId ? { workspaceId: 'w', checkout: { runId, repoId: 'r' } } : null, loading: false, error: null }),
} })
mock.module(new URL('../../../lib/right-column/workspace-files.ts', import.meta.url).href, { namedExports: {
  searchFiles: async () => [{ path: 'src/app/page.tsx', name: 'page.tsx', kind: 'file', size: 1 }, { path: 'src/lib', name: 'lib', kind: 'directory', size: null }],
} })
mock.module('sonner', { namedExports: { toast: { error: () => {}, dismiss: () => {} } } })
mock.module('@/lib/intl/i18n-client', { namedExports: {
  useLocale: () => 'en',
  useTranslations: (namespace: string) => Object.assign((key: string, values?: Record<string, unknown>) => `${namespace}.${key}${values ? JSON.stringify(values) : ''}`, { has: () => true }),
} })

const browser = new Window({ url: 'https://mikka.test/' })
let coarse = false
let root: Root, container: HTMLDivElement
let createRoot: typeof import('react-dom/client').createRoot
let useChatComposer: typeof import('@/hooks/use-chat-composer').useChatComposer
let useChatEditor: typeof import('./use-chat-editor').useChatEditor
let ViewStateProvider: typeof import('@/lib/hooks/view-state').ViewStateProvider
let clearChatDrafts: typeof import('@/lib/chat-drafts').clearChatDrafts
let latest: { value: string; editor: ReturnType<typeof import('./use-chat-editor').useChatEditor>; state: ReturnType<typeof import('@/hooks/use-chat-composer').useChatComposer> }
let sent: string[] = []

before(async () => {
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'DocumentFragment', 'MutationObserver', 'ResizeObserver', 'getSelection', 'localStorage', 'sessionStorage', 'KeyboardEvent', 'Event', 'File', 'DOMParser', 'ClipboardEvent', 'DragEvent', 'CompositionEvent', 'InputEvent', 'Range'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && key === 'getSelection' ? (value as () => unknown).bind(browser) : value })
  }
  browser.matchMedia = ((query: string) => ({ matches: coarse && query.includes('coarse'), media: query, addEventListener() {}, removeEventListener() {} })) as never
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0), cancelAnimationFrame: (id: number) => clearTimeout(id),
  })
  URL.createObjectURL = () => 'blob:preview'
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useChatComposer } = await import('@/hooks/use-chat-composer'))
  ;({ useChatEditor } = await import('./use-chat-editor'))
  ;({ ViewStateProvider } = await import('@/lib/hooks/view-state'))
  ;({ clearChatDrafts } = await import('@/lib/chat-drafts'))
})
beforeEach(() => { sent = []; coarse = false; container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.close())

type Extra = Partial<Parameters<typeof useChatComposer>[0]>
function Chat({ initial = '', extra = {} }: { initial?: string; extra?: Extra }) {
  const [value, setValue] = useState(initial)
  const state = useChatComposer({ ref: createRef(), value, onChange: setValue, onSubmit: () => { sent.push(value); setValue('') }, label: 'Message', sendKey: 'enter', ...extra })
  const editor = useChatEditor(state, { label: 'Message', placeholder: 'Write' })
  latest = { value, editor, state }
  return <div>{editor.field}</div>
}
const settle = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
async function mount(initial = '', extra: Extra = {}) {
  await act(async () => root.render(<ViewStateProvider scope="owner:workspace"><Chat initial={initial} extra={extra} /></ViewStateProvider>))
  await settle()
  return latest.editor.editor!
}
const dom = () => latest.editor.editor!.view.dom
async function key(init: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean; keyCode?: number }) {
  const event = new browser.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  if (init.keyCode) Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  await act(async () => { dom().dispatchEvent(event as unknown as Event) })
  return event
}
/** Typing: text in at the caret, at the end of the field, as an input event puts it. */
async function type(text: string) {
  await act(async () => {
    const editor = latest.editor.editor!
    editor.commands.focus('end')
    editor.view.dispatch(editor.view.state.tr.insertText(text))
  })
}
async function paste(data: { text?: string; files?: File[] }) {
  const event = new browser.Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: (kind: string) => kind === 'text/plain' ? data.text ?? '' : '', files: data.files ?? [], types: data.files?.length ? ['Files'] : ['text/plain'], items: [] } })
  await act(async () => { dom().dispatchEvent(event as unknown as Event) })
}
const chips = () => Array.from(dom().querySelectorAll('[data-type="mention"], [data-chat-chip]')).map(node => node.getAttribute('data-kind') ?? node.getAttribute('data-chat-chip'))

test('a saved draft opens with its references as chips and is stored back unchanged', async () => {
  const stored = `fix [[issue:${task}]] then ping @Release Bot`
  await mount(stored, { references: { workspaceId: 'w' }, people: [{ id: 'b', name: 'Release Bot', kind: 'bot' }] })
  assert.deepEqual(chips(), ['task', 'bot'])
  await type(' now')
  assert.equal(latest.value, `${stored} now`)
})

test('@ finds tasks, people and files, and a picked row is one chip sent as its stored marker', async () => {
  await mount('', { references: { workspaceId: 'w', runId: 'run-1' }, people: [{ id: 'u', name: 'Ana', kind: 'person' }] })
  await type('@task:login')
  await settle(250)
  assert.deepEqual(latest.editor.menu?.sections.map(section => section.title), ['ThreadReferences.tasks'])
  await key({ key: 'Enter' })
  assert.equal(latest.value, `[[issue:${task}]] `)
  assert.equal(sent.length, 0, 'Enter picked the row; it did not send')
  await type('@An')
  await settle(250)
  assert.ok(latest.editor.menu?.sections.some(section => section.title === 'ChatEditor.people'))
  await key({ key: 'Enter' })
  await type('@page')
  await settle(250)
  const files = latest.editor.menu?.sections.find(section => section.title === 'ChatEditor.files')
  assert.deepEqual(files?.rows.map(row => row.kind), ['file', 'folder'])
  await act(async () => latest.editor.menu!.pick('directory:src/lib'))
  assert.equal(latest.value, `[[issue:${task}]] @Ana @src/lib/ `)
  assert.deepEqual(chips(), ['task', 'person', 'folder'])
})

test('Escape closes a menu without leaving the field or sending', async () => {
  await mount('', { references: { workspaceId: 'w' } })
  await type('@task:login')
  await settle(250)
  assert.ok(latest.editor.menu)
  const escape = await key({ key: 'Escape' })
  assert.equal(escape.defaultPrevented, true)
  assert.equal(latest.editor.menu, null)
})

test('Escape stops a run in a thread composer too, with or without words (decision 2026-11-22-1600)', async () => {
  let stops = 0
  await mount('Also check the dark theme', { running: true, thread: true, onStop: () => { stops++ } })
  assert.equal(latest.state.stoppable, false, 'typed words keep the button Send')
  const escape = await key({ key: 'Escape' })
  assert.equal(escape.defaultPrevented, true)
  assert.equal(stops, 1)
  assert.equal(latest.value, 'Also check the dark theme', 'the draft stays')
  await act(async () => root.render(<ViewStateProvider scope="owner:workspace"><Chat initial="" extra={{}} /></ViewStateProvider>))
  await settle()
  await key({ key: 'Escape' })
  assert.equal(stops, 1, 'with nothing running Esc stops nothing')
})

test('/ lists the chat’s commands; picking one runs it and clears the field', async () => {
  let ran = 0
  await mount('', { commands: [{ id: 'new', name: '/new', description: 'New chat', run: () => { ran++ } }] })
  globalThis.fetch = (async () => new Response(JSON.stringify({ skills: [{ id: 's', name: 'Deploy preview', slug: 'deploy-preview', enabled: true }] }))) as typeof fetch
  await type('/n')
  await settle(50)
  assert.deepEqual(latest.editor.menu?.sections[0].rows.map(row => row.label), ['/new'])
  await key({ key: 'Enter' })
  assert.equal(ran, 1)
  assert.equal(latest.value, '')
  await type('$deploy')
  await settle(50)
  await key({ key: 'Enter' })
  assert.equal(latest.value, '$deploy-preview ')
})

test('a long paste is one chip that sends its whole text; expanding puts the text back', async () => {
  await mount()
  const long = Array.from({ length: 40 }, (_, index) => `row ${index}`).join('\n')
  await paste({ text: long })
  assert.deepEqual(chips(), ['pasted'])
  assert.equal(latest.value, long)
  await paste({ text: 'short' })
  assert.equal(latest.value, `${long}short`)
  await act(async () => (dom().querySelector('[data-chat-chip="pasted"] button') as unknown as HTMLButtonElement).click())
  assert.deepEqual(chips(), [])
  assert.equal(latest.value, `${long}short`)
})

test('a pasted image is a chip in the field, uploads as a chat file, and leaves the strip', async () => {
  await mount('', { attachmentScope: { kind: 'bot', id: 'bot' } })
  await paste({ files: [new browser.File(['x'], 'shot.png', { type: 'image/png' }) as unknown as File] })
  assert.deepEqual(chips(), ['image'])
  assert.equal(latest.state.pending.length, 1, 'it uploads')
  assert.equal(latest.state.strip.pending.length, 0, 'the strip leaves out what the field draws')
  await act(async () => { finishUpload?.() })
  await settle()
  assert.match(latest.value, /^\[mikka-file:10000000-0000-4000-8000-000000000001:shot\.png\]/)
  assert.equal(latest.state.strip.files.length, 0)
})

test('Enter sends on a desktop, Shift+Enter is a new line, and an IME’s Enter never sends', async () => {
  await mount('hello')
  await act(async () => latest.editor.focus())
  // An IME composing: ProseMirror knows from compositionstart, and the key says so too (Safari's late 229 included).
  await act(async () => { dom().dispatchEvent(new browser.Event('compositionstart', { bubbles: true }) as unknown as Event) })
  await key({ key: 'Enter', isComposing: true })
  await act(async () => { dom().dispatchEvent(new browser.Event('compositionend', { bubbles: true }) as unknown as Event) })
  await key({ key: 'Enter', keyCode: 229 })
  assert.equal(latest.value, 'hello')
  assert.equal(sent.length, 0, 'composition Enter confirms the word')
  const shift = await key({ key: 'Enter', shiftKey: true })
  assert.equal(sent.length, 0)
  assert.equal(shift.defaultPrevented, true, 'the editor breaks the line itself')
  assert.equal(latest.value, 'hello\n')
  const enter = await key({ key: 'Enter' })
  assert.equal(enter.defaultPrevented, true)
  assert.deepEqual(sent, ['hello\n'])
})

test('on a touch keyboard Enter is a new line and never sends', async () => {
  coarse = true
  await mount('hello')
  await act(async () => latest.editor.focus())
  await key({ key: 'Enter' })
  assert.equal(sent.length, 0)
  assert.equal(latest.value, 'hello\n')
})

test('Up in an empty field recalls the earlier prompts of this thread; Down returns to the draft', async () => {
  await mount('', { historyKey: 'thread:a' })
  await type('first')
  await key({ key: 'Enter' })
  await type('second')
  await key({ key: 'Enter' })
  assert.deepEqual(sent, ['first', 'second'])
  await key({ key: 'ArrowUp' })
  assert.equal(latest.value, 'second')
  await key({ key: 'ArrowUp' })
  assert.equal(latest.value, 'first')
  await key({ key: 'ArrowDown' })
  await key({ key: 'ArrowDown' })
  assert.equal(latest.value, '')
  await type('typed')
  const up = await key({ key: 'ArrowUp' })
  assert.equal(up.defaultPrevented, false, 'a field with text keeps Up for the caret')
  assert.equal(latest.value, 'typed')
})

test('a draft outlives the window in localStorage, is cleared on send, capped in size and removed on logout', async () => {
  localStorage.clear(); sessionStorage.clear()
  const { createViewStore, DURABLE_MAX } = await import('@/lib/hooks/view-state')
  const store = createViewStore('owner:workspace')
  store.set('thread:a:draft', 'half a thought')
  store.set('thread:a:history', ['first'])
  store.set('thread:a:scroll', 12)
  assert.equal(createViewStore('owner:workspace').get('thread:a:draft', ''), 'half a thought', 'a new window reads it back')
  assert.equal(Object.keys(sessionStorage).some(key => key.endsWith('thread:a:draft')), false)
  assert.equal(Object.keys(localStorage).some(key => key.endsWith('thread:a:scroll')), false, 'other view state stays per window')
  store.set('thread:a:draft', '')
  assert.equal(Object.keys(localStorage).some(key => key.endsWith('thread:a:draft')), false, 'a sent draft leaves nothing behind')
  store.set('thread:a:draft', 'x'.repeat(DURABLE_MAX + 1))
  assert.equal(Object.keys(localStorage).some(key => key.endsWith('thread:a:draft')), false, 'past the cap it stays in this window only')
  clearChatDrafts()
  assert.equal(Object.keys(localStorage).length, 0, 'logout removes drafts and prompt history')
})

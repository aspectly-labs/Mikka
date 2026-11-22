import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'

const sharedId = '20000000-0000-4000-8000-000000000002'
const browser = new Window()
Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
Object.assign(globalThis, { requestAnimationFrame: browser.requestAnimationFrame.bind(browser) })

mock.module('@/lib/intl/i18n-client', { namedExports: { useLocale: () => 'en', useTranslations: () => (key: string) => key, useFormatter: () => ({}) } })
mock.module(new URL('../../app/actions/task-runs.ts', import.meta.url).href, { namedExports: { findThreadReferences: async () => [
  { kind: 'thread', conversationKind: 'chat', id: sharedId, title: 'Standalone conversation' },
  { kind: 'thread', id: sharedId, title: 'Execution run' },
] } })
const { PersonReferences } = await import('./thread-references')
const { ConversationReferenceTitles, conversationReferenceTitles } = await import('./conversation-reference-titles')

test('links in a person’s message follow authorized titles after a rename and forget them on workspace or identity changes', async () => {
  const root = createRoot(document.body)
  const title = (run: string, chat: string, viewer = 'owner', workspace = 'team') => conversationReferenceTitles(viewer, workspace, {
    live: { ownerId: 'owner', workspaceId: 'team' }, items: [{ id: sharedId, title: run }],
  }, viewer === 'owner' ? [{ id: sharedId, workspaceId: 'team', creationPurpose: 'conversation', title: chat, createdAt: '', lastMessage: null }] : [])
  const render = async (names: ReadonlyMap<string, string>) => {
    await act(async () => root.render(<ConversationReferenceTitles value={names}><PersonReferences text={`[[run:${sharedId}]] and [[chat:${sharedId}]]`} /></ConversationReferenceTitles>))
    return [...document.body.querySelectorAll('a')].map(a => a.textContent)
  }
  try {
    assert.deepEqual(await render(title('Earlier run', 'Earlier conversation')), ['Earlier run', 'Earlier conversation'])
    assert.deepEqual(await render(title('Renamed run', 'Renamed conversation')), ['Renamed run', 'Renamed conversation'])
    const fallback = ['thread ' + sharedId.slice(0, 8), 'thread ' + sharedId.slice(0, 8)]
    assert.deepEqual(await render(title('Private run', 'Private conversation', 'owner', 'other')), fallback)
    assert.deepEqual(await render(title('Private run', 'Private conversation', 'member')), fallback)
  } finally { await act(async () => root.unmount()) }
})

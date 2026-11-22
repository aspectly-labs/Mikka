import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, useRef, useState } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { Textarea } from '@/components/ui/textarea'
import type { ChatComposerProps } from '@/components/slots/chat-composer-contract'
import * as live from '@/hooks/use-live-key'
import type { GroupExchange, GroupMember, GroupMessage, GroupMessagePage } from '@/lib/group-messages'

let pages: GroupMessagePage[] = []
let hasMemberPage = true
let groupMembers: GroupMember[] = []
let membersError: Error | undefined
const exchangeReads: string[] = []
const lastThreadScreen = () => threadFixture?.lastThreadScreen
mock.module('@/lib/intl/i18n-client', { namedExports: { useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
  useMessages: () => ({ AgentCopy: {} }),
  useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
} })
const infinite: { config?: Record<string, unknown> } = {}
const liveKeys: unknown[][] = []
const refreshed: unknown[] = []
let headerTitleChanged: (() => void) | undefined
mock.module('swr', { defaultExport: (key: unknown) => {
  if (Array.isArray(key) && key[0] === 'group-exchange') {
    exchangeReads.push(key[1])
    return { data: { messages: [{ id: 'exchange-message', position: '1', body: 'Linked exchange transcript', author: { id: 'agent', memberType: 'agent', name: 'Agent' } }] } }
  }
  return { data: undefined }
}, namedExports: { useSWRConfig: () => ({ mutate: async (key: unknown) => { refreshed.push(key) } }), unstable_serialize: (key: unknown) => JSON.stringify(key) } })
mock.module('swr/infinite', {
  defaultExport: (_key: unknown, _fetcher: unknown, config: Record<string, unknown>) => { infinite.config = config; return { data: pages, size: 1, setSize: async () => {}, mutate: async () => {}, isValidating: false } },
  namedExports: { unstable_serialize: (getKey: (index: number, previous: null) => unknown) => '$inf$' + JSON.stringify(getKey(0, null)) },
})
mock.module(new URL('../../hooks/use-live-key.tsx', import.meta.url).href, { namedExports: {
  ...live,
  useLiveKey: (...args: unknown[]) => { liveKeys.push(args) },
} })
mock.module(new URL('../../app/actions/agents.ts', import.meta.url).href, { namedExports: { listAgents: async () => [] } })
mock.module(new URL('../../app/actions/link-preview.ts', import.meta.url).href, { namedExports: { getLinkPreview: async () => null, getLinkPreviews: async () => ({}) } })
mock.module(new URL('../../lib/hooks/view-state.tsx', import.meta.url).href, { namedExports: {
  useViewState: <T,>(_key: string, initial: T) => useState(initial),
  useViewScroll: () => useRef(null),
} })
mock.module(new URL('../../app/actions/task-runs.ts', import.meta.url).href, { namedExports: { findThreadReferences: async () => [{ kind: 'task', id: issueId, title: 'Authorized task' }] } })
mock.module(new URL('./thread-header.tsx', import.meta.url).href, { namedExports: { ThreadHeader: ({ onTitleChanged }: { onTitleChanged?: () => void }) => { headerTitleChanged = onTitleChanged; return null } } })
mock.module(new URL('../coordinator/bot-model-picker.tsx', import.meta.url).href, { namedExports: { BotModelPicker: ({ botId, running }: { botId: string; running: boolean }) => <span aria-label="Fixture Bot model">{botId} {running ? 'next message' : 'current'}</span> } })
mock.module(new URL('../coordinator/chat-composer.tsx', import.meta.url).href, { namedExports: { ChatComposerAttachment: () => null, ChatComposer: ({ ref, value, onChange, leftControls }: ChatComposerProps) => <>{leftControls}<Textarea ref={ref} value={value} onChange={event => onChange(event.currentTarget.value)} /></> } })
mock.module(new URL('../nav/conversation-pill.tsx', import.meta.url).href, { namedExports: { ConversationPill: () => null } })
mock.module(new URL('../nav/group-avatar.tsx', import.meta.url).href, { namedExports: { GroupAvatar: () => null, groupMembersKey: (id: string) => ['group-members', id], memberAvatar: (member: { id: string }) => ({ id: member.id }), useGroupMembers: () => ({ data: hasMemberPage ? groupMembers : undefined, error: membersError }) } })
mock.module(new URL('../nav/letter-avatar.tsx', import.meta.url).href, { namedExports: { LetterAvatar: () => null } })
mock.module(new URL('../nav/bot-avatar.tsx', import.meta.url).href, { namedExports: { BotAvatar: () => null } })
mock.module(new URL('./message-reactions.tsx', import.meta.url).href, { namedExports: { MessageReactions: () => null, useMessageReactions: () => ({}) } })

const browser = new Window({ url: 'https://mikka.test/mikka' })
let root: Root, container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let GroupChatView: typeof import('./group-chat-view')['GroupChatView']
const issueId = '00000000-0000-4000-8000-000000000010'
const runId = '00000000-0000-4000-8000-000000000020'
const taskHref = '/mikka?issue=' + issueId
const threadHref = taskHref + '&thread=' + runId
const handoff = '任务已交给 Factory。\n[Task](' + taskHref + ')\n[Thread](' + threadHref + ') · [成果与验证证据](' + threadHref + ')'
const message = (authorType: GroupMessage['authorType'], position: number, body: string): GroupMessage => ({
  id: 'message-' + position, conversationId: 'group', position: String(position),
  authorType, authorId: authorType === 'user' ? 'owner' : authorType,
  body, mentions: [], replyToId: null, createdAt: '2026-11-04T18:00:00.000Z',
})

mock.module(new URL('./agent-theme.tsx', import.meta.url).href, { namedExports: { AgentThemeProvider: ({ children }: { children: import('react').ReactNode }) => children } })
// The official thread screen, as a public fixture that paints its props (tests/support/thread-screen-fixture.tsx).
let threadFixture: typeof import('../../tests/support/thread-screen-fixture') | undefined
mock.module(new URL('../slots/thread.tsx', import.meta.url).href, { namedExports: {
  ThreadScreen: (props: import('../slots/thread-contract').ThreadScreenProps) => { const Screen = threadFixture!.FixtureThreadScreen; return <Screen {...props} /> },
} })

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, IntersectionObserver: browser.IntersectionObserver, requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) })
  ;({ createRoot } = await import('react-dom/client'))
  threadFixture = await import('../../tests/support/thread-screen-fixture')
  ;({ GroupChatView } = await import('./group-chat-view'))
})
beforeEach(() => { container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.close())

const render = async (messages: GroupMessage[]) => {
  pages = [{ messages, nextBefore: null, agentStatus: null }]
  await act(async () => root.render(<GroupChatView group={{ id: 'group', title: 'Fixture group', workspaceId: 'workspace' }} userId="owner" people={new Map()} />))
}

test('Factory task and thread references in bot and agent replies are real links; sent user text keeps its existing rendering', async () => {
  await render([message('user', 1, handoff), message('bot', 2, handoff), message('agent', 3, handoff)])
  const replies = [...container.querySelectorAll('ol[aria-label="messages"] > li')].slice(1)
  assert.equal(replies.length, 2)
  for (const reply of replies) {
    assert.deepEqual([...reply.querySelectorAll('a')].map(link => ({ text: link.textContent, href: link.getAttribute('href') })), [
      { text: 'Task', href: taskHref }, { text: 'Thread', href: threadHref }, { text: '成果与验证证据', href: threadHref },
    ])
    assert.equal(reply.textContent?.includes('[Task]('), false)
  }
  const ownText = container.querySelector('[data-slot="user-message-text"]')!
  assert.equal(ownText.textContent, handoff)
  assert.equal(ownText.querySelector('a'), null)
})

test('a committed named chat title revalidates only the group list supplying the current viewer and workspace', async () => {
  const { botKeys } = await import('@/lib/swr/keys')
  pages = [{ messages: [], nextBefore: null, readRevision: 0 }]
  for (const [owner, workspace] of [['owner-a', 'workspace-a'], ['owner-b', 'workspace-b']]) {
    await act(async () => root.render(<GroupChatView group={{ id: 'same-chat-id', title: 'Chat', workspaceId: workspace, creationPurpose: 'conversation' }} userId={owner} people={new Map()} />))
    refreshed.length = 0
    assert.ok(headerTitleChanged)
    await act(async () => headerTitleChanged?.())
    assert.deepEqual(refreshed, [botKeys.groups(owner, workspace)])
  }
})

test('group replies use the existing Markdown HTML and URL protections', async () => {
  await render([message('bot', 1, '<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n' + handoff)])
  const reply = container.querySelector('ol[aria-label="messages"] > li')!
  assert.ok(reply)
  assert.equal(reply.querySelector('script'), null)
  assert.equal(reply.querySelector('a[href^="javascript:"]'), null)
  assert.deepEqual([...reply.querySelectorAll('a[href]')].filter(link => link.getAttribute('href')).map(link => link.getAttribute('href')), [taskHref, threadHref, threadHref])
})

test('anchored exchanges follow their author run once and open the linked transcript', async () => {
  const exchange: GroupExchange = { type: 'agent_exchange', linkId: 'linked-exchange', anchorPosition: '1', count: '2', participants: [{ id: 'agent', name: 'Agent', harness: 'codex', avatarUrl: null }] }
  pages = [
    { messages: [message('bot', 3, 'Later reply')], timeline: [exchange], nextBefore: '3' },
    { messages: [message('user', 1, 'Anchor message'), message('user', 2, 'Same author run')], timeline: [exchange], nextBefore: null },
  ]
  exchangeReads.length = 0
  await act(async () => root.render(<GroupChatView group={{ id: 'group', title: 'Fixture group', workspaceId: 'workspace' }} userId="owner" people={new Map()} />))
  const list = container.querySelector('ol[aria-label="messages"]')!
  const rows = [...list.children]
  assert.deepEqual(rows.map(row => row.getAttribute('data-entry')), ['message-1', 'message-2', 'exchange:linked-exchange', 'message-3'], 'the exchange is a line of its own after its anchor\'s run of messages')
  assert.equal(lastThreadScreen()?.entries?.find(entry => entry.id === 'exchange:linked-exchange')?.role === 'bot' && (lastThreadScreen()!.entries!.find(entry => entry.id === 'exchange:linked-exchange') as { event?: true }).event, true, 'a line about the chat, with no author')
  const marker = rows[2].querySelector('button')!
  assert.ok(marker, 'the exchange marker is available to group members')
  assert.equal(list.querySelector('li li'), null, 'the marker does not nest list items')
  assert.deepEqual(exchangeReads, [], 'closed exchange transcripts are not read')
  await act(async () => marker.click())
  assert.ok(exchangeReads.length > 0)
  assert.ok(exchangeReads.every(linkId => linkId === exchange.linkId))
  assert.match(document.body.textContent ?? '', /Linked exchange transcript/)
  membersError = Object.assign(new Error('membership removed'), { status: 403 })
  try {
    await act(async () => root.render(<GroupChatView group={{ id: 'group', title: 'Fixture group', workspaceId: 'workspace' }} userId="owner" people={new Map()} />))
    assert.equal(container.querySelector('ol[aria-label="messages"]'), null, 'refused membership hides the anchored exchange along with its messages')
    assert.doesNotMatch(document.body.textContent ?? '', /Linked exchange transcript/)
  } finally { membersError = undefined }
})

test('another person\'s messages are the thread\'s messages under their author line, in plain text', async () => {
  await render([1, 2].map(position => ({ ...message('user', position, handoff), authorId: 'peer' })))
  const entries = lastThreadScreen()!.entries!
  assert.deepEqual(entries.map(entry => entry.role === 'bot' ? entry.author?.id : null), ['user:peer', 'user:peer'], 'one author, so the thread names them once')
  const rows = [...container.querySelectorAll('ol[aria-label="messages"] > li')]
  assert.equal(container.querySelectorAll('[data-slot="group-author"]').length, 1)
  const words = [...container.querySelectorAll('[data-slot="user-message-text"]')]
  assert.equal(rows.length, 2)
  assert.equal(words.length, 2)
  for (const text of words) {
    assert.equal(text.textContent, handoff)
    assert.equal(text.querySelector('a'), null)
  }
})

test('the chat reads its newest page and members on the group key, never on a timer (#1212)', async () => {
  liveKeys.length = 0
  pages = [{ messages: [message('user', 1, 'hello')], nextBefore: null, agentStatus: { status: 'running' } }]
  await act(async () => root.render(<GroupChatView group={{ id: 'group', title: 'Fixture group', workspaceId: 'workspace' }} userId="owner" people={new Map()} />))
  assert.equal(infinite.config?.refreshInterval, undefined, 'a bot answering is no reason to poll')
  const [kind, id, keys, workspaceId] = liveKeys.at(-1)!
  assert.equal(kind, 'group_chat')
  assert.equal(id, 'group')
  assert.deepEqual(keys, ['$inf$' + JSON.stringify(['group-messages', 'group', null]), JSON.stringify(['group-members', 'group'])])
  assert.equal(workspaceId, 'workspace', 'the key arrives on the group workspace channel')
})

test('named conversations show canonical authored links and use their authorized picker while ordinary groups retain plain task markers', async () => {
  const body = 'See [[issue:' + issueId + ']] and [[chat:' + runId + ']]'
  pages = [{ messages: [message('user', 1, body)], nextBefore: null, readRevision: 0 }]
  const group = { id: 'group', title: 'Chat', workspaceId: 'workspace' }
  const draw = (purpose: 'group' | 'conversation') => root.render(<GroupChatView group={{ ...group, creationPurpose: purpose }} userId="owner" people={new Map()} />)
  await act(async () => draw('conversation'))
  const links = [...container.querySelectorAll('[data-slot="user-message-text"] a')]
  assert.equal(links.length, 2)
  assert.ok(links[0].getAttribute('href')?.includes(issueId))
  assert.ok(links[1].getAttribute('href')?.includes('group=' + runId))
  const input = container.querySelector('textarea')!
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')!.set!
  setValue.call(input, '@task:authorized')
  await act(async () => input.dispatchEvent(new browser.Event('input', { bubbles: true }) as never))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 230)) })
  const candidate = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Authorized task'))
  assert.ok(candidate)
  await act(async () => candidate.click())
  assert.equal(input.value, '[[issue:' + issueId + ']] ')
  await act(async () => draw('group'))
  assert.equal(container.querySelector('[data-slot="user-message-text"]')?.textContent, body)
  assert.equal(container.querySelector('[data-slot="user-message-text"] a'), null)
  await act(async () => draw('conversation'))
  membersError = Object.assign(new Error('membership removed'), { status: 403 })
  try {
    await act(async () => draw('conversation'))
    assert.equal(container.querySelector('[data-slot="user-message-text"] a'), null)
    assert.equal(container.querySelector('[role="group"][aria-label="references"]'), null)
    assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes('notFound'))
    membersError = Object.assign(new Error('membership lookup unavailable'), { status: 503 })
    await act(async () => draw('conversation'))
    assert.equal(Boolean(container.querySelector('[data-slot="user-message-text"]')), false, 'a successful messages read cannot restore a refused membership read')
    assert.equal(container.querySelector('[role="group"][aria-label="references"]'), null)
    membersError = undefined
    hasMemberPage = false
    await act(async () => draw('conversation'))
    assert.equal(Boolean(container.querySelector('[data-slot="user-message-text"]')), false, 'a pending membership read cannot restore access')
    hasMemberPage = true
    await act(async () => draw('conversation'))
    assert.equal(container.querySelectorAll('[data-slot="user-message-text"] a').length, 2)
  } finally { membersError = undefined; hasMemberPage = true }
})

test('the named conversation mounts the existing picker for the sole or explicitly addressed owned Bot', async () => {
  const bot: GroupMember = { memberType: 'bot', id: 'owned', name: 'Owned Bot' }
  const actor: GroupMember = { memberType: 'agent', id: 'agent', name: 'Agent' }
  const person: GroupMember = { memberType: 'user', id: 'owner', name: 'Owner' }
  const group = { id: 'group', title: 'Chat', workspaceId: 'workspace' }
  const draw = (purpose: 'group' | 'conversation', roster: {id: string}[]) =>
    act(async () => root.render(<GroupChatView group={{ ...group, creationPurpose: purpose }} userId="owner" people={new Map()} ownedBots={roster} />))
  const chip = () => container.querySelector('[aria-label="Fixture Bot model"]')
  pages = [{ messages: [], nextBefore: null, readRevision: 0, agentStatus: { status: 'running' } }]
  try {
    groupMembers = [person, bot]
    await draw('conversation', [bot])
    assert.equal(chip()?.textContent, 'owned next message')
    await draw('group', [bot])
    assert.equal(chip(), null)
    await draw('conversation', [])
    assert.equal(chip(), null)
    for (const others of [[bot, actor], [bot, { ...bot, id: 'second' }], [actor]]) {
      groupMembers = [person, ...others]
      await draw('conversation', [bot])
      assert.equal(chip(), null)
    }
    const second: GroupMember = { memberType: 'bot', id: 'second', name: 'Second Bot' }
    groupMembers = [person, bot, actor, second]
    await draw('conversation', [bot, second])
    const input = container.querySelector('textarea')!
    const setValue = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')!.set!
    const type = async (value: string) => {
      setValue.call(input, value)
      await act(async () => input.dispatchEvent(new browser.Event('input', { bubbles: true }) as never))
    }
    await type('@Owned Bot tell me what changed')
    assert.equal(chip()?.textContent, 'owned next message')
    await type('@sECOND Bot check this')
    assert.equal(chip()?.textContent, 'second next message')
    await draw('conversation', [bot])
    assert.equal(chip(), null, 'the second Bot belongs to another user')
    await draw('conversation', [bot, second])
    for (const draft of ['@Owned Bot and @Second Bot', '@Agent', 'hello', '[[chat:' + runId + ']]']) {
      await type(draft)
      assert.equal(chip(), null)
    }
    await type('@Owned Bot hello')
    await draw('group', [bot, second])
    assert.equal(chip(), null, 'the ordinary group keeps its existing composer')
    groupMembers = [person, bot]
    membersError = new (await import('@/lib/group-messages')).GroupMessagesRequestError('not_found', 403)
    await draw('conversation', [bot])
    assert.equal(chip(), null)
  } finally { groupMembers = []; membersError = undefined }
})

test('the group is the Bot chat\'s thread: the person\'s messages are theirs, everyone else\'s carry an author, as LobeHub\'s group chat', async () => {
  groupMembers = [{ id: 'bot', name: 'Design Bot', memberType: 'bot' }, { id: 'agent', name: 'Build Agent', memberType: 'agent' }]
  await render([message('user', 1, 'Who checks this?'), message('bot', 2, 'I will'), message('user', 3, 'Thanks'), message('bot', 4, 'Done'), message('agent', 5, 'Checks are green')])
  const screen = lastThreadScreen()!
  assert.equal(screen.modelPicker, false, 'a group has no Bot of its own to pick a model for')
  assert.deepEqual(screen.entries!.map(entry => entry.role === 'person' ? 'person' : `${entry.author?.name}${entry.author?.quiet ? ' (quiet)' : ''}`),
    ['person', 'Design Bot', 'person', 'Design Bot', 'Build Agent'], 'every reply names its author; none is quiet in a group')
  const sender = (row: Element) => row.querySelector('[data-slot="group-author"]')?.textContent ?? null
  assert.deepEqual([...container.querySelectorAll('ol[aria-label="messages"] > li')].map(sender), [null, 'Design Bot', null, 'Design Bot', 'Build Agent'])
  groupMembers = []
})

test('every group message\'s line waits for hover and focus, as the Bot chat\'s (decision 2026-11-22-1500)', async () => {
  const { HOVER_ACTIONS } = await import('@/components/chat/copy-action')
  await render([message('user', 1, 'Mine'), message('bot', 2, 'Reply')])
  const lines = [...container.querySelectorAll('ol[aria-label="messages"] > li')].map(row => row.querySelector('[data-slot="message-actions"]')!)
  assert.equal(lines.length, 2)
  for (const line of lines) for (const name of HOVER_ACTIONS.split(' ')) assert.ok(line.classList.contains(name), name)
  assert.equal(lines[1].querySelector('time'), null, 'a reply\'s author line already says when')
})

test('before its first page the group shows every chat\'s one skeleton, not a list of its own', async () => {
  pages = undefined as unknown as GroupMessagePage[]
  await act(async () => root.render(<GroupChatView group={{ id: 'group', title: 'Fixture group', workspaceId: 'workspace' }} userId="owner" people={new Map()} />))
  assert.ok(container.querySelector('[data-loading-placeholder]'), 'ConversationPageLoading')
  assert.equal(container.querySelector('ol'), null)
  assert.equal(container.querySelector('textarea'), null, 'the thread screen comes with the first page')
})

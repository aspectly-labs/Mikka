'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useSWRInfinite, { unstable_serialize as infiniteKey } from 'swr/infinite'
import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { listAgents } from '@/app/actions/agents'
import { ChatComposerAttachment } from '@/components/coordinator/chat-composer'
import { ThreadScreen } from '@ui-slot/thread'
import type { ThreadEntry } from '@/components/slots/thread-contract'
import { AgentThemeProvider } from '@/components/workspace/agent-theme'
import { ConversationPageLoading } from '@/components/workspace/workspace-loading'
import { navigate, openTask } from '@/components/workspace/workspace-navigation'
import { BotModelPicker } from '@/components/coordinator/bot-model-picker'
import { namedConversationModelBot } from '@/lib/named-conversation-model'
import { Button } from '@/components/ui/button'
import { GroupLeaveAction } from './group-leave-action'
import { botKeys } from '@/lib/swr/keys'
import { withBasePath } from '@/lib/base-path'
import { PersonReferences } from './thread-references'
import { VisibleReadEnd } from './visible-read-end'
import { ThreadHeader } from './thread-header'
import { ConversationPill } from '@/components/nav/conversation-pill'
import { FRAME_OWNS_HEADER } from '@/components/app-shell'
import { GroupAvatar, groupMembersKey, memberAvatar, useGroupMembers } from '@/components/nav/group-avatar'
import { useLiveKey } from '@/hooks/use-live-key'
import { LetterAvatar } from '@/components/nav/letter-avatar'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { UserMessageText } from '@/components/workspace/user-message-text'
import { CollapsibleMessage } from '@/components/chat/collapsible-message'
import { AgentMarkdown } from '@/components/workspace/agent-markdown'
import { MessageReactions, useMessageReactions } from '@/components/workspace/message-reactions'
import { ReplyActions } from '@/components/chat/reply-actions'
import { mentionsIn } from '@/lib/group-mentions'
import { chronological, fetchGroupMessages, mergeGroupPoll, mayLeaveGroup, newestGroupPosition, GroupMessagesRequestError, postGroupMessage, stopGroupReply, type GroupExchange, type GroupMessagePage } from '@/lib/group-messages'
import { AgentExchangeMarker } from './agent-exchange'
import { toast } from 'sonner'
import { useViewState } from '@/lib/hooks/view-state'
import { isWebChatOffline, useChatDelivery, type ChatSubmission } from '@/lib/hooks/chat-delivery'
import { checkPageBuildBeforeAction } from '@/lib/app-build'
import { groupSubmissionMessageId } from '@/lib/group-submission'
import { useActionError } from '@/lib/use-action-error'
import { readAccessFailure } from '@/lib/swr/persistent-cache'

/** A message the person sent that the server has not stored yet; a failed one waits for 重试. */
type GroupSend = ChatSubmission & { mentions: ReturnType<typeof mentionsIn> }

/** The newest page and the members re-read on the group's live key, at most this often while a reply streams in. */
const GROUP_MERGE_MS = 500

/** The newest page's key, then each older page before the last one shown. */
const pageKey = (groupId: string) => (index: number, previous: GroupMessagePage | null) => index === 0 ? ['group-messages', groupId, null] : previous?.nextBefore ? ['group-messages', groupId, previous.nextBefore] : null

export type GroupChatRequest = { id: string; title: string; workspaceId: string; creationPurpose?: 'group' | 'conversation' }

/**
 * A group chat. It reads and sends through the group API (the phone's path),
 * which checks workspace and group membership on every request. A message goes
 * to the bots it @mentions, else to the ones the server judges should answer;
 * it shows at once and, if it fails, stays with 重试. A stored message, a
 * member change or the reply starting or ending pushes the group's key; no
 * timer reads it (#1212). Names and bot avatars come from the
 * group's member list, then the workspace's members and the person's agents.
 */
export function GroupChatView({ group, userId, people, ownedBots, onLeft }: {
  ownedBots?: readonly { id: string }[]
  group: GroupChatRequest
  onLeft?: (id: string) => void
  userId: string
  /** Display names of the group's workspace members, when that workspace is the loaded one. */
  people: Map<string, string>
}) {
  const t = useTranslations('GroupChat')
  const composerInput = useRef<HTMLTextAreaElement>(null)
  const titleHeading = useRef<HTMLHeadingElement>(null)
  const { mutate: refreshCache } = useSWRConfig()
  const namedChat = group.creationPurpose === 'conversation'
  const feedback = useTranslations('Coordinator')
  const { data: agents = [] } = useSWR('agents', listAgents)
  // The pill's avatar is the members' bloubs (R-36); the right column's 详情 reads the same request.
  const { data: memberPage, error: membersError } = useGroupMembers(group.id)
  const members = memberPage ?? []
  const member = (type: 'user' | 'agent' | 'bot', id: string) => members.find(item => item.memberType === type && item.id === id)
  const [draft, setDraft] = useViewState(`group:${group.id}:draft`, '')
  // Navigation keeps unsent text and the same in-flight promise's result; it never resends.
  const delivery = useChatDelivery<GroupSend>(`group:${userId}:${group.workspaceId}:${group.id}`, feedback('sendUncertain'))
  const submittedDraft = useRef<string | null>(null)
  // A message the person sent keeps its submission id as its row id once stored, so the thread does not remount it.
  const [sentAs, setSentAs] = useState<Record<string, string>>({})
  const sentStored = useCallback((submission: string, stored: string) => setSentAs(current => current[stored] === submission ? current : { ...current, [stored]: submission }), [])
  const [messagesRejected, setMessagesRejected] = useState(false)
  const [membersRejected, setMembersRejected] = useState(false)
  const departed = useRef(false)
  const shown = useRef<{ id: string; page: GroupMessagePage } | null>(null)
  const { data: pages, error, size, setSize, isValidating, mutate } = useSWRInfinite<GroupMessagePage>(
    pageKey(group.id),
    async ([, id, before]: [string, string, string | null]) => {
      if (before) return fetchGroupMessages(id, before)
      const known = shown.current?.id === id ? shown.current.page : null
      const after = known ? newestGroupPosition(known.messages) : null
      const page = await fetchGroupMessages(id, null, fetch, after)
      const merged = mergeGroupPoll(known, page)
      shown.current = { id, page: merged }
      return merged
    },
    // The first page carries new messages and who is answering; it is read again when the group's key arrives.
    { revalidateOnFocus: false },
  )
  // While the live channel is down, the live layer falls back to one read a minute.
  // Only the pages hold the group's revision (its newest page); the members always read.
  const pagesKey = infiniteKey(pageKey(group.id))
  useLiveKey('group_chat', group.id, [pagesKey, unstable_serialize(groupMembersKey(group.id))], group.workspaceId, { minIntervalMs: GROUP_MERGE_MS, revisions: { [pagesKey]: pages?.[0]?.revision } })
  const messages = useMemo(() => pages ? chronological(pages) : [], [pages])
  const exchanges = useMemo(() => {
    const byAnchor = new Map<string, GroupExchange[]>()
    for (const page of pages ?? []) for (const item of page.timeline ?? []) {
      if (item.type !== 'agent_exchange') continue
      const list = byAnchor.get(item.anchorPosition) ?? []
      if (!list.some(link => link.linkId === item.linkId)) list.push(item)
      byAnchor.set(item.anchorPosition, list)
    }
    return byAnchor
  }, [pages])
  const receivedIds = useMemo(() => new Set(messages.map(message => message.id)), [messages])
  useEffect(() => {
    if (delivery.rows.some(row => row.storedId && receivedIds.has(row.storedId))) delivery.setRows(current => current.filter(row => !row.storedId || !receivedIds.has(row.storedId)))
  }, [delivery.rows, delivery.setRows, receivedIds])
  const reactions = useMessageReactions(messages.map(message => message.id))
  const older = pages?.at(-1)?.nextBefore ?? null
  const loadingOlder = isValidating && !!pages && size > pages.length
  const code = error instanceof GroupMessagesRequestError ? error.code : error ? 'unavailable' : null
  const messageDenial = readAccessFailure(error)
  const memberDenial = readAccessFailure(membersError)
  const refused = !!(messageDenial || memberDenial)
  // Each read must recover its own permission decision. An outage on either
  // read keeps its previous refusal even when the other resource reads successfully.
  useEffect(() => {
    if (messageDenial) setMessagesRejected(true)
    else if (!error && pages) setMessagesRejected(false)
  }, [messageDenial, error, pages])
  useEffect(() => {
    if (memberDenial) setMembersRejected(true)
    else if (!membersError && memberPage) setMembersRejected(false)
  }, [memberDenial, membersError, memberPage])
  const accessRejected = messagesRejected || membersRejected
  const backgroundFailed = !!pages && code === 'unavailable' && !refused && !accessRejected
  const accessCode = memberDenial || accessRejected ? 'not_found' : null
  const blockingCode = code === 'unauthorized' ? code : accessCode ?? (backgroundFailed ? null : code)
  // A failed background read leaves the transcript and composer in place.
  // Keep its retry outside document flow so reading history does not jump.
  useEffect(() => {
    const id = `group-read-error:${userId}:${group.id}`
    if (backgroundFailed) toast.error(t('loadError'), { id, duration: Infinity, action: { label: t('retry'), onClick: event => { event.preventDefault(); void mutate() } } })
    else toast.dismiss(id)
    return () => { toast.dismiss(id) }
  }, [backgroundFailed, userId, group.id, t, mutate])
  const deliver = async (item: GroupSend, release?: () => void) => {
    if (departed.current || blockingCode || accessRejected || refused || !delivery.begin(item)) return
    release?.()
    try {
      if (isWebChatOffline()) { delivery.finish(item.id, { error: feedback('sendOffline') }); return }
      if (!await checkPageBuildBeforeAction()) { delivery.finish(item.id, { error: feedback('sendUpdateRequired') }); return }
      if (departed.current) { delivery.finish(item.id, {}); return }
      void groupSubmissionMessageId(userId, group.id, item.id).then(storedId => {
        delivery.setRows(current => current.map(row => row.id === item.id && !row.storedId ? { ...row, storedId } : row))
        sentStored(item.id, storedId)
      }).catch(() => undefined)
      const sent = await postGroupMessage(group.id, item.text, item.mentions, fetch, { requestId: item.id, expectedOwnerId: userId, expectedWorkspaceId: group.workspaceId })
      delivery.finish(item.id, { storedId: sent.id })
      sentStored(item.id, sent.id)
      if (!departed.current) void mutate().catch(() => undefined)
    } catch (error) {
      const status = error instanceof GroupMessagesRequestError ? error.status : undefined
      const reason = status === 429 ? feedback('sendRateLimited') : status && [401, 403, 404].includes(status) ? feedback('sendAccessDenied')
        : status && status < 500 ? t('notSent') : feedback('sendUncertain')
      delivery.finish(item.id, { error: reason })
    }
  }
  const send = () => {
    const text = draft.trim()
    if (!text || submittedDraft.current === draft) return
    const id = crypto.randomUUID()
    void deliver({ id, at: Date.now(), text, mentions: mentionsIn(text, members) }, () => {
      submittedDraft.current = draft
      setDraft('')
    })
  }
  const first = pages?.[0]
  const readRevision = first?.readRevision
  const referenceWorkspace = namedChat && readRevision !== undefined && !blockingCode && !accessRejected && !refused && !departed.current ? group.workspaceId : null
  const modelBot = namedConversationModelBot(referenceWorkspace && !membersError && !error ? referenceWorkspace : null, members, ownedBots, draft)
  // `@` names the group's members in the composer; a Bot named so answers (lib/group-mentions.ts).
  const mentionable = useMemo(() => members.filter(item => item.memberType !== 'user' || item.id !== userId)
    .map(item => ({ id: item.id, name: item.name || (item.memberType === 'user' ? people.get(item.id) ?? '' : ''), kind: item.memberType === 'user' ? 'person' as const : 'bot' as const }))
    .filter(item => item.name), [members, userId, people])
  const referenceText = referenceWorkspace ? (text: string, index: number) => <PersonReferences key={index} text={text} /> : undefined
  const lastMessageId = messages.at(-1)?.id ?? null
  const sentRead = useRef<string | null>(null)
  const acknowledge = useCallback(() => {
    if (readRevision === undefined) return
    const key = JSON.stringify([group.id, lastMessageId, readRevision])
    if (sentRead.current === key) return
    sentRead.current = key
    void fetch(withBasePath(`/api/conversations/${group.id}/read`), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: lastMessageId, readRevision }),
    }).then(response => {
      if (!response.ok && sentRead.current === key) sentRead.current = null
    }).catch(() => { if (sentRead.current === key) sentRead.current = null })
  }, [group.id, lastMessageId, readRevision])
  // 停止: the reply ends on the server; the button waits until the group stops answering.
  const actionError = useActionError()
  const [stopping, setStopping] = useState(false)
  const replying = !!first?.agentStatus
  useEffect(() => { if (!replying) setStopping(false) }, [replying])
  const stop = async () => {
    setStopping(true)
    try { await stopGroupReply(group.id) } catch { setStopping(false); toast.error(actionError()) }
    await mutate()
  }
  const unsent = delivery.rows.filter(item => !item.storedId || !receivedIds.has(item.storedId))
  const authorName = (type: 'user' | 'agent' | 'bot', id: string) => type === 'user'
    ? id === userId ? t('you') : member(type, id)?.name || people.get(id) || t('member')
    : member(type, id)?.name ?? (type === 'agent' ? agents.find(agent => agent.id === id)?.name : undefined) ?? t('bot')
  const title = group.title || t('untitled')

  // The group as the Bot chat's thread (AgentThreadScreen, decision 2026-11-22-1510-group-chat-as-bot-chat): the
  // person's messages are theirs; every other member's, a Bot's or an Agent's is the block's agent message with its own
  // author line (mark and name, shown where the author changes), as LobeHub's group chat heads each speaker's turn.
  const entries: ThreadEntry[] = []
  // A Bot-to-Bot exchange is a line about the chat after its anchor's run of messages, not anyone's words.
  let waiting: GroupExchange[] = []
  const flush = (at: number) => {
    for (const exchange of waiting) entries.push({ id: `exchange:${exchange.linkId}`, role: 'bot', at, event: true,
      parts: [{ kind: 'text', text: t('exchange.title', { names: exchange.participants.map(participant => participant.name).join(' & ') }), node: <AgentExchangeMarker exchange={exchange} /> }] })
    waiting = []
  }
  messages.forEach((message, index) => {
    const at = Date.parse(message.createdAt)
    const mine = message.authorType === 'user' && message.authorId === userId
    const id = sentAs[message.id] ?? message.id
    const reply = message.authorType !== 'user'
    // The line under every message, as the Bot chat's (on hover, decision 2026-11-22-1500): Copy and its reactions;
    // a person's message says when it was sent, a reply's author line already does.
    const actions = <ReplyActions at={reply ? undefined : at} copyText={message.body}><MessageReactions reactions={reactions[message.id]} align={mine ? 'end' : 'start'} /></ReplyActions>
    const words = <CollapsibleMessage><UserMessageText text={message.body} renderText={referenceText} /></CollapsibleMessage>
    if (mine) entries.push({ id, role: 'person', at, text: message.body, body: words, actions })
    else {
      const name = authorName(message.authorType, message.authorId)
      const bot = message.authorType === 'bot' ? member('bot', message.authorId) : undefined
      entries.push({ id, role: 'bot', at, actions,
        author: { id: `${message.authorType}:${message.authorId}`, name, mark: bot ? <BotAvatar {...memberAvatar(bot)} size="message" still /> : <LetterAvatar name={name} size="message" /> },
        parts: [{ kind: 'text', text: message.body, node: reply ? <AgentMarkdown text={message.body} /> : words }] })
    }
    waiting.push(...exchanges.get(message.position) ?? [])
    const next = messages[index + 1]
    if (!next || next.authorType !== message.authorType || next.authorId !== message.authorId) flush(at)
  })
  for (const item of unsent) entries.push({ id: item.id, role: 'person', at: item.at, text: item.text,
    body: <CollapsibleMessage><UserMessageText text={item.text} renderText={referenceText} /></CollapsibleMessage>,
    status: item.phase === 'failed' ? 'failed' : 'sending', ...(item.phase === 'failed' ? { deliveryMessage: item.error, onRetry: () => { void deliver(item) } } : {}) })
  const lastAt = entries.at(-1)?.at ?? 0
  const line = (key: string, text: string) => entries.push({ id: key, role: 'bot', at: lastAt, event: true, parts: [{ kind: 'text', text, node: <p role="status" className="text-center text-xs text-muted-foreground">{text}</p> }] })
  if (first?.routingError && !first.agentStatus) line('no-taker', t('noTaker'))
  if (first?.stopped && !first.agentStatus) line('stopped', t('stopped'))
  // A named chat is read once its newest message has been seen.
  const lastEntry = entries.at(-1)
  if (lastEntry && namedChat && readRevision !== undefined && !blockingCode && !accessRejected) lastEntry.actions = <>{lastEntry.actions}<VisibleReadEnd onSeen={acknowledge} /></>

  const blocked = blockingCode === 'not_found' ? <p role="alert" className="py-6 text-sm">{t('notFound')}</p>
    : blockingCode ? <div role="alert" className="flex items-center gap-3 py-6 text-sm"><span>{blockingCode === 'unauthorized' ? t('authRequired') : t('loadError')}</span>{blockingCode !== 'unauthorized' && <Button variant="outline" size="sm" onClick={() => { void mutate() }}>{t('retry')}</Button>}</div>
      : null
  const empty = blocked ?? <p className="py-6 text-sm text-muted-foreground">{t('empty')}</p>

  return <AgentThemeProvider><section aria-label={title} data-testid="group-chat" className="mikka-agent relative flex min-h-0 w-full flex-1 flex-col">
    {namedChat
      ? <ThreadHeader standalone issueId={null} runId={group.id} title={title} headingRef={titleHeading}
          onTitleChanged={() => { void refreshCache(botKeys.groups(userId, group.workspaceId)) }}
          onStop={null} place={null} acceptanceBadge={null} identity={null} />
      // A frame with its own head draws no title pill over a chat, as the Bot chat (FRAME_OWNS_HEADER).
      : !FRAME_OWNS_HEADER && <ConversationPill name={title} avatar={<GroupAvatar title={title} members={members} />} />}
    {onLeft && !refused && !accessRejected && mayLeaveGroup(members, userId) && <div className="absolute end-14 top-2 z-10">
      <GroupLeaveAction group={group} userId={userId} onLeft={() => {
        departed.current = true
        shown.current = null
        delivery.setRows([])
        setDraft('')
        onLeft(group.id)
      }} />
    </div>}
    {/* The chat's one skeleton, as every chat opens (ConversationPageLoading, delayed 200ms). */}
    {!pages && !blockingCode ? <ConversationPageLoading /> : <ThreadScreen host="page" modelPicker={false} botId={null} name={title} mark={<GroupAvatar title={title} members={members} />}
      entries={blockingCode ? [] : entries} empty={empty} transcriptLabel={t('messages')}
      older={older ? { loading: loadingOlder, onLoad: () => { void setSize(size + 1) } } : undefined}
      working={replying && !stopping} onStop={replying && !stopping ? () => { void stop() } : undefined}
      composer={{ ref: composerInput, leadingControls: <ChatComposerAttachment />, value: draft, onChange: value => { submittedDraft.current = null; setDraft(value) }, onSubmit: send,
        label: t('composer', { name: title }), disabled: !!blockingCode, attachmentScope: { kind: 'group', id: group.id },
        leftControls: modelBot ? <BotModelPicker key={modelBot} botId={modelBot} running={replying} /> : undefined,
        sending: stopping, editableWhileSending: stopping, running: replying && !stopping,
        // `@` names the group's members and references; skills where the group holds one of the person's Bots.
        references: referenceWorkspace ? { workspaceId: referenceWorkspace } : undefined, people: mentionable, historyKey: `group:${group.id}`,
        skills: members.some(item => item.memberType === 'bot' && ownedBots?.some(bot => bot.id === item.id)) }}
      pending={[]}
      questions={[]} onAnswer={async () => ({ status: 'unavailable', error: actionError() })}
      running={0} onOpenTask={openTask} onOpenInbox={() => navigate({ section: 'suggestions' })} />}
  </section></AgentThemeProvider>
}

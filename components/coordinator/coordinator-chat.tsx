'use client'

import { useViewScroll, useViewState } from '@/lib/hooks/view-state'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import { withBasePath } from '@/lib/base-path'
import { checkPageBuildBeforeAction } from '@/lib/app-build'
import { useTranslations } from '@/lib/intl/i18n-client'
import { coordinatorHistory, retryCoordinatorTurn, stopCoordinatorTurn, welcomeCoordinator, type CoordinatorChat as Chat } from '@/app/actions/coordinator'
import { getBotModelMenu } from '@/app/actions/execution-settings'
import type { BotModelMenu } from '@/lib/bot-model-menu-view'
import { metadataEntities } from '@/lib/coordinator/chat-poll'
import { readCachedCoordinatorChat } from '@/lib/coordinator/chat-read-client'
import { CacheReadError } from '@/lib/cache-read-error'
import { chatKeys } from '@/lib/swr/keys'
import type { BotView } from '@/app/actions/bots'
import { BotAvatar, COORDINATOR_AVATAR } from '@/components/nav/bot-avatar'
import { cn } from '@/lib/utils'
import { useActionError } from '@/lib/use-action-error'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { turnChoiceShown } from '@/lib/issue-run-conversation'
import { CircleHelp } from '@/components/icons'
import { toast } from 'sonner'
import { AgentCitationsContext, CitationSources, useLinkPreviews, type AgentCitations } from '@/components/workspace/agent-citations'
import { AgentInteractionContext } from '@/components/workspace/agent-interaction'
import { ReplyAnswer } from '@/components/workspace/reply-answer'
import { AgentThemeProvider } from '@/components/workspace/agent-theme'
import { navigate, openTask, openThread, startNewConversation } from '@/components/workspace/workspace-navigation'
import { PersonReferences } from '@/components/workspace/thread-references'
import { messageReferences } from '@/lib/composer-references'
import { CoordinatorReply } from './coordinator-reply'
import { botModelMenuKey, openModelPicker } from './bot-model-picker'
import { useBotModelMenu } from '@/hooks/use-bot-model-menu'
import { CoordinatorContextUsage } from './coordinator-context-usage'
import { ThreadQueuedMessages } from '@/components/workspace/thread-queued-messages'
import { isWebChatOffline, useChatDelivery, type ChatDelivery, type ChatSubmission } from '@/lib/hooks/chat-delivery'
import { useCoordinatorSubmit, type CoordinatorMessageContext } from './use-coordinator-submit'
import { useCoordinatorAgent } from './use-coordinator-agent'
import { activeTurn } from 'eve/events'
import { EveInteractions } from './eve-interactions'
import { useLiveKey, useLiveKeys, useLiveScope, watchPageVisibility } from '@/hooks/use-live-key'
import { ListReadScopeError, listReadDeadline, ownerListWorkspace, UNRESOLVED_LIST_SCOPE } from '@/lib/live/list-read'
import { heldRevision } from '@/lib/live/revisions'
import { useLiveCitations } from './use-live-citations'
import type { CoordinatorLiveReply } from '@/lib/eve/chat-view'
import { firstThreadCards, staleEventPositions } from '@/lib/coordinator/chat-dedupe'
import { ReplyWaiting, useThreadToolRows } from './reply-activity'
import { ChatComposerAttachment } from './chat-composer'
import { ThreadScreen } from '@ui-slot/thread'
import { MergeWaitingLine, useMergeWaitings } from '@/components/chat/merge-waiting-line'
import { useConversationPanels, useWorkTabs } from '@/components/coordinator/conversation-panels'
import type { ThreadEntry, ThreadEntryPart } from '@/components/slots/thread-contract'
import { factoryQuestionUnavailable, useFactoryQuestions } from '@/hooks/use-factory-questions'
import { noteChipText } from '@/lib/browser/note'
import { replySegments, type ReplySegment } from '@/lib/coordinator/reply-segments'
import { runThreadName, runTitle } from '@/lib/coordinator/citations'
import { MessageReactions, useMessageReactions } from '@/components/workspace/message-reactions'
import { PendingActions } from './pending-actions'
import { SubagentLoginNeeds } from './subagent-login-needs'
import { VisibleReadEnd } from '@/components/workspace/visible-read-end'
import { useUnreadIndicators } from '@/lib/hooks/use-unread-indicators'
import { openArtifact as openArtifactWindow } from '@/components/workspace/workspace-navigation'
import { SelectionQuote } from '@/components/chat/selection-quote'
import { ReplyActions } from '@/components/chat/reply-actions'
import { showTurnVersion, useTurnRevision } from './use-turn-revision'
import { splitReplyQuote, withReplyQuote } from '@/lib/chat-quote'
import { replyCopyText } from '@/lib/chat-copy'
import type { ArtifactChatSlot } from '@/components/artifacts/artifact-viewer'
import { useBrowserNotesComposer } from '@/components/browser/browser-notes'
import { SuggestionRow } from '@/components/suggestions/mobile-card'
import { HostedRefusalNotice } from '@/components/billing/hosted-refusal-notice'
import { usePaywall } from '@/components/billing/paywall'
import { chatFailure } from '@/lib/chat-failure'
import { SubscriptionRefusalNotice } from './subscription-refusal-notice'
import { HostedUnavailableNotice } from './hosted-unavailable-notice'
import { CloudFailureAction, FailureReason, ModelSettingsAction } from './failure-reason'
import { RunErrorDetails } from '@/components/workspace/run-error-text'
import { QuotaNotice, QuotaSwitchLine } from './quota-notice'
import { ChatEventLine } from './chat-event-line'
import { waitingQuestionRuns } from '@/lib/coordinator/waiting-questions'
import { RetryReplyButton } from './retry-reply-button'
import { COMPOSER_NOTICE } from './composer-notice'
import { blockingNotice, modelBlocked, streamLoadFailed } from '@/lib/coordinator/chat-footer'
import { eveTurnMessageId, storedChatMessageId } from '@/lib/conversation/ids'
import { useConversation } from '@/lib/conversation/store'
import type { ConversationMessage } from '@/lib/conversation/model'


/** Text put into the composer from elsewhere; `suggestionId` when it came from a 建议 item. */
export type CoordinatorPrefill = { text: string; nonce: number; suggestionId?: string }

/** A chat read and when it was asked for, which anchors its live deadline (lib/live/list-read.ts). */
type PersonalChatSend = ChatSubmission & { context: CoordinatorMessageContext; turnPolicy?: 'queue' | 'steer' }

type ChatRead = Chat & { requestedAt?: number }
/** What a Bot chat message was built from: a stored row, the live reply, or the person's unsent message. */
type BotChatSource = { item: Chat['items'][number] } | { live: CoordinatorLiveReply } | { local: ChatDelivery<PersonalChatSend> }
/** Pushes closer together than this share one read; the stream shows a turn's words meanwhile. */
const CHAT_MERGE_MS = 2_000
/** How long a turn is busy before its empty waiting row shows. */
const WAITING_ROW_DELAY_MS = 150

/** The SWR key of a chat: the Coordinator's, or one bot's. */
/** A passing usage limit (another turn running, a cost read): the next send works without anything changing. */
const TRANSIENT_REFUSALS: ReadonlySet<string> = new Set(['usage_in_progress', 'usage_concurrency_limit', 'usage_cost_unavailable'])

export const coordinatorChatKey = chatKeys.detail

/** A reply still streaming, drawn by the same row as a stored one; after 停止 it reads 已停止 before the server has stored it. */
function streamedItem(reply: CoordinatorLiveReply, stopping = false): Chat['items'][number] {
  return { position: -1, from: 'coordinator', text: reply.text, tools: [], threads: [], artifacts: [], createdAt: '',
    ...(stopping && reply.committedThrough === undefined ? { stopped: true } : {}),
    ...(reply.tools?.length || reply.thinking ? { activity: { tools: reply.tools ?? [], thought: Boolean(reply.thinking) } } : {}) }
}

/** A reply's rows top to bottom (lib/coordinator/reply-segments.ts); its thinking, when it thought, leads them. */
function replyRows(item: Chat['items'][number], live: CoordinatorLiveReply | undefined): ReplySegment[] {
  const rows = replySegments(item.text, item.activity?.tools ?? [])
  return (item.activity?.thought || live?.thinking) && rows[0]?.kind !== 'tools' ? [{ kind: 'tools', tools: [] }, ...rows] : rows
}

/** A live reply's thinking as the activity shows it: still thinking, or the whole seconds it took (at least one). */
function liveThinking(reply: CoordinatorLiveReply) {
  return reply.thinking && { active: reply.thinking.since !== undefined, ...(reply.thinking.ms ? { seconds: Math.max(1, Math.round(reply.thinking.ms / 1000)) } : {}), ...(reply.thinking.text ? { text: reply.thinking.text } : {}) }
}


/**
 * The person's conversation with their Coordinator, which dispatches agents to
 * issues, or with one of their bots: a bot runs on the same harness with its
 * own conversation, memory and name. Artifacts agents hand over show as chips
 * under a reply and open the reader; inside the reader, as in the board's column,
 * the same screen runs as a narrow panel, the reader's artifact marked and its
 * quote waiting above the composer.
 */
/** A thread card or chip opens the thread in the right column; the chat stays (R-66, R-82). */
const showThread = ({ runId }: { runId: string }) => openThread(runId)

function CoordinatorChatSession({ onOpenIssue, prefill, placeholder, compact = false, embedded, bot, userId, pill = true }: { onOpenIssue: (id: string) => void; prefill?: CoordinatorPrefill; placeholder?: string; compact?: boolean; embedded?: ArtifactChatSlot; bot?: BotView; userId?: string
  /** A floating title pill sits over the chat on wide screens (ConversationPill): the layer's screen starts below it. */
  pill?: boolean }) {
  const t = useTranslations('Coordinator')
  const threadCopy = useTranslations('IssueThreads')
  const cloudErrors = useTranslations('RunErrors')
  const tNav = useTranslations('Nav')
  const tCommon = useTranslations('Common')
  const botId = bot?.id ?? null
  // Send-time paywall: a message on Mikka 额度 with nothing to pay is not sent (decision 2026-11-15-1900).
  const paywall = usePaywall(botId)
  const name = bot?.name ?? t('label')
  const avatar = (size: 'pill' | 'message' | 'profile', mood?: 'thinking') => <BotAvatar {...(bot ? { id: bot.id, color: bot.color, shape: bot.shape } : COORDINATOR_AVATAR)} size={size} mood={mood} />
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const actionError = useActionError()
  const { cache, mutate: mutateAll } = useSWRConfig()
  const liveScope = useLiveScope()
  const selectedWorkspaceId = liveScope?.workspaceId
  const owner = userId ?? liveScope?.ownerId
  const reconnectStream = useRef<() => void>(() => {})
  // A read names the version it shows; an unchanged chat comes back as its live state only (lib/coordinator/chat-poll.ts).
  const shown = useRef<{ chat?: ChatRead; metadataStale: boolean; fullReadAt: number }>({ metadataStale: false, fullReadAt: -Infinity })
  const chatKey = coordinatorChatKey(botId)
  const { data: cachedData, mutate, error: loadError } = useSWR<ChatRead>(chatKey, async () => {
    const refreshMetadata = shown.current.metadataStale
    shown.current.metadataStale = false
    if (refreshMetadata || !shown.current.chat) shown.current.fullReadAt = performance.now()
    try { return await readCachedCoordinatorChat(cache, botId, { refreshMetadata }) }
    catch (error) { if (refreshMetadata) shown.current.metadataStale = true; throw error }
  }, {
    onSuccess: () => reconnectStream.current(),
  })
  const unavailable = loadError instanceof CacheReadError || loadError instanceof ListReadScopeError
  const data = unavailable ? undefined : cachedData
  useEffect(() => { shown.current.chat = data }, [data])
  // No timer reads this chat (#1212). A committed message, inbox event, turn change or run change in it pushes
  // its key on the owner's home channel; a turn's lease running out has no write, so its expiry is a deadline.
  // While the channel is down the live layer falls back to one read a minute. The stream still carries a turn.
  const liveOwner = data?.live?.ownerId
  const liveHome = liveOwner ? ownerListWorkspace(data, liveOwner) : null
  // A push this chat already read (a duplicate, or the echo of this tab's own send) is skipped.
  useLiveKey('bot_chat', unavailable ? null : liveHome && data?.botId ? data.botId : UNRESOLVED_LIST_SCOPE, [unstable_serialize(chatKey)], liveHome,
    { minIntervalMs: CHAT_MERGE_MS, deadline: liveOwner ? listReadDeadline(data, liveOwner) : undefined, revisions: { [unstable_serialize(chatKey)]: heldRevision(data, 'bot_chat', data?.botId) }, shareAcrossTabs: true })
  // Cards and cited names have no chat write (lib/coordinator/chat-poll.ts). An
  // artifact push or visibility catch-up refreshes metadata using the same cursor.
  const metadataKey = useMemo(() => chatKeys.metadata(botId), [botId])
  useSWR(data ? metadataKey : null, async () => {
    // Catching up, the chat's own read already refreshed metadata.
    if (shown.current.metadataStale || performance.now() - shown.current.fullReadAt < 1_000) return true
    shown.current.metadataStale = true; await mutate(); return true
  }, {
    revalidateOnMount: false, revalidateIfStale: false, revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false,
  })
  const artifactsShown = data?.artifacts
  const metadata = useMemo(() => metadataEntities({ artifacts: artifactsShown }), [artifactsShown])
  useLiveKeys(liveHome ? metadata : [], [unstable_serialize(metadataKey)], liveHome, { minIntervalMs: CHAT_MERGE_MS })
  // Deleting a cited task or changing workspace access need not write a chat
  // message. Reuse the existing list push; the next cursor read reauthorizes
  // decorations and removes anything it can no longer return.
  const hasSources = Boolean(Object.keys(data?.sources ?? {}).length)
  const sourceScopes = [...new Set([liveHome, selectedWorkspaceId].filter((scope): scope is string => Boolean(scope)))]
  useLiveKeys(hasSources ? sourceScopes.map(workspaceId => ({ kind: 'issue_list' as const, id: workspaceId, workspaceId })) : [], [unstable_serialize(metadataKey)], null, { minIntervalMs: CHAT_MERGE_MS })
  useEffect(() => watchPageVisibility(() => { if (document.visibilityState === 'hidden' && shown.current.chat) shown.current.metadataStale = true }), [])
  const [loadingHistory, setLoadingHistory] = useState(false)
  // Each page of older messages put above the transcript, for the thread to keep its place (ThreadScreenProps.historyPrepend).
  const [historyPrepend, setHistoryPrepend] = useState(0)
  async function loadHistory() {
    if (!data?.historyBefore || loadingHistory) return
    setLoadingHistory(true)
    try {
      const persisted = data.items.filter(item => !item.pending)
      const through = persisted[1] ? persisted[1].position - 1 : data.historyBefore - 1
      const page = await coordinatorHistory(botId, through)
      await mutate(current => current ? { ...current, items: [...page.items, ...current.items.filter(item => item.pending || item.position > through)], sources: { ...current.sources, ...page.sources }, artifacts: { ...current.artifacts, ...page.artifacts }, historyBefore: page.historyBefore } : current, { revalidate: false })
      if (page.items.length) setHistoryPrepend(count => count + 1)
    } catch { toast.error(actionError()) } finally { setLoadingHistory(false) }
  }
  // A sent message waits in the inbox for its turn: the stream opens now, so the first words show as they come.
  const stream = useCoordinatorAgent({ botId, enabled: Boolean(data), persistedStreamIds: data?.persistedStreamIds, revalidate: mutate })
  const working = stream.status === 'busy'
  const resuming = stream.status === 'resuming'
  // The server has the turn running (or waiting on the person): only then do Stop and the queue choice show, so a send
  // the server refuses never flashes them (UX audit 2026-11-22, issue 1).
  const turnConfirmed = activeTurn(stream.view) !== undefined
  // Stop is there the moment a send is accepted (decision 2026-11-22-1600, as ChatGPT and Claude), with no delay: it is the
  // send button's own face, so nothing moves (CLS 0). Accepted input not yet running is the server's to stop
  // (stopCoordinatorTurn ends it before any turn takes it); a refused send never shows Stop. The sidebar reads the same
  // state (coordinatorTurnStoppable). `acceptedSend` covers the moment between the send's acceptance and the next read.
  const [acceptedSend, setAcceptedSend] = useState(false)
  useEffect(() => { setAcceptedSend(false) }, [data])
  const stoppable = turnConfirmed || Boolean(data?.working) || acceptedSend
  useEffect(() => { reconnectStream.current = stream.reconnect }, [stream.reconnect])
  // The server runs a turn the page holds no stream for (a reload mid-turn, a dropped stream): the sidebar spins and the
  // composer shows Stop for it all the same, and the page tries to attach to it again. Stop then goes to the server.
  const unattached = Boolean(data?.working) && !working && !turnConfirmed && !resuming
  useEffect(() => { if (unattached) reconnectStream.current() }, [unattached, data])
  const stateKey = `bot-chat:${botId ?? 'coordinator'}:${embedded?.activeArtifactId ?? 'main'}`
  // Each chat keeps where the person was reading, as a group chat does; one read to its end follows the latest.
  const transcript = useViewScroll<HTMLDivElement>(`${stateKey}:transcript`, Boolean(data), true, 'end')
  const [draft, setDraft] = useViewState(`${stateKey}:draft`, '')
  const updateDraft = setDraft
  // Carry existing window drafts into the new account/workspace-scoped store once.
  useEffect(() => {
    if (!userId || embedded) return
    const legacyKey = `mikka:draft:${userId}:${botId ?? 'coordinator'}`
    try {
      const legacy = window.sessionStorage.getItem(legacyKey)
      if (legacy) { setDraft(current => current || legacy); window.sessionStorage.removeItem(legacyKey) }
    } catch { /* storage unavailable */ }
  }, [userId, botId, embedded, setDraft])
  const [sends, setSends] = useState(0)
  const sending = sends > 0
  const [turnPolicy, setTurnPolicy] = useViewState<'queue' | 'steer'>('eve:turn-policy', 'queue')
  // The queue choice is about the next message: it shows while a turn runs and a draft waits to go.
  const turnOptions = turnChoiceShown(working && turnConfirmed && !resuming, draft) ? <NativeSelect size="sm" aria-label={threadCopy('deliveryMode')} value={turnPolicy}
    onChange={event => setTurnPolicy(event.target.value === 'steer' ? 'steer' : 'queue')}>
    <NativeSelectOption value="queue">{threadCopy('deliveryModes.queue')}</NativeSelectOption>
    <NativeSelectOption value="steer">{threadCopy('deliveryModes.steer')}</NativeSelectOption>
  </NativeSelect> : null
  // Words picked from a reply with 引用: they wait above the draft and head the next message as quote lines.
  const [replyQuote, setReplyQuote] = useViewState<string | null>(`${stateKey}:quote`, null)
  function quoteReply(text: string) {
    setReplyQuote(text)
    inputRef.current?.focus()
  }
  // Why the last send did not go, for a card that answers through this chat (agent-interaction.tsx `answer`).
  const lastSendFailure = useRef<string | undefined>(undefined)
  const draftInFlight = useRef(new Set<string>())
  const admission = useRef(Promise.resolve())
  const waitingAdmissions = useRef(new Map<string, { cancelled: boolean }>())
  function cancelWaitingAdmission(id: string) {
    const entry = waitingAdmissions.current.get(id)
    if (!entry) { toast.error(threadCopy('deliveryTooLate')); return }
    entry.cancelled = true
    waitingAdmissions.current.delete(id)
    delivery.setRows(rows => rows.filter(row => row.id !== id))
  }
  const delivery = useChatDelivery<PersonalChatSend>(stateKey, t('sendUncertain'))
  const [retrying, setRetrying] = useState<ReadonlySet<number>>(() => new Set())
  const { submit, failureMessage } = useCoordinatorSubmit(stream)
  // Notes pinned in the browser wait in this composer while it is the chat on screen (not inside the reader).
  const browser = useBrowserNotesComposer(!embedded)
  const noteCount = browser?.notes.length ?? 0
  useEffect(() => { if (noteCount) inputRef.current?.focus() }, [noteCount])
  // The 建议 item whose text is in the composer: once sent, the Coordinator dispatches a thread for it and it leaves 建议.
  const suggestion = useRef<string | null>(null)
  // 「让 Agent 安排」 and 建议 items put their sentence here for the person to finish (MIK-39).
  useEffect(() => {
    if (!prefill) return
    suggestion.current = prefill.suggestionId ?? null
    setDraft(prefill.text)
    const input = inputRef.current
    if (input) { input.focus(); input.setSelectionRange(prefill.text.length, prefill.text.length) }
  }, [prefill])
  // A failed message sent again is retried in place: it goes at once, and the server leaves it out from then on.
  // A failed welcome stands only until a reply follows (an incremental read appends the reply after it).
  const items = useMemo(() => (data?.items ?? []).filter((item, index, all) => !(item.from === 'person' && retrying.has(item.position))
    && !(item.welcome && all.slice(index + 1).some(next => next.from === 'coordinator'))), [data, retrying])
  // One thread has one card in a chat (R-66): under the first reply that dispatched it; later replies name it in their words.
  const firstThreadCard = useMemo(() => firstThreadCards(items), [items])
  // A thread's event line said again later (「… 在等你回答」 twice) shows only the latest one (R-66).
  const staleEvents = useMemo(() => staleEventPositions(items), [items])

  // A run's question is a live state, not a message: the thread card already names the run and its state badge says
  // 等待你 (decision 2026-11-10), so the chat shows one sentence above the composer instead of a stored event line.
  const waitingQuestions = useMemo(() => waitingQuestionRuns(items, data?.sources, staleEvents), [items, data, staleEvents])
  /** The thread cards under `item`: those whose first reply it is; a live reply only threads no stored reply has carded. */
  const cardsOf = (item: Chat['items'][number], live: boolean) => item.threads.filter(id => (live ? !firstThreadCard.has(id) : firstThreadCard.get(id) === item.position) && sources?.[id]?.kind === 'run')
  const received = useMemo(() => new Set(items.flatMap(item => item.from === 'person' && item.submissionId ? [item.submissionId] : [])), [items])
  const localMessages = delivery.rows.filter(row => !received.has(row.id))
  const waitingRows = delivery.rows.filter(row => waitingAdmissions.current.has(row.id))
  // Messages waiting for the turn to end, in the thread's queued list (Figma 1318:2 section 20); 删除 takes one back.
  const queuedNotice = working ? <ThreadQueuedMessages rows={waitingRows.map(row => ({ id: row.id, text: row.text, onDelete: () => cancelWaitingAdmission(row.id) }))} /> : null
  useEffect(() => {
    if (delivery.rows.some(row => received.has(row.id))) delivery.setRows(current => current.filter(row => !received.has(row.id)))
  }, [received, delivery.rows, delivery.setRows])
  const liveFailure = data?.error && !working ? chatFailure({ working: false, error: data.error, cause: data.cause }) : null
  // A turn the hosted model (Mikka 默认) refused: verification, allowance or pause (#523, #525, #526).
  const refusal = liveFailure?.kind === 'hosted' ? liveFailure.code : null
  // The chosen subscription refused it: the mapped line, never the raw step error.
  const declined = liveFailure?.kind === 'subscription' ? liveFailure.notice : null
  const apiBalance = liveFailure?.kind === 'failed' && liveFailure.reason === 'balance'
  // 重试 on any failed reply, never on a wake still being retried by the server.
  const retry = <RetryReplyButton botId={botId} onQueued={mutate} />
  const cloudCode = liveFailure?.kind === 'failed' ? liveFailure.cloudCode : undefined
  const [welcomeNeedsModel, setWelcomeNeedsModel] = useState(false)
  const modelRequired = (liveFailure?.kind === 'failed' && liveFailure.reason === 'modelRequired') || (welcomeNeedsModel && !working && !items.length && !stream.replies.length)
  const liveRaw = liveFailure?.raw ?? null
  const wakeError = liveFailure?.kind === 'wake' ? liveFailure.code : null
  // With no Coordinator here, the person's last message gets no reply: show it as a failed turn instead of silence.
  // A failed turn's own line already says why; this one is only for a chat with no Coordinator to answer.
  const unanswered = data?.enabled === false && !data.error && items.findLast(item => item.from !== 'event')?.from === 'person'
  // The failure of the newest turn sits under the message it was answering (it carries the mark, store.failTurn),
  // with its way on; an older failure keeps only its reason there. Without the mark it stays above the composer.
  const lastSaid = items.findLast(item => item.from !== 'event')
  const failedAt = data?.error && !working && (lastSaid?.from === 'person' || lastSaid?.welcome) && lastSaid.failure ? lastSaid.position : null
  // The welcome never came: its failure is the chat's one line, on the Bot's side, never only a banner (11 people on 11-02).
  const welcomeFailed = Boolean(data?.error && !working && (lastSaid?.welcome || (!items.length && !stream.replies.length)))
  // No empty chats: the Coordinator, like every bot, writes its welcome first.
  const welcomed = useRef(false)
  const welcomeRequest = useRef(false)
  const [welcomeError, setWelcomeError] = useState<string | null>(null)
  const [welcoming, setWelcoming] = useState(false)
  async function requestWelcome(retryTurn = false, manual = false) {
    if (welcomeRequest.current) return
    welcomeRequest.current = true
    setWelcoming(true)
    try {
      if (manual && !await checkPageBuildBeforeAction()) return
      const result = await (retryTurn ? retryCoordinatorTurn(botId) : welcomeCoordinator(botId))
      if ('reason' in result && result.reason === 'modelRequired') {
        setWelcomeNeedsModel(true)
        setWelcomeError(null)
        return
      }
      setWelcomeNeedsModel(false)
      if (result.error) { setWelcomeError(actionError(result.error)); return }
      await mutate()
      setWelcomeError(null)
    } catch {
      setWelcomeError(actionError())
      // A lost response may already have queued the welcome. Read its real state
      // before offering the idempotent welcome action again.
      await mutate().catch(() => undefined)
    } finally { welcomeRequest.current = false; setWelcoming(false) }
  }
  const welcomeRequestFailed = Boolean(welcomeError && !data?.error && !working && !items.length && !stream.replies.length)
  // A welcome Mikka 默认 refused runs again once its model becomes runnable while this chat is open (the trial points
  // arrived, a card was verified): only on a change from not runnable to runnable seen by this mount, never on open
  // (the menu can read runnable while the server still refuses), never for a passing usage limit, never in a hidden
  // tab, and once per failure (store.retryFailedTurn), so a visit never fires another refused turn.
  const welcomeModel = useSWR<BotModelMenu>(welcomeNeedsModel || (welcomeFailed && (refusal || modelRequired)) ? botModelMenuKey(botId ?? null) : null, () => getBotModelMenu(botId ?? null))
  const runnable = welcomeModel.data?.current?.available
  // What the composer's model picker reads: with nothing that can answer, Send waits and the one notice says why.
  const modelMenu = useBotModelMenu(botId)
  const noModel = modelBlocked(modelMenu.data)
  const retriedWelcomeModel = useRef<string | null>(null)
  const wasRunnable = useRef<boolean | undefined>(undefined)
  const rewelcomed = useRef<string | null>(null)
  useEffect(() => {
    if (!data?.enabled || working || resuming || !stream.session) return
    if (welcomeNeedsModel) {
      if (runnable === false) retriedWelcomeModel.current = null
      const model = welcomeModel.data?.current
      if (items.length || document.visibilityState !== 'visible' || !model || model.kind === 'none' || !runnable || retriedWelcomeModel.current === model.id) return
      retriedWelcomeModel.current = model.id
      void requestWelcome()
      return
    }
    if (welcomed.current) return
    if (data.error) {
      if (document.visibilityState !== 'visible') return
      const was = wasRunnable.current
      if (runnable !== undefined) wasRunnable.current = runnable
      if (!welcomeFailed || (!refusal && !modelRequired) || (refusal && TRANSIENT_REFUSALS.has(refusal)) || was !== false || runnable !== true || rewelcomed.current === data.error) return
      rewelcomed.current = data.error
      void requestWelcome(true)
      return
    }
    if (items.length) return
    welcomed.current = true
    void requestWelcome()
  })
  // The raw step error (workflow ids, retries, socket codes) is for the logs, never the chat: 回复失败 and 重试 (review C4).
  const failureNotice = <>
    {modelRequired && <Alert variant="destructive" className={COMPOSER_NOTICE}><AlertTitle className="min-w-0 flex-1 basis-48" data-chat-failure="model-required">{t('modelRequired')}</AlertTitle><ModelSettingsAction /></Alert>}
    {welcomeRequestFailed && <Alert variant="destructive" className={COMPOSER_NOTICE}><AlertTitle className="min-w-0 flex-1 basis-48" data-chat-failure="welcome-request">{welcomeError}</AlertTitle><Button variant="ghost" size="sm" disabled={welcoming} onClick={() => { void requestWelcome(false, true) }}>{tCommon('retry')}</Button></Alert>}
    {cloudCode && <Alert variant="destructive" className={COMPOSER_NOTICE}><AlertTitle className="min-w-0 flex-1 basis-48" data-chat-failure="cloud">{cloudErrors(`${cloudCode}.default`)}</AlertTitle><span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1"><CloudFailureAction code={cloudCode} fallback={retry} /></span></Alert>}
    {refusal && <HostedRefusalNotice code={refusal} botId={botId} retry={retry} onQueued={mutate} />}
    {declined && declined !== 'quotaUsed' && <SubscriptionRefusalNotice notice={declined} retry={retry} botId={botId} />}
    {apiBalance && <Alert variant="destructive" className={COMPOSER_NOTICE}><AlertTitle className="min-w-0 flex-1 basis-48" data-chat-failure="balance">{t('apiBalance')}</AlertTitle><span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1"><Button size="sm" onClick={() => openModelPicker(botId)}>{t('modelPicker.changeModel')}</Button></span></Alert>}
    {data?.error && !working && !modelRequired && !cloudCode && !refusal && !declined && !apiBalance && <Alert variant="destructive" className={COMPOSER_NOTICE}>{wakeError ? <AlertTitle>{t(`wakeErrors.${wakeError}`)}</AlertTitle> : <><AlertTitle className="min-w-0 flex-1 basis-48" data-chat-failure="failed">{t('failedTitle')}</AlertTitle><span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">{retry}</span></>}</Alert>}
    {/* The stored codes, and the turn failure behind a wake code, only under 详情 (decision 2026-11-05-0330). */}
    {liveRaw && <RunErrorDetails code={liveRaw} />}
  </>
  const rootRef = useRef<HTMLElement>(null)
  // Events are system lines, not messages; the person's own messages never count as unread.
  // A failed welcome is the Bot saying nothing yet: never an unread message.
  const unreadItems = useMemo(() => items.filter(item => item.from !== 'event' && !item.welcome).map(item => ({ position: item.position, messageId: item.id ?? String(item.position), own: item.from === 'person', reportable: !item.pending })), [items])
  // Reactions people gave on the phone (decision 2026-11-01-0030-mobile-reactions); a pending row has none yet.
  const reactions = useMessageReactions(items.map(item => item.pending || item.from === 'event' ? null : item.id))
  const unread = useUnreadIndicators({ conversationId: botId ? `bot:${botId}` : 'coordinator', items: unreadItems, rootRef })
  const previews = useLinkPreviews(items.filter(item => item.from === 'coordinator').map(item => item.text))
  const sources = data?.sources
  // A layer that draws the conversation as one screen (slot `thread`) gets the same rows as data and nodes.
  // The Overview and the browser, when the frame's work area holds them (FRAME_OWNS_PANEL).
  const panels = useConversationPanels()
  // The board's column and an Artifact's reader hold the chat as a narrow panel beside other content.
  const panel = compact || Boolean(embedded)
  // Tasks and threads opened from this chat open as tabs of that work area (decision 2026-11-10), named by their code.
  const work = useWorkTabs(Boolean(panels && !panel), {
    task: id => {
      const source = Object.values(sources ?? {}).find(item => item.kind === 'issue' ? item.id === id : item.issue?.id === id)
      const issue = source?.kind === 'issue' ? source : source?.issue
      return issue?.identifier ?? issue?.title ?? t('citation.issue')
    },
    thread: id => {
      const run = sources?.[id]
      if (run?.kind !== 'run') return { title: t('citation.run') }
      return { title: run.issue?.identifier ? `${run.issue.identifier} › ${runTitle(run) || runThreadName(run)}` : runThreadName(run), issueId: run.issue?.id ?? null, name: runThreadName(run) }
    },
  }, name, owner && selectedWorkspaceId ? JSON.stringify([owner, selectedWorkspaceId, botId]) : null)
  const openIssue = work.work ? work.openTask : onOpenIssue
  const citations = useMemo<AgentCitations>(() => ({ sources: sources ?? {}, previews, onOpenIssue: openIssue }), [sources, previews, openIssue])
  // A live reply cites tasks and threads the stored chat may not know yet; they are looked up as it streams.
  const liveCitations = useLiveCitations(stream.replies.map(reply => reply.text), citations)
  // The tasks and threads the person's own messages reference, looked up the same way (#2924).
  const personTexts = useMemo(() => [...(data?.items ?? []).flatMap(item => item.from === 'person' ? [item.text] : []), ...localMessages.map(row => row.text)], [data?.items, localMessages])
  const personCitations = useLiveCitations(personTexts, citations).settled
  // A saved draft's references are named from the same sources, looked up the same way (the editor's chips).
  const draftSources = useLiveCitations([draft], personCitations).settled.sources
  const composerCommands = useMemo(() => [{ id: 'new', name: '/new', description: t('commandNew'), run: startNewConversation }], [t])
  // What the person said next after each reply, so a choice card shows its answer after a reload.
  const answers = useMemo(() => {
    const next = new Map<number, string>()
    let said: string | null = null
    for (const item of [...items].reverse()) {
      if (item.from === 'person') said = item.text
      else if (item.from === 'coordinator' && said !== null) next.set(item.position, said)
    }
    return next
  }, [items])
  // An artifact handed over shows here first; the Artifact page and a thread's 「Artifact · N」 refresh with it.
  const artifactIds = useMemo(() => items.flatMap(item => item.artifacts).join(','), [items])
  useEffect(() => {
    if (!artifactIds) return
    void mutateAll(key => key === 'artifacts' || (Array.isArray(key) && key[0] === 'run-artifacts'))
  }, [artifactIds, mutateAll])
  // Not inside a reader: the card opens the Artifact window over the page, with its own address (R-82).
  const openArtifact = embedded?.openArtifact ?? openArtifactWindow
  // A quote just picked in the reader: put the cursor where the request goes.
  useEffect(() => { if (embedded?.quote) inputRef.current?.focus() }, [embedded?.quote])

  // 停止 shows at once, as Esc does in Claude Code and Codex: the reply in flight reads 已停止 and the composer is free
  // again while the turn ends on the server, keeping what it had said.
  const [stopping, setStopping] = useState(false)
  useEffect(() => { if (!working) setStopping(false) }, [working])
  // The empty waiting row joins the transcript only after the turn has been busy a moment: a quick refusal or a quick
  // first word never flashes it (UX audit 2026-11-22, issue 5).
  const [waitedLong, setWaitedLong] = useState(false)
  useEffect(() => {
    if (!working) { setWaitedLong(false); return }
    const timer = setTimeout(() => setWaitedLong(true), WAITING_ROW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [working])
  async function stop() {
    setStopping(true)
    try {
      // A running turn stops through its stream; input accepted but not yet running is stopped on the server, atomically.
      if (turnConfirmed) await stream.cancel()
      else { const result = await stopCoordinatorTurn(botId); if (result.error) throw new Error(result.error) }
      await mutate()
    } catch { setStopping(false); toast.error(actionError()) }
  }

  /** Sends `text` to the Coordinator or bot, with the browser's notes when `withNotes`: sent, failed (now a failed bubble), or skipped. */
  async function deliver(text: string, withNotes = false, retryOf?: number, previous?: PersonalChatSend, releaseDraft?: () => void): Promise<'sent' | 'failed' | 'skipped'> {
    if (!text || resuming || unavailable) return 'skipped'
    // A double-click can enter twice before React paints the emptied draft.
    // A different draft has its own journal ID and may enter Eve immediately.
    const draftKey = JSON.stringify([text, retryOf ?? null])
    if (!previous && draftInFlight.current.has(draftKey)) return 'skipped'
    const notes = withNotes && browser?.notes.length ? [...browser.notes] : undefined
    const command = previous ?? { id: crypto.randomUUID(), at: Date.now(), text,
      ...(working ? { turnPolicy } : {}),
      context: { quote: embedded?.quote, botId, notes, expectedWorkspaceId: selectedWorkspaceId ?? undefined, expectedOwnerId: userId ?? liveOwner ?? undefined,
        ...(retryOf !== undefined ? { retryOf } : {}) } }
    if (!delivery.begin(command)) return 'skipped'
    if (command.context.retryOf !== undefined) { const position = command.context.retryOf; setRetrying(current => new Set(current).add(position)) }
    if (!previous) draftInFlight.current.add(draftKey)
    const prior = admission.current
    let advance!: () => void
    admission.current = new Promise<void>(resolve => { advance = resolve })
    const entry = { cancelled: false }
    waitingAdmissions.current.set(command.id, entry)
    setSends(count => count + 1)
    releaseDraft?.()
    const fail = (message: string) => { lastSendFailure.current = message; delivery.finish(command.id, { error: message }); return 'failed' as const }
    try {
      await prior
      if (entry.cancelled) return 'skipped'
      if (isWebChatOffline()) return fail(t('sendOffline'))
      const currentBuild = await checkPageBuildBeforeAction()
      if (entry.cancelled) return 'skipped'
      if (!currentBuild) return fail(t('sendUpdateRequired'))
      waitingAdmissions.current.delete(command.id)
      const outcome = await submit(command.text, command.context, command.id, command.turnPolicy)
      if (outcome.kind !== 'accepted') return fail(failureMessage(outcome) ?? t('sendUncertain'))
      setAcceptedSend(true)
      delivery.finish(command.id, {})
      if (command.context.notes) browser?.removeMany(command.context.notes.map(note => note.n))
      void mutate().catch(() => undefined)
      return 'sent'
    } catch { return fail(t('sendUncertain')) } finally {
      waitingAdmissions.current.delete(command.id)
      advance()
      if (!previous) draftInFlight.current.delete(draftKey)
      setSends(count => count - 1)
    }
  }
  /** Sends `text`; false if it did not go. */
  async function post(text: string, withNotes = false) {
    return await deliver(text, withNotes) === 'sent'
  }
  /** Sends a card's answer and says why it did not go, in the words the failed message itself shows. */
  async function answer(text: string): Promise<{ sent: true } | { sent: false; reason?: string }> {
    lastSendFailure.current = undefined
    const outcome = await deliver(text)
    return outcome === 'sent' ? { sent: true } : { sent: false, reason: outcome === 'failed' ? lastSendFailure.current : undefined }
  }
  async function send(event?: FormEvent) {
    event?.preventDefault()
    const text = draft.trim()
    if (text && await paywall.blocked({ model: true })) return
    const id = suggestion.current
    const result = text ? await deliver(withReplyQuote(text, replyQuote), true, undefined, undefined, () => {
      setDraft('')
      setReplyQuote(null)
      embedded?.clearQuote()
      suggestion.current = null
    }) : 'skipped'
    if (result !== 'sent') return
    if (id) {
      await fetch(withBasePath(`/api/suggestions/${id}`), { method: 'DELETE', credentials: 'same-origin' }).catch(() => undefined)
      void mutateAll(key => typeof key === 'string' && key.includes('/api/suggestions'))
      void mutateAll(key => key === 'threads' || Array.isArray(key) && key[0] === 'threads')
    }
  }

  const toolRows = useThreadToolRows()
  const tMessage = useTranslations('AiElements.message')
  const tNavAll = useTranslations()
  // The Coordinator's chat docks the person's pending Factory questions; a read follows the chat's own version.
  const factory = useFactoryQuestions(data?.version ?? data?.cursor ?? null, Boolean(!embedded && !botId && data))
  // A PR a thread from this chat delivered, waiting on the person to merge it (#2922): one line at the chat's end.
  const mergeWaitings = useMergeWaitings(embedded ? [] : items.flatMap(item => cardsOf(item, false).flatMap(id => {
    const run = sources?.[id]
    return run?.kind === 'run' && run.issue ? [{ issueId: run.issue.id, pulls: run.pullRequests ?? [] }] : []
  })))
  // The live failure as the thread's error line: a plain failure says 回复失败 (or why the wake failed) once, on the
  // line, with 重试 under it; a failure with its own reason (cloud, refusal, subscription, API balance) keeps its notice.
  const plainFailure = Boolean(data?.error && !working && !modelRequired && !cloudCode && !refusal && !declined && !apiBalance)
  const liveFailurePart: ThreadEntryPart = plainFailure
    ? { kind: 'error', failure: welcomeFailed ? 'welcome' : 'live', text: wakeError ? t(`wakeErrors.${wakeError}`) : t('failedTitle'), actions: <>{retry}{liveRaw && <RunErrorDetails code={liveRaw} />}</> }
    : { kind: 'error', failure: welcomeFailed ? 'welcome' : 'live', text: t(modelRequired ? 'modelRequired' : 'failedTitle'), actions: modelRequired ? <><ModelSettingsAction />{liveRaw && <RunErrorDetails code={liveRaw} />}</> : failureNotice }
  // One conversation (lib/conversation): stored rows, the live reply and the person's unsent messages in one store, each
  // under the id it keeps from the moment it shows (a submission id, `eve:<session>:<turn>`), in one order. A message
  // the server stores replaces its unsent or live self in place: nothing remounts and nothing moves on commit.
  const storedMessages = useMemo(() => items.filter(item => !staleEvents.has(item.position) && item.line?.kind !== 'runQuestion')
    .map((item): ConversationMessage => ({ id: storedChatMessageId(item), role: item.from === 'person' ? 'user' : 'assistant', parts: [{ type: 'text', text: item.text }],
      metadata: { at: item.createdAt ? Date.parse(item.createdAt) : 0, source: { item } satisfies BotChatSource } })), [items, staleEvents])
  const conversation = useConversation(`bot:${botId ?? 'coordinator'}`, {
    stored: storedMessages,
    live: stream.replies.map((reply): ConversationMessage => ({ id: reply.key, role: 'assistant', parts: [{ type: 'text', text: reply.text }],
      metadata: { at: 0, streaming: reply.committedThrough === undefined, source: { live: reply } satisfies BotChatSource } })),
    optimistic: localMessages.map((row): ConversationMessage => ({ id: row.id, role: 'user', parts: [{ type: 'text', text: row.text }],
      metadata: { at: row.at, delivery: row.phase === 'accepted' ? 'sent' : row.phase, ...(row.error ? { deliveryError: row.error } : {}), source: { local: row } satisfies BotChatSource } })),
  })
  // Edit and Regenerate on the latest turn, and its earlier versions (decision 2026-11-22-1700).
  const revision = useTurnRevision({ botId: botId ?? null, items, idle: !working && !resuming && !sending && !localMessages.length && !stream.replies.length, refresh: () => { void mutate() } })
  const turnOf = new Map<string, string>()
  const entries: ThreadEntry[] = []
  for (const message of conversation) {
    const source = message.metadata?.source as BotChatSource
    const key = message.id
    if ('local' in source) {
      const row = source.local
      entries.push({ id: key, role: 'person', at: row.at, text: splitReplyQuote(row.text).text,
        ...(messageReferences(row.text).length ? { body: <AgentCitationsContext value={personCitations}><PersonReferences text={splitReplyQuote(row.text).text} /></AgentCitationsContext> } : {}),
        status: message.metadata?.delivery ?? 'sent', deliveryMessage: message.metadata?.deliveryError,
        attachments: [...(row.context.quote ? [{ id: 'artifact-quote', name: row.context.quote.label ?? row.context.quote.text, meta: tMessage('quote') }] : []),
          ...(row.context.notes ?? []).map(note => ({ id: `note-${note.n}`, name: noteChipText(note), meta: tNavAll('Editor.richText.annotate') }))],
        ...(row.phase === 'failed' ? { onRetry: () => { void deliver(row.text, false, undefined, row) } } : {}) })
      continue
    }
    const item = 'item' in source ? source.item : streamedItem(source.live, stopping)
    const live = 'live' in source ? stopping && source.live.committedThrough === undefined ? { ...source.live, committedThrough: -1 } : source.live : undefined
    const at = item.createdAt ? Date.parse(item.createdAt) : Date.now()
    const streaming = Boolean(live && live.committedThrough === undefined)
    if (item.from === 'event') {
      const node = item.notice ? <QuotaSwitchLine notice={item.notice} botId={botId} /> : item.line ? <ChatEventLine line={item.line} citations={citations} /> : null
      if (node) entries.push({ id: key, role: 'bot', at, event: true, parts: [{ kind: 'text', text: '', node }] })
      continue
    }
    if (item.from === 'person') {
      const { quote, text } = splitReplyQuote(item.text)
      // A 建议 handed over is the chat's one-line record with its state, as Capy records a request: no card of its own.
      if (item.suggestion) entries.push({ id: `${key}-suggestion`, role: 'bot', at, event: true, parts: [{ kind: 'text', text: '',
        node: <SuggestionRow card={item.suggestion} status={item.pending ? tNavAll('HostedThread.sending') : t('suggestionHandedTo', { name })} /> }] })
      const attachments = [
        ...(item.quote ? [{ id: 'artifact-quote', name: data?.artifacts[item.quote.artifactId]?.title ?? item.quote.label ?? item.quote.text, meta: tMessage('quote') }] : []),
        ...(quote ? [{ id: 'reply-quote', name: quote, meta: tMessage('quote') }] : []),
        ...(item.notes ?? []).map(note => ({ id: `note-${note.n}`, name: noteChipText(note), meta: tNavAll('Editor.richText.annotate') })),
      ]
      const editor = revision.editor(item, text)
      if (item.submissionId) turnOf.set(key, item.submissionId)
      if (!item.suggestion || text || attachments.length) entries.push({ id: key, role: 'person', at, text, ...(attachments.length ? { attachments } : {}), status: item.pending ? 'sending' : 'sent',
        ...(editor ? { body: editor } : messageReferences(text).length ? { body: <AgentCitationsContext value={personCitations}><PersonReferences text={text} /></AgentCitationsContext> } : {}),
        actions: item.text && !editor ? <ReplyActions at={item.createdAt ? at : undefined} copyText={text} onEdit={revision.shown(item.submissionId) ? undefined : revision.onEdit(item)} versions={revision.pager(item)}>{item.id && <MessageReactions reactions={reactions[item.id]} align="end" />}</ReplyActions> : undefined })
      if (item.failure) entries.push({ id: `${key}-failure`, role: 'bot', at, parts: [item.position === failedAt ? liveFailurePart : { kind: 'error', text: t((item.failure.kind === 'failed' && item.failure.reason === 'modelRequired') ? 'modelRequired' : 'failedTitle'), actions: <FailureReason showReason={!(item.failure.kind === 'failed' && item.failure.reason === 'modelRequired')} retry={item.welcome} failure={item.failure} botId={botId} sending={sending} onResend={() => { if (item.welcome) void (botId ? retryCoordinatorTurn(botId) : retryCoordinatorTurn()).then(() => mutate()); else void deliver(item.text, false, item.position) }} /> }] })
      continue
    }
    const parts: ThreadEntryPart[] = item.welcome ? [] : replyRows(item, live).map((segment, index): ThreadEntryPart => segment.kind === 'tools'
      ? { kind: 'tools', id: `${key}-tools-${index}`, tools: toolRows(segment.tools, { live: streaming, citations, ...(live ? {} : { stored: { botId, position: item.position } }), ...(index === 0 && item.activity ? { thinking: live ? liveThinking(live) : undefined, thought: item.activity.thought } : {}) }) }
      : { kind: 'text', text: segment.text, node: <ReplyAnswer value={live ? null : answers.get(item.position) ?? null}><CoordinatorReply text={segment.text} carded={cardsOf(item, Boolean(live)).join(',')} citations={live ? streaming ? liveCitations.streaming : liveCitations.settled : citations} isStreaming={streaming} /></ReplyAnswer> })
    for (const id of cardsOf(item, Boolean(live))) {
      const run = sources?.[id]
      if (run?.kind === 'run') parts.push({ kind: 'task', run, onOpen: () => run.issue ? openTask(run.issue.id) : showThread({ runId: run.id }) })
    }
    const artifacts = item.artifacts.flatMap(id => data?.artifacts[id] ? [{ id, name: data.artifacts[id].title }] : [])
    if (artifacts.length) parts.push({ kind: 'artifacts', items: artifacts, onOpen: openArtifact, ...(embedded ? { activeId: embedded.activeArtifactId } : {}) })
    if (item.failure) parts.push(item.position === failedAt ? liveFailurePart : { kind: 'error', text: t((item.failure.kind === 'failed' && item.failure.reason === 'modelRequired') ? 'modelRequired' : 'failedTitle'), actions: <FailureReason showReason={!(item.failure.kind === 'failed' && item.failure.reason === 'modelRequired')} retry={item.welcome} failure={item.failure} botId={botId} sending={sending} onResend={() => { void (botId ? retryCoordinatorTurn(botId) : retryCoordinatorTurn()).then(() => mutate()) }} /> })
    // The read end rides at the end of the reply's action line, the reply's last row, so it adds no row of its own (an
    // empty part cost the thread's 12px gap plus its pixel). The line's opacity does not hide it from IntersectionObserver.
    // A reply with no line (no words) still marks its end with a part of its own.
    const readEnd = !live && item.position === unreadItems.findLast(row => row.reportable)?.position ? <VisibleReadEnd onSeen={unread.reportEnd} /> : null
    const lined = Boolean(item.text && !streaming)
    if (readEnd && !lined) parts.push({ kind: 'text', text: '', node: readEnd })
    entries.push({ id: key, role: 'bot', at, parts, streaming, ...(item.stopped ? { stopped: true } : {}),
      // When it was sent waits in its action bar, on hover, as LobeHub's (no centred time over the messages).
      actions: lined ? <ReplyActions at={item.createdAt ? at : undefined} copyText={replyCopyText(item.text)} onQuote={quoteReply} onRegenerate={revision.onRegenerate(item)}>
        <AgentCitationsContext value={citations}><CitationSources text={item.text} /></AgentCitationsContext>
        {item.id && <MessageReactions reactions={reactions[item.id]} align="start" />}
        {readEnd}
      </ReplyActions> : undefined })
  }
  // A turn paged back to an earlier version shows that version's words in place of the live turn.
  for (const [person, submissionId] of turnOf) {
    const version = revision.shown(submissionId)
    if (!version) continue
    const start = entries.findIndex(entry => entry.id === person)
    const next = entries.findIndex((entry, index) => index > start && entry.role === 'person')
    const replies = entries.slice(start + 1, next < 0 ? undefined : next).flatMap(entry => entry.role === 'bot' && !entry.event ? [entry.id] : [])
    entries.splice(0, entries.length, ...showTurnVersion(entries, { person, replies, submissionId }, version, words => [{ kind: 'text', text: words,
      node: <CoordinatorReply text={words} carded="" citations={citations} isStreaming={false} /> }]))
  }
  for (const waiting of mergeWaitings) entries.push({ id: `merge-waiting:${waiting.issueId}`, role: 'bot', at: Date.now(), event: true,
    parts: [{ kind: 'text', text: '', node: <MergeWaitingLine waiting={waiting} workspaceId={selectedWorkspaceId ?? null} /> }] })
  // Before the reply has anything to show: the Bot's turn with its Thinking row, once the turn has taken a moment,
  // counting the seconds since the person's message once past 2 s (LobeHub's wait for the first token).
  // The conversation's last word, the person's unsent message included: a turn answering it waits on the Bot's side.
  const lastWord = conversation.findLast(message => { const source = message.metadata?.source as BotChatSource; return !('item' in source && source.item.from === 'event') })
  const answered = lastWord?.role === 'assistant' && lastWord.parts.some(part => part.type === 'text' && part.text)
  if (working && waitedLong && lastWord && !answered && !stream.replies.length && !stopping) {
    const asked = entries.at(-1)
    // Keyed as the reply it waits for (`eve:<session>:<turn>`) once the server has the turn: the first words fill this
    // row instead of replacing it.
    const turnId = activeTurn(stream.view)?.turnId
    entries.push({ id: stream.session?.sessionId && turnId ? eveTurnMessageId(stream.session.sessionId, turnId) : 'waiting', role: 'bot', at: Date.now(), streaming: true,
      parts: [{ kind: 'text', text: '', node: <ReplyWaiting {...(asked?.role === 'person' ? { since: asked.at } : {})} /> }] })
  }
  if (welcomeFailed && !items.length) entries.push({ id: 'welcome-failure', role: 'bot', at: Date.now(), parts: [liveFailurePart] })
  // One error surface (lib/conversation): a turn's failure is the Bot's error line at the chat's end even when it has no
  // message of the person's to sit under; the composer keeps notices for what stops a send before it leaves.
  const quotaStopped = !refusal && declined === 'quotaUsed'
  if (failedAt === null && !welcomeFailed && !quotaStopped && (modelRequired || welcomeRequestFailed || (data?.error && !working)))
    entries.push({ id: `failure:${lastSaid?.position ?? 'chat'}`, role: 'bot', at: Date.now(), parts: [plainFailure ? liveFailurePart
      : { kind: 'error', failure: 'live', text: t(modelRequired ? 'modelRequired' : 'failedTitle'), actions: failureNotice }] })
  // As LobeHub's chat, the Bot's reply opens with its mark and name (Alex, 2026-11-22: chat look as LobeHub, except avatars).
  const botAuthor = { id: botId ?? 'coordinator', name, mark: avatar('message'), header: true }
  for (const entry of entries) if (entry.role === 'bot' && !entry.event && !entry.author) entry.author = botAuthor
  const empty = data && !items.length && !stream.replies.length && !data.error && !modelRequired && !welcomeRequestFailed ? (data.enabled
    ? <p role="status">{tNav('writingWelcome')}</p>
    : <p>{t('empty', { name })}</p>) : undefined
  // One blocking notice above the composer, the first that applies (UX audit 2026-11-22, issue 1): a chat that did not
  // load, the newest turn's failure when it has no message to sit under, a quota that stopped it, no model to answer,
  // a quota about to run out, no Bot to answer. 线程加载失败 is for a read that failed, never for a turn that did.
  const notice = blockingNotice({
    load: Boolean(loadError) || streamLoadFailed(stream.error, stream.view, delivery.rows.some(row => row.phase === 'failed')),
    quotaStopped,
    model: !data?.error && noModel,
    quota: !refusal && !data?.error && Boolean(modelMenu.data?.current.quota),
    unanswered,
  })
  // The footer's notices wait for the model menu, which says whether anything can answer, so they join together
  // instead of one by one; a chat's own failure joins with its read (a Bot switch grew the footer as each read landed).
  // A menu read for another Bot stands in until this one's is read (useBotModelMenu), so a switch draws the footer at once
  const footerReady = Boolean(loadError || modelMenu.data || !modelMenu.isLoading)
  const notices = !footerReady ? null : <>
    {notice === 'load' && <Alert variant="destructive" role="status" className={COMPOSER_NOTICE}><AlertTitle className="min-w-0 flex-1 basis-48" data-chat-failure="load">{t('loadError')}</AlertTitle><Button variant="ghost" size="sm" onClick={() => { void mutate() }}>{tCommon('retry')}</Button></Alert>}
    {paywall.dialog}
    <EveInteractions agent={stream} />
    {notice === 'model' && <HostedUnavailableNotice botId={botId} />}
    {(notice === 'quota' || notice === 'quotaStopped') && <QuotaNotice botId={botId} stopped={notice === 'quotaStopped'}
      retry={(label, disabled) => <RetryReplyButton botId={botId} onQueued={mutate} label={label} disabled={disabled} />} />}
    {notice === 'unanswered' && <Alert variant="destructive" className={COMPOSER_NOTICE}><AlertTitle className="min-w-0 flex-1 basis-48">{t('unavailable', { name })}</AlertTitle></Alert>}
    {botId && <SubagentLoginNeeds botId={botId} />}
    {/* One live sentence, not a stored event line; the thread is an inline link inside it (decision 2026-11-10). */}
    {waitingQuestions.length > 0 && <p data-slot="waiting-questions" className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-1 text-xs text-muted-foreground">
      <span role="status" aria-live="polite" aria-atomic="false" className="inline-flex min-w-0 items-center gap-1.5"><CircleHelp aria-hidden="true" className="size-3.5 shrink-0 text-warning" />{t('waitingQuestions', { count: waitingQuestions.length })}</span>
      {waitingQuestions[0].runId && <Button variant="link" size="xs" className="h-auto min-w-0 max-w-full px-0 font-normal" onClick={() => showThread({ runId: waitingQuestions[0].runId! })}><span className="min-w-0 truncate">{waitingQuestions[0].title}</span></Button>}
    </p>}
    <PendingActions />
  </>
  return <AgentThemeProvider><AgentInteractionContext value={{ busy: sending || Boolean(working), continueFromAnswer: prompt => post(prompt.trim()), answer: prompt => answer(prompt.trim()) }}>
    {/* The page's floating title pill sits over the top 56px on wide screens: the screen starts below it. Without one (the
        hosted shell owns the header and the thread names itself) no band is left. A narrow panel's holder places its own
        pill (the board's column) or has none (an Artifact's reader). */}
    <section ref={rootRef} aria-label={name} className={cn('mikka-agent flex min-h-0 min-w-0 flex-1 flex-col', pill && !panel && 'md:pt-14')}>
      {/* The board's column and an Artifact's reader are the same screen as the page, as a narrow panel (Capy's panel host). */}
      <ThreadScreen host={embedded ? 'embedded' : compact ? 'column' : 'page'} panel={panel} botId={botId} name={name} mark={avatar('pill')} entries={data || localMessages.length ? entries : null} empty={empty} panels={panel ? undefined : panels} work={work.work}
        transcriptLabel={bot ? t('conversationWith', { name: bot.name }) : t('conversation')}
        loadingLabel={!data && !loadError ? tCommon('loading') : undefined}
        // Scrolling near the top loads the page before, as LobeHub's useEarlierHistoryTrigger does.
        older={data?.historyBefore ? { loading: loadingHistory, auto: true, onLoad: () => void loadHistory() } : undefined}
        historyPrepend={historyPrepend} scrollRef={transcript}
        working={working && !stopping} onStop={stoppable && !resuming && !stopping ? () => { void stop() } : undefined}
        composer={{ ref: inputRef, leadingControls: <ChatComposerAttachment />, label: bot ? t('inputTo', { name: bot.name }) : t('input'), placeholder, value: draft, onChange: updateDraft, sending: resuming, editableWhileSending: resuming, submitDisabled: noModel, onSubmit: () => { void send() },
          attachmentScope: data?.botId ? { kind: 'bot', id: data.botId } : undefined, running: (working || stoppable) && !stopping,
          references: selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : undefined, commands: composerCommands, historyKey: stateKey, referenceSources: draftSources }}
        controls={embedded && data?.context ? <CoordinatorContextUsage usage={data.context} /> : undefined}
        // The row keeps its height before the read arrives (the ring's own), so the footer never grows after a switch.
        under={!embedded ? <div data-slot="thread-under-composer" className="flex min-h-6 min-w-0 items-center justify-end px-1">{data?.context && <CoordinatorContextUsage usage={data.context} />}</div> : undefined}
        pending={[
          ...(embedded?.quote ? [{ id: 'artifact-quote', name: embedded.quote.label ?? embedded.quote.text, meta: tMessage('quote'), onRemove: embedded.clearQuote }] : []),
          ...(replyQuote ? [{ id: 'reply-quote', name: replyQuote, meta: tMessage('quote'), onRemove: () => setReplyQuote(null) }] : []),
          ...(browser?.notes ?? []).map(note => ({ id: `note-${note.n}`, name: noteChipText(note), meta: tNavAll('Editor.richText.annotate'), onRemove: () => browser?.remove(note.n) })),
        ]}
        notices={<>{notices}{turnOptions}{queuedNotice}{factory.error && <Alert variant="destructive" className={COMPOSER_NOTICE}><AlertTitle className="min-w-0 flex-1">{actionError()}</AlertTitle><Button variant="ghost" size="sm" onClick={() => { void factory.reload() }}>{tCommon('retry')}</Button></Alert>}</>}
        questions={factory.questions.map(question => {
          const reason = factoryQuestionUnavailable(question.status)
          return { id: question.questionId, revision: question.reference.questionRevision, question: question.question, task: question.task, recordedAnswer: question.recordedAnswer, unavailable: reason ? actionError(reason) : undefined, taskId: question.issueId ?? undefined,
          kind: question.type === 'permission' ? 'approval' : question.options.length ? 'decision' : 'question', ...(question.options.length ? { options: question.options.map(option => ({ id: option.value, title: option.label })) } : {}) }
        })}
        onAnswer={async (id, text) => {
          const question = factory.questions.find(item => item.questionId === id)
          if (!question) return { status: 'unavailable', error: actionError('factoryQuestionClosed') }
          const receipt = await factory.submitAnswer(question, text)
          return receipt.status === 'accepted' ? receipt : { ...receipt, error: actionError(receipt.error) }
        }}
        running={Object.values(sources ?? {}).filter(source => source.kind === 'run' && !source.finishedAt).length}
        onOpenTask={openTask} onOpenInbox={() => navigate({ section: 'suggestions' })} />
      <SelectionQuote root={rootRef} onQuote={quoteReply} />
    </section>
  </AgentInteractionContext></AgentThemeProvider>
}

/** Eve binds one immutable session per mount; identity changes destroy that reader and its state. */
export function CoordinatorChat(props: Parameters<typeof CoordinatorChatSession>[0]) {
  const scope = useLiveScope()
  return <CoordinatorChatSession key={`${props.userId ?? scope?.ownerId ?? 'session'}:${scope?.workspaceId ?? ''}:${props.bot?.id ?? 'coordinator'}`} {...props} />
}

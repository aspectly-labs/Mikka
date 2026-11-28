'use server'

import { singleFlight } from '@/lib/single-flight'
import { withDatabaseOperation } from '@/lib/db/egress-sample'
import { ownerListRead } from '@/lib/live/list-read-server'
import { beginOwnerListRead, readRevisions } from '@/lib/live/revision-read'
import { withReadOnlyPolicyObservation } from '@/lib/desktop-rpc/read-batch-context'
import type { ListLiveRead } from '@/lib/live/list-read'

import { cookies, headers } from '@/lib/server-runtime/headers'
import { storedLocale } from '@/i18n/locale-cookie.mjs'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { db, pool } from '@/lib/db'
import { ExecutionSettings } from '@/lib/execution-settings'
import { botModelPreference, resolveBotModelChoice } from '@/lib/bot-model-choice'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { userMessageEvent } from '@/lib/coordinator-events'
import { botChats, chatVersionState, chatView, citationSources, storedReasoning, type BotChatSummary, type ChatView } from '@/lib/coordinator/store'
import * as chatStore from '@/lib/coordinator/store'
import { refreshChatMetadata, type UnchangedChat } from '@/lib/coordinator/chat-poll'
import type { CitationSource } from '@/lib/coordinator/citations'
import { reasoningText, storedToolText } from '@/lib/coordinator/reasoning-mask'
import { readCoordinatorToolCall, type StoredToolCall } from '@/lib/coordinator/tool-call-read'
import { credentialChatFingerprints } from '@/lib/credentials/chat-guard'
import { and, eq, sql } from 'drizzle-orm'
import { chatBotId, type openChatBotId } from '@/lib/coordinator/coordinator-bot'
import { bots } from '@/lib/db/schema'
import { coordinatorEnabled } from '@/lib/coordinator/wake'
import { coordinatorWelcome } from '@/lib/agent-welcome'
import { handoffSuggestionToCoordinator } from '@/lib/suggestions/handoff'
import { issueMutationsEnabled } from '@/lib/coordinator/issue-tools-enabled'
import { cacheReadAction } from '@/lib/cache-read-action'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'

async function getUser() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return { ...session.user, [enterprisePrincipal]: { kind: 'session' as const, sessionId: session.session.id } }
}

async function getUserId(): Promise<string> {
  return (await getUser()).id
}

/** `botId` is the chat's bot row, the Coordinator's included. */
export type CoordinatorChat = ChatView & { botId: string; enabled: boolean; version?: string; after?: number; baseCursor?: number; metadataRefresh?: boolean; live?: ListLiveRead }

const botIdSchema = z.uuid().nullable()

/**
 * The bot whose chat this is: `botId` if it is one of the person's, or their
 * Coordinator's bot row when the caller names none (the Coordinator's entry
 * in the bot list).
 */
async function ownBot(user: Parameters<typeof openChatBotId>[0], botId: string | null | undefined): Promise<{ id: string; name: string; coordinator: boolean; workspaceId: string }> {
  const userId = user.id
  const parsed = botIdSchema.safeParse(botId ?? null)
  if (!parsed.success) throw new ActionFailureError('validationGeneric')
  // No bot named: the Coordinator of the workspace the person has open.
  const context = await loadWorkspaceContext(undefined, user)
  const id = await chatBotId(userId, parsed.data, context.workspace.id)
  const [bot] = await db.select({ id: bots.id, name: bots.name, workspaceId: bots.workspaceId, coordinator: sql<boolean>`exists (select 1 from coordinator_bots cb where cb."botId" = ${bots.id})` })
    .from(bots).where(and(eq(bots.id, id), eq(bots.ownerId, userId), eq(bots.workspaceId, context.workspace.id))).limit(1)
  if (!bot) throw new ActionFailureError('botNotFound')
  return bot
}

/** ownBot has already authorized the actor in this persisted bot workspace.
 * Match the writer's tenant channel without resolving a different personal home. */
async function beginBotChatRead(ownerId: string, bot: { id: string; workspaceId: string }) {
  const scope = { ownerId, workspaceId: bot.workspaceId }
  return { scope, revisions: await readRevisions([{ kind: 'bot_chat', id: bot.id }]) }
}

/** The person's chat with their Coordinator, or with one of their bots: every bot runs on the same harness. */
export async function getCoordinatorChat(botId: string | null = null): Promise<CoordinatorChat> {
  return withDatabaseOperation('/actions/coordinator/chat', () => readFullChat(botId))
}

async function readFullChat(botId: string | null): Promise<CoordinatorChat> {
  const user = await getUser()
  const userId = user.id
  const bot = await ownBot(user, botId)
  const enabled = await withReadOnlyPolicyObservation(() => coordinatorEnabled(user.id, bot.id))
  // Before the chat: a push at this revision or below is already in what follows.
  const begun = await beginBotChatRead(userId, bot)
  const { chat, expiries, observedAt } = await chatStore.chatViewState(userId, 200, bot.id)
  // The legacy/mobile full reader retains the same authorized bot tenant and
  // deadline as incremental reads; web sidebars use chat summaries instead.
  const live = await ownerListRead(userId, expiries, observedAt, begun)
  // Without a Coordinator here nothing is coming, so do not show one working.
  return { ...chat, botId: bot.id, enabled, working: enabled && chat.working, live }
}

const versionSchema = z.string().regex(/^[0-9a-f]{32}$/).optional()
const continuationSchema = z.object({ after: z.number().int().min(0), cursor: z.number().int().min(0), prefix: z.string().regex(/^[0-9a-f]{32}$/), restoreToolMetadata: z.literal(true).optional(), sourceIds: z.array(z.uuid()).max(400).optional(), artifactIds: z.array(z.uuid()).max(400).optional() }).optional()

/**
 * The chat for a poll that already shows version `known`: only its live state
 * when nothing in the conversation changed, the whole chat otherwise.
 */
export async function pollCoordinatorChat(botId: string | null = null, known?: string, continuation?: z.infer<typeof continuationSchema>): Promise<CoordinatorChat | UnchangedChat> {
  return withDatabaseOperation('/actions/coordinator/poll', () => readCoordinatorChat(botId, known, continuation))
}

/** Expected authorization failures cross the Server Action boundary as codes,
 * so a local cache can erase them instead of retaining data under a redacted
 * production exception. The established reader and cursor stay unchanged. */
export async function syncCoordinatorChat(botId: string | null = null, known?: string, continuation?: z.infer<typeof continuationSchema>): Promise<ActionResult<{ chat: CoordinatorChat | UnchangedChat }>> {
  return cacheReadAction(async () => ({ chat: await pollCoordinatorChat(botId, known, continuation) }))
}

async function readCoordinatorChat(botId: string | null, known?: string, continuation?: z.infer<typeof continuationSchema>): Promise<CoordinatorChat | UnchangedChat> {
  // Each request is authorized on its own: the session and its ownership of this bot.
  const user = await getUser()
  const bot = await ownBot(user, botId)
  const enabled = await withReadOnlyPolicyObservation(() => coordinatorEnabled(user.id, bot.id))
  const parsed = versionSchema.safeParse(known)
  const proof = continuationSchema.safeParse(continuation)
  const previous = proof.success && proof.data ? { ...proof.data,
    sourceIds: [...new Set(proof.data.sourceIds ?? [])].sort(), artifactIds: [...new Set(proof.data.artifactIds ?? [])].sort(),
  } : undefined
  const heldVersion = parsed.success ? parsed.data : undefined
  // Before the chat: a push at this revision or below is already in what follows.
  const begun = await beginBotChatRead(user.id, bot)
  const { expiries, observedAt, ...current } = await chatVersionState(user.id, 200, bot.id)
  // The bot's tenant channel says when to read again; a lease running out is the one change with no write.
  const live = await ownerListRead(user.id, expiries, observedAt, begun)
  // Each request observes the current version before joining: a deletion or a
  // new turn cannot join an older transcript still being read. Normalize only
  // the validated, bounded cursor; a full read and a saved tail stay distinct.
  const shared = await singleFlight(['/actions/coordinator/poll', user.id, bot.id, current.version, heldVersion ?? null,
    previous ? JSON.stringify(previous) : null], async (): Promise<CoordinatorChat | UnchangedChat> => {
    if (heldVersion === current.version && !previous?.restoreToolMetadata) return { unchanged: true, ...current, botId: bot.id, enabled, working: enabled && current.working, live }
    const chat = await chatStore.chatUpdate(user.id, bot.id, previous)
    // Carry the leader's revision, read before its transcript. A joiner's newer
    // revision must never acknowledge a write absent from this shared data.
    return { ...chat, version: current.version, botId: bot.id, enabled, working: enabled && chat.working, live }
  })
  // This stays outside the flight, after awaiting it: cited task and artifact
  // access may have changed while another request was reading the transcript.
  return refreshChatMetadata(shared, previous, async ({ sourceIds, artifactIds }) => {
    const { artifactSummaries } = await import('@/lib/artifacts/store')
    const [sources, artifacts] = await Promise.all([
      citationSources({ ...user, [tokenWorkspace]: bot.workspaceId }, sourceIds.map(id => `[[issue:${id}]] [[run:${id}]]`)),
      artifactSummaries({ ...user, [tokenWorkspace]: bot.workspaceId }, artifactIds),
    ])
    return { sources, artifacts }
  })
}

/** A bounded older page overlaps the first rendered item, preserving multi-step reply grouping. The app's pages are
 * `CHAT_FIRST_PAGE` long; at most 200. */
export async function coordinatorHistory(botId: string | null, through: number, limit = 200): Promise<ChatView> {
  z.number().int().min(0).parse(through)
  z.number().int().min(1).max(200).parse(limit)
  return withDatabaseOperation('/actions/coordinator/history', async () => {
    const user = await getUser()
    const bot = await ownBot(user, botId)
    return chatView(user.id, limit, bot.id, { through })
  })
}

const citedIdsSchema = z.array(z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)).min(1).max(50)

/**
 * The issues and runs a reply still streaming cites, that this person can see: the chat's own sources come
 * from stored replies only, so a task or thread the reply has just made would otherwise show as its marker.
 */
export async function coordinatorCitationSources(ids: readonly string[]): Promise<Record<string, CitationSource>> {
  const parsed = citedIdsSchema.safeParse(ids)
  if (!parsed.success) return {}
  const user = await getUser()
  const context = await loadWorkspaceContext(undefined, user)
  return citationSources({ ...user, [tokenWorkspace]: context.workspace.id }, [parsed.data.join(' ')])
}

const reasoningPositionsSchema = z.array(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)).min(1).max(50)

/**
 * What a stored reply thought, for the chat's 「思考了」 when the person opens it: the readable reasoning of the
 * person's own messages at `positions` in this bot's chat, masked as the live stream masks it. Null when there is none.
 */
export async function coordinatorReasoning(botId: string | null, positions: readonly number[]): Promise<string | null> {
  const parsed = reasoningPositionsSchema.safeParse(positions)
  if (!parsed.success) return null
  const user = await getUser()
  const bot = await ownBot(user, botId)
  const fingerprints = await credentialChatFingerprints(user.id)
  const texts = (await storedReasoning(user.id, bot.id, parsed.data)).flatMap(text => reasoningText(user.id, text, fingerprints) ?? [])
  return texts.length ? texts.join('\n\n') : null
}

const toolCallSchema = z.object({ position: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), toolCallId: z.string().min(1).max(200) })

/**
 * One stored tool call of this bot's chat, whole up to about 64 KB each way, for the row the person opened (Alex,
 * 2026-11-22: as Claude, ChatGPT and Cursor). The chat's own reads keep only previews. Owner-only: the bot must be
 * the person's, in the workspace they have open. Stored messages are masked when saved; a side that still holds one
 * of the person's saved secrets is left out, as reasoning is. Null when there is no such call.
 */
export async function coordinatorToolCall(botId: string | null, position: number, toolCallId: string): Promise<StoredToolCall | null> {
  const parsed = toolCallSchema.safeParse({ position, toolCallId })
  if (!parsed.success) return null
  const user = await getUser()
  const bot = await ownBot(user, botId)
  const call = await readCoordinatorToolCall(pool, { ownerId: user.id, workspaceId: bot.workspaceId, botId: bot.id, ...parsed.data })
  if (!call) return null
  const fingerprints = await credentialChatFingerprints(user.id)
  const safe = (text: string | undefined) => text === undefined ? undefined : storedToolText(user.id, text, fingerprints)
  const input = safe(call.input), output = safe(call.output)
  return { ...(input !== undefined ? { input, ...(call.inputCut ? { inputCut: true as const } : {}) } : {}),
    ...(output !== undefined ? { output, ...(call.outputCut ? { outputCut: true as const } : {}) } : {}) }
}

/** Each bot's latest line and whether it is answering, for the bot list. */
export async function botChatSummaries(): Promise<Record<string, BotChatSummary>> {
  const user = await getUser()
  const context = await loadWorkspaceContext(undefined, user)
  return botChats({ ...user, [tokenWorkspace]: context.workspace.id })
}

/** Same owner-wide summaries, including the actual working-state deadline. */
export async function pollBotChatSummaries() {
  return withDatabaseOperation('/actions/coordinator/summaries', readBotChatSummaries)
}

async function readBotChatSummaries() {
  const user = await getUser()
  const ownerId = user.id
  const context = await loadWorkspaceContext(undefined, user)
  const begun = await beginOwnerListRead(ownerId, ['bot_chat_list'])
  const snapshot = await chatStore.botChatSnapshot({ ...user, [tokenWorkspace]: context.workspace.id })
  return { items: snapshot.items, live: await ownerListRead(ownerId, snapshot.expiries, snapshot.observedAt, begun) }
}

/**
 * An empty chat asks its bot for a welcome, the Coordinator's included: a
 * greeting and one question about where to start. Once only: nothing happens
 * when the chat already has messages or anything waiting.
 */
export async function welcomeCoordinator(botId: string | null = null): Promise<ActionResult<{ queued: boolean; reason?: 'modelRequired' }>> {
  return runAction(async () => {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.user) throw new ActionFailureError('authRequired')
    const bot = await ownBot(session.user, botId)
    if (!await coordinatorEnabled(session.user.id, bot.id)) return { queued: false }
    const chat = await chatView(session.user.id, 1, bot.id)
    if (chat.items.length || chat.working || chat.error) return { queued: false }
    const scope = { ownerId: session.user.id, workspaceId: bot.workspaceId }
    const choice = await resolveBotModelChoice(pool, new ExecutionSettings(pool), scope, bot.id, await botModelPreference(pool, scope, bot.id))
    if (choice.kind === 'none') return { queued: false, reason: 'modelRequired' }
    const jar = await cookies()
    const locale = storedLocale((name) => jar.get(name)?.value) ?? 'zh-CN'
    const event = userMessageEvent(session.user.id, coordinatorWelcome(session.user.name ?? '', locale, bot.coordinator ? undefined : bot.name), { botId: bot.id })
    await recordCoordinatorEvent(db, { ...event, payload: { ...event.payload, source: 'coordinator_welcome' } })
    return { queued: true }
  })
}

/** 停止 in a chat: the turn working there ends, keeping what its reply had said, marked 已停止. */
export async function stopCoordinatorTurn(botId: string | null = null): Promise<ActionResult<{ stopped: boolean }>> {
  return runAction(async () => {
    const user = await getUser()
    const bot = await ownBot(user, botId)
    const { stopChatTurn } = await import('@/lib/coordinator/stop-turn')
    return { stopped: await stopChatTurn(user.id, bot.id) }
  })
}

/** 重试 on a failed reply: the same turn again, once per click; the chat shows its normal working state. */
export async function retryCoordinatorTurn(botId: string | null = null): Promise<ActionResult<{ queued: true } | { queued: false; reason: 'unavailable' | 'working' | 'nothingToRetry' | 'accountUnavailable' }>> {
  return runAction(async () => {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.user) throw new ActionFailureError('authRequired')
    const bot = await ownBot(session.user, botId)
    if (!await coordinatorEnabled(session.user.id, bot.id)) return { queued: false as const, reason: 'unavailable' as const }
    return (await import('@/lib/eve/retry')).retryEveTurn(session.user.id,bot.id,await headers())
  })
}

/**
 * 编辑 on the person's last message, or 重新生成 on the reply to it (decision 2026-11-22-1700): the turn leaves the chat
 * and the Bot's history, kept as a version, and the edited or the same words go again. Only the chat's owner, only the
 * latest turn, and only a turn of words alone (no tool, thread or task happened in it); anything else is refused.
 */
export async function reviseCoordinatorTurn(botId: string | null, input: import('@/lib/coordinator/turn-revisions').RevisionInput): Promise<ActionResult<{ queued: true; submissionId: string } | { queued: false; reason: 'unavailable' | 'working' }>> {
  return runAction(async () => {
    const user = await getUser()
    const bot = await ownBot(user, botId)
    const { revisionInput } = await import('@/lib/coordinator/turn-revisions')
    const parsed = revisionInput.safeParse(input)
    if (!parsed.success) throw new ActionFailureError('validationGeneric')
    if (!await coordinatorEnabled(user.id, bot.id)) return { queued: false as const, reason: 'unavailable' as const }
    const { assertEveScope } = await import('@/lib/eve/scope')
    const scope = await assertEveScope({ ownerId: user.id, botId: bot.id, workspaceId: bot.workspaceId, surface: 'web' })
    return (await import('@/lib/eve/revise')).reviseEveTurn(scope, parsed.data, await headers())
  })
}

/** The earlier versions of the chat's revised turns, by the submission id of the message that stands for each now. */
export async function coordinatorTurnVersions(botId: string | null): Promise<Record<string, import('@/lib/coordinator/turn-revisions').TurnVersion[]>> {
  const user = await getUser()
  const bot = await ownBot(user, botId)
  return (await import('@/lib/coordinator/turn-revisions')).readTurnVersions(db as never, user.id, bot.id)
}

/**
 * A tapped 建议 card goes to the Coordinator at once, with no composer step
 * (R-21): the message is the card itself, which the chat draws as the same
 * card and the Coordinator reads as the task. What came from the source app
 * stays quoted inside the card (lib/suggestions/card.ts), never loose in the
 * message. Sending and taking the card off 建议 commit together; with no
 * Coordinator to read it, nothing is sent and the card stays.
 */
export async function sendSuggestion(suggestionId: string): Promise<ActionResult<{ queued: true }>> {
  return runAction(async () => handoffSuggestionToCoordinator(await getUserId(), suggestionId))
}

/** Whether the new-task dialog can create a task; it explains itself when this is off. */
export async function issueCreationAvailable(): Promise<boolean> {
  return issueMutationsEnabled()
}

/**
 * Real Eve `/compact` (#3333 Bug 2): calls the Eve session's `…/compact` HTTP route
 * (`ClientSession.compact()`) directly rather than sending a wrapped text message.
 */
export async function compactBotChat(botId: string | null = null): Promise<ActionResult<{ compacted: boolean }>> {
  return runAction(async () => {
    const user = await getUser()
    const bot = await ownBot(user, botId)
    if (!await coordinatorEnabled(user.id, bot.id)) throw new ActionFailureError('coordinatorUnavailable')
    const { assertEveScope } = await import('@/lib/eve/scope')
    const { eveInternalOrigin } = await import('@/lib/eve/server-client')
    const { eveRetryHeaders } = await import('@/lib/eve/retry')
    const { Client } = await import('eve/client')
    const scope = await assertEveScope({ ownerId: user.id, botId: bot.id, workspaceId: bot.workspaceId, surface: 'web' })
    const base = new URL(eveInternalOrigin())
    base.searchParams.set('botId', scope.botId)
    const client = new Client({ baseUrl: base.toString(), headers: eveRetryHeaders(await headers()), redirect: 'manual' })
    const { session } = await client.sessions.create()
    const delivery = await session.compact()
    const settled = await delivery.result()
    return { compacted: settled.status !== 'failed' }
  })
}

/**
 * Real Eve `/clear` (#3333): clears the Eve session's conversation history via
 * `ClientSession.clear()`.
 */
export async function clearBotChat(botId: string | null = null): Promise<ActionResult<{ cleared: boolean }>> {
  return runAction(async () => {
    const user = await getUser()
    const bot = await ownBot(user, botId)
    if (!await coordinatorEnabled(user.id, bot.id)) throw new ActionFailureError('coordinatorUnavailable')
    const { assertEveScope } = await import('@/lib/eve/scope')
    const { eveInternalOrigin } = await import('@/lib/eve/server-client')
    const { eveRetryHeaders } = await import('@/lib/eve/retry')
    const { Client } = await import('eve/client')
    const scope = await assertEveScope({ ownerId: user.id, botId: bot.id, workspaceId: bot.workspaceId, surface: 'web' })
    const base = new URL(eveInternalOrigin())
    base.searchParams.set('botId', scope.botId)
    const client = new Client({ baseUrl: base.toString(), headers: eveRetryHeaders(await headers()), redirect: 'manual' })
    const { session } = await client.sessions.create()
    const delivery = await session.clear()
    const settled = await delivery.result()
    return { cleared: settled.status !== 'failed' }
  })
}

/** Unified `/` commands for an Eve Bot / Coordinator chat (#3333). */
export async function getBotCommands(botId: string | null = null) {
  const user = await getUser()
  await ownBot(user, botId)
  const { readBotAvailableCommands } = await import('@/lib/thread-commands')
  return readBotAvailableCommands(pool, user.id)
}

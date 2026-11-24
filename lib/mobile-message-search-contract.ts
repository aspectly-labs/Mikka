import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseSearchQuery, SearchInputError } from '@/lib/issue-search'
import { splitChatFiles } from '@mikka/protocol/chat-attachments'

export const MESSAGE_SEARCH_SCOPES = ['all', 'bot', 'group', 'thread'] as const
export type MessageSearchScope = (typeof MESSAGE_SEARCH_SCOPES)[number]

export const MESSAGE_SEARCH_LIMIT_DEFAULT = 20
export const MESSAGE_SEARCH_LIMIT_MAX = 50
export const MESSAGE_SEARCH_SNIPPET_MAX = 220

const cursorTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .refine(
    value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 23) === value.slice(0, 23),
  )

const cursorSchema = z
  .object({
    v: z.literal(1),
    binding: z.string().length(64),
    key: z.object({ time: cursorTime, id: z.uuid() }).strict(),
  })
  .strict()

export type MessageSearchCursorKey = z.infer<typeof cursorSchema>['key']

export interface MessageSearchInput {
  q: string
  workspaceId: string
  scope: MessageSearchScope
  botId: string | null
  conversationId: string | null
  limit: number
  cursor: MessageSearchCursorKey | null
  binding: string
}

export interface MobileMessageSearchHit {
  kind: 'bot' | 'group' | 'thread'
  messageId: string
  targetId: string
  title: string
  snippet: string
  authorType: 'user' | 'bot' | 'agent'
  position: string | null
  createdAt: string
}

export interface MobileMessageSearchPage {
  workspaceId: string
  query: string
  items: MobileMessageSearchHit[]
  nextCursor: string | null
}

const ALLOWED_PARAMS = new Set(['q', 'workspaceId', 'scope', 'botId', 'conversationId', 'limit', 'cursor'])

/**
 * Parses `GET /api/mobile/search/messages` query parameters and binds any
 * pagination cursor to the exact caller, workspace, scope, filter and query.
 */
export function parseMessageSearchInput(
  params: URLSearchParams,
  userId: string,
  defaultWorkspaceId: string,
): MessageSearchInput {
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key) || params.getAll(key).length !== 1) {
      throw new SearchInputError('searchInvalidParam')
    }
  }
  const q = (params.get('q') ?? '').trim()
  if (!q) throw new SearchInputError('searchQueryTooShort')
  parseSearchQuery(q)

  const rawWorkspace = params.get('workspaceId')
  const workspaceId = rawWorkspace ?? defaultWorkspaceId
  if (!z.uuid().safeParse(workspaceId).success) throw new SearchInputError('searchInvalidParam')

  const rawScope = params.get('scope') ?? 'all'
  if (!(MESSAGE_SEARCH_SCOPES as readonly string[]).includes(rawScope)) {
    throw new SearchInputError('searchInvalidParam')
  }
  const scope = rawScope as MessageSearchScope

  const botId = params.get('botId')
  if (botId !== null && !z.uuid().safeParse(botId).success) throw new SearchInputError('searchInvalidParam')
  const conversationId = params.get('conversationId')
  if (conversationId !== null && !z.uuid().safeParse(conversationId).success) {
    throw new SearchInputError('searchInvalidParam')
  }
  // Reject contradictory scope/target combinations instead of silently ignoring filters.
  if (botId && conversationId) throw new SearchInputError('searchInvalidParam')
  if (botId && scope !== 'all' && scope !== 'bot') throw new SearchInputError('searchInvalidParam')
  if (conversationId && scope !== 'all' && scope !== 'group') throw new SearchInputError('searchInvalidParam')

  const rawLimit = params.get('limit')
  if (rawLimit !== null && !/^[1-9]\d?$/.test(rawLimit)) throw new SearchInputError('searchInvalidParam')
  const limit = rawLimit === null ? MESSAGE_SEARCH_LIMIT_DEFAULT : Number(rawLimit)
  if (limit > MESSAGE_SEARCH_LIMIT_MAX) throw new SearchInputError('searchInvalidParam')

  const binding = createHash('sha256')
    .update(JSON.stringify([userId, workspaceId, scope, botId, conversationId, q]))
    .digest('hex')

  const rawCursor = params.get('cursor')
  let cursor: MessageSearchCursorKey | null = null
  if (rawCursor !== null) {
    if (rawCursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(rawCursor)) {
      throw new SearchInputError('searchInvalidParam')
    }
    try {
      const decoded = cursorSchema.parse(JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')))
      if (decoded.binding !== binding) throw new Error('cursor context mismatch')
      cursor = decoded.key
    } catch (error) {
      throw Object.assign(new SearchInputError('searchInvalidParam'), { cause: error })
    }
  }

  return { q, workspaceId, scope, botId, conversationId, limit, cursor, binding }
}

export function encodeMessageSearchCursor(input: Pick<MessageSearchInput, 'binding'>, key: MessageSearchCursorKey): string {
  return Buffer.from(JSON.stringify({ v: 1, binding: input.binding, key })).toString('base64url')
}

/**
 * Strips inline file references, citation tokens and extra whitespace, then
 * slices a bounded plain-text snippet centered on the first match of `query`.
 */
export function buildMessageSearchSnippet(rawText: string, query: string, maxLength = MESSAGE_SEARCH_SNIPPET_MAX): string {
  const withoutFiles = splitChatFiles(rawText).text
  const cleaned = withoutFiles
    .replace(/\[\[(?:issue|run|artifact):[^\]]+\]\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  if (cleaned.length <= maxLength) return cleaned

  const needle = query.trim().toLowerCase()
  const idx = needle ? cleaned.toLowerCase().indexOf(needle) : -1
  if (idx < 0) return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`

  const lead = Math.max(0, Math.floor((maxLength - needle.length) / 2))
  const start = Math.max(0, Math.min(idx - lead, cleaned.length - maxLength))
  const end = Math.min(cleaned.length, start + maxLength)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < cleaned.length ? '…' : ''
  const slice = cleaned.slice(start, end).trim()
  return `${prefix}${slice}${suffix}`
}

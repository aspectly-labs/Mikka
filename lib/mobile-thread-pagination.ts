import { z } from 'zod'

export const THREAD_PAGE_LIMIT_DEFAULT = 50
export const THREAD_PAGE_LIMIT_MAX = 100

const cursorSchema = z
  .object({
    v: z.literal(1),
    id: z.string().min(1).max(300),
    index: z.number().int().min(0).max(1_000_000),
  })
  .strict()

export type ThreadHistoryCursor = z.infer<typeof cursorSchema>

export type ThreadPageRequest =
  | { paged: false }
  | { paged: true; limit: number; before: ThreadHistoryCursor | null }

export interface ThreadItemsPage<T> {
  items: T[]
  historyBefore: string | null
  hasMore: boolean
  totalItems: number
}

export function encodeThreadHistoryCursor(cursor: Pick<ThreadHistoryCursor, 'id' | 'index'>): string {
  return Buffer.from(JSON.stringify({ v: 1, id: cursor.id, index: cursor.index })).toString('base64url')
}

export function decodeThreadHistoryCursor(raw: string): ThreadHistoryCursor | null {
  if (!raw || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Parses optional `?limit=&before=` parameters for `GET /api/mobile/threads/:id`.
 * When neither parameter is sent, returns `{ paged: false }` so legacy callers
 * continue receiving the full thread unchanged.
 */
export function parseThreadPageParams(params: URLSearchParams): ThreadPageRequest | null {
  const hasLimit = params.has('limit')
  const hasBefore = params.has('before')
  if (!hasLimit && !hasBefore) return { paged: false }

  let limit = THREAD_PAGE_LIMIT_DEFAULT
  if (hasLimit) {
    const rawLimit = params.get('limit') ?? ''
    if (!/^[1-9]\d{0,2}$/.test(rawLimit)) return null
    limit = Number(rawLimit)
    if (limit < 1 || limit > THREAD_PAGE_LIMIT_MAX) return null
  }

  let before: ThreadHistoryCursor | null = null
  if (hasBefore) {
    before = decodeThreadHistoryCursor(params.get('before') ?? '')
    if (!before) return null
  }

  return { paged: true, limit, before }
}

/**
 * Slices an oldest-first thread item list from the end (latest page) or before
 * a previous page's oldest item cursor, returning an opaque `historyBefore`
 * token when older items remain.
 */
export function sliceThreadItemsPage<T extends { id: string }>(
  items: readonly T[],
  page: ThreadPageRequest,
): ThreadItemsPage<T> {
  if (!page.paged) {
    return {
      items: [...items],
      historyBefore: null,
      hasMore: false,
      totalItems: items.length,
    }
  }

  let end = items.length
  if (page.before !== null) {
    const matchIndex = items.findIndex(item => item.id === page.before!.id)
    end = matchIndex >= 0 ? matchIndex : Math.min(page.before.index, items.length)
  }

  const start = Math.max(0, end - page.limit)
  const sliced = items.slice(start, end)
  const hasMore = start > 0
  const historyBefore =
    hasMore && sliced[0] ? encodeThreadHistoryCursor({ id: sliced[0].id, index: start }) : null

  return {
    items: sliced,
    historyBefore,
    hasMore,
    totalItems: items.length,
  }
}

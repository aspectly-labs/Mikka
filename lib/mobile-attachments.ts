import 'server-only'
import { pool } from '@/lib/db'
import { apiWorkspaceAllowed, type ApiSession } from '@/lib/api-auth'
import { enterpriseWorkspaceAllowed } from '@/lib/enterprise/access'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import {
  authorizeFileScope,
  chatFileDownloadUrl,
  fileScope,
  type FileRow,
} from '@/lib/chat-attachments/store'
import { ChatFileError } from '@/lib/chat-attachments/extract'
import type { MobileAttachmentItem, MobileAttachmentsQuery } from './mobile-attachments-contract'

export {
  MOBILE_ATTACHMENTS_LIMIT_DEFAULT,
  MOBILE_ATTACHMENTS_LIMIT_MAX,
  MOBILE_ATTACHMENTS_MAX_IDS,
  parseMobileAttachmentsQuery,
  type MobileAttachmentItem,
  type MobileAttachmentsQuery,
} from './mobile-attachments-contract'

type StoredAttachmentRow = Pick<
  FileRow,
  'id' | 'userId' | 'botId' | 'conversationId' | 'runId' | 'name' | 'mediaType' | 'size' | 'storageKey' | 'usedAt'
> & { createdAt: Date | string }

// Never select `inlineData` or `textContent` on metadata listings: self-hosted
// installs store up to 25 MiB per file inline, so loading full bytes for a
// 50-row metadata batch would buffer >1 GiB.
const SELECT_COLUMNS =
  'id,"userId","botId","conversationId","runId",name,"mediaType",size,"storageKey","usedAt","createdAt"'

async function toItem(row: StoredAttachmentRow, download: boolean): Promise<MobileAttachmentItem> {
  const downloadUrl = await chatFileDownloadUrl(row, download)
  return {
    id: row.id,
    name: row.name,
    mediaType: row.mediaType,
    size: row.size,
    scope: fileScope(row),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    downloadPath: `/api/chat/attachments/${row.id}${download ? '?download' : ''}`,
    downloadUrl,
  }
}

async function workspacePermitted(
  session: ApiSession,
  workspaceId: string,
  enterpriseCache: Map<string, boolean>,
): Promise<boolean> {
  if (!apiWorkspaceAllowed(session, workspaceId)) return false
  let allowed = enterpriseCache.get(workspaceId)
  if (allowed === undefined) {
    allowed = await enterpriseWorkspaceAllowed(session.user.id, workspaceId, session.user[enterprisePrincipal])
    enterpriseCache.set(workspaceId, allowed)
  }
  return allowed
}

/**
 * Authorized read of ready chat attachments for mobile conversation rendering
 * (batch by file IDs extracted from `[mikka-file:...]` tokens, or by scope).
 * Reuses `authorizeFileScope`, `apiWorkspaceAllowed`, and
 * `enterpriseWorkspaceAllowed` so workspace, enterprise session assurance, and
 * group membership checks stay enforced on every read.
 */
export async function readMobileAttachments(
  session: ApiSession,
  query: MobileAttachmentsQuery,
): Promise<MobileAttachmentItem[]> {
  const userId = session.user.id
  const enterpriseCache = new Map<string, boolean>()

  if (query.kind === 'scope') {
    const workspace = await authorizeFileScope(userId, query.scope)
    if (!(await workspacePermitted(session, workspace, enterpriseCache))) throw new ChatFileError('notFound')
    const column =
      query.scope.kind === 'bot' ? '"botId"' : query.scope.kind === 'group' ? '"conversationId"' : '"runId"'
    const visibility =
      query.scope.kind === 'group'
        ? '("usedAt" IS NOT NULL OR "userId" = $2)'
        : '"userId" = $2'
    const { rows } = await pool.query<StoredAttachmentRow>(
      `SELECT ${SELECT_COLUMNS}
       FROM chat_attachments
       WHERE ${column} = $1::uuid
         AND state = 'ready'
         AND "removedAt" IS NULL
         AND ${visibility}
       ORDER BY "createdAt" DESC, id DESC
       LIMIT $3`,
      [query.scope.id, userId, query.limit],
    )
    return Promise.all(rows.map(row => toItem(row, query.download)))
  }

  const { rows } = await pool.query<StoredAttachmentRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM chat_attachments
     WHERE id = ANY($1::uuid[])
       AND state = 'ready'
       AND "removedAt" IS NULL
       AND ("userId" = $2 OR ("conversationId" IS NOT NULL AND "usedAt" IS NOT NULL))`,
    [query.ids, userId],
  )

  const authorizedScopes = new Map<string, boolean>()
  const visible: StoredAttachmentRow[] = []
  for (const row of rows) {
    const scope = fileScope(row)
    const key = `${scope.kind}:${scope.id}`
    let allowed = authorizedScopes.get(key)
    if (allowed === undefined) {
      try {
        const workspace = await authorizeFileScope(userId, scope)
        allowed = await workspacePermitted(session, workspace, enterpriseCache)
      } catch (error) {
        if (error instanceof ChatFileError && error.code === 'notFound') allowed = false
        else throw error
      }
      authorizedScopes.set(key, allowed)
    }
    if (allowed) visible.push(row)
  }

  const byId = new Map(visible.map(row => [row.id, row]))
  const ordered = query.ids.flatMap(id => {
    const found = byId.get(id)
    return found ? [found] : []
  })
  return Promise.all(ordered.map(row => toItem(row, query.download)))
}

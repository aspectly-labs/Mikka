import { z } from 'zod'
import { chatFileScopeSchema, type ChatFileScope } from '@mikka/protocol/chat-attachments'

export const MOBILE_ATTACHMENTS_MAX_IDS = 50
export const MOBILE_ATTACHMENTS_LIMIT_DEFAULT = 30
export const MOBILE_ATTACHMENTS_LIMIT_MAX = 50

export type MobileAttachmentsQuery =
  | { kind: 'ids'; ids: string[]; download: boolean }
  | { kind: 'scope'; scope: ChatFileScope; limit: number; download: boolean }

export interface MobileAttachmentItem {
  id: string
  name: string
  mediaType: string
  size: number
  scope: ChatFileScope
  createdAt: string
  downloadPath: string
  downloadUrl: string | null
}

/** Parses either `?ids=<uuid,...>` (batch resolve) or `?scope=bot|group|thread&id=<uuid>&limit=`. */
export function parseMobileAttachmentsQuery(params: URLSearchParams): MobileAttachmentsQuery | null {
  const download = params.get('download') === '1'
  const rawIds = params.get('ids')
  const rawScope = params.get('scope')
  const rawScopeId = params.get('id')
  if (rawIds !== null && (rawScope !== null || rawScopeId !== null)) return null

  if (rawIds !== null) {
    const parts = [...new Set(rawIds.split(',').map(part => part.trim()).filter(Boolean))]
    const parsed = z.array(z.uuid()).min(1).max(MOBILE_ATTACHMENTS_MAX_IDS).safeParse(parts)
    if (!parsed.success) return null
    return { kind: 'ids', ids: parsed.data, download }
  }

  if (rawScope !== null || rawScopeId !== null) {
    const scope = chatFileScopeSchema.safeParse({ kind: rawScope, id: rawScopeId })
    if (!scope.success) return null
    const rawLimit = params.get('limit')
    if (rawLimit !== null && !/^[1-9]\d?$/.test(rawLimit)) return null
    const limit = rawLimit === null ? MOBILE_ATTACHMENTS_LIMIT_DEFAULT : Number(rawLimit)
    if (limit > MOBILE_ATTACHMENTS_LIMIT_MAX) return null
    return { kind: 'scope', scope: scope.data, limit, download }
  }

  return null
}

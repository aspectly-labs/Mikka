import { auth } from '@/lib/api-auth'
import { ChatFileError } from '@/lib/chat-attachments/extract'
import { json, unauthorized } from '@/lib/mobile-api'
import { noteLogUser, withRequestLog } from '@/lib/request-log'
import { parseMobileAttachmentsQuery } from '@/lib/mobile-attachments-contract'
import { readMobileAttachments } from '@/lib/mobile-attachments'

/**
 * `GET /api/mobile/attachments?ids=<id,...>` or `?scope=bot|group|thread&id=<uuid>&limit=`:
 * batch-reads authorized attachment metadata and signed download URLs for
 * mobile Bot chats, group chats, and task threads. Uploads/deletes use
 * `/api/chat/attachments` and `/api/chat/attachments/:id`.
 */
async function handleGET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  noteLogUser(session?.user?.id)
  if (!session?.user) return unauthorized()
  const query = parseMobileAttachmentsQuery(new URL(request.url).searchParams)
  if (!query) return json({ error: 'invalidAttachmentsQuery' }, 400)
  try {
    return json({ attachments: await readMobileAttachments(session, query) })
  } catch (error) {
    if (error instanceof ChatFileError && error.code === 'notFound') return json({ error: 'notFound' }, 404)
    throw error
  }
}

export const GET = withRequestLog('/api/mobile/attachments', handleGET)

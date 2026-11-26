import 'server-only'
import { apiWorkspaceAllowed, type ApiSession } from '@/lib/api-auth'
import { writeAllowed } from '@/lib/mobile-api'
import { ChatFileError } from '@/lib/chat-attachments/extract'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'

/** A spoken message or task description: a few minutes of compressed audio (10 MiB). */
export const MAX_DICTATION_AUDIO_BYTES = 10 * 1024 * 1024
const headers = { 'Cache-Control': 'private, no-store' }
export const dictationFailure = (error: string, status: number) => Response.json({ error }, { status, headers })

/** Shared handler for task dictation and chat thread dictation (#3333). */
export async function handleDictationPost(request: Request, session: ApiSession, errorName: string) {
  if (!writeAllowed(request)) return dictationFailure('originNotAllowed', 403)
  if (!request.headers.get('content-type')?.startsWith('audio/')) return dictationFailure('invalid', 400)
  const reader = request.body?.getReader()
  if (!reader) return dictationFailure('invalid', 400)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_DICTATION_AUDIO_BYTES) { await reader.cancel(); return dictationFailure('tooLarge', 413) }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  if (!size) return dictationFailure('invalid', 400)
  const audio = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.byteLength }
  try {
    const { workspace } = await loadWorkspaceContext(session.tokenWorkspaceId, session.user)
    // A workspace-scoped token transcribes only in its own workspace, as every other workspace route checks.
    if (!apiWorkspaceAllowed(session, workspace.id)) return dictationFailure('notFound', 404)
    const { transcribeChatAudio } = await import('@/lib/chat-attachments/transcribe')
    return Response.json({ text: await transcribeChatAudio(session.user.id, workspace.id, audio) }, { headers })
  } catch (error) {
    if (error instanceof WorkspaceError) return dictationFailure('notFound', 404)
    if (error instanceof ChatFileError) return dictationFailure(error.code, error.code === 'audioKeyRequired' ? 409 : 422)
    throw new Error(errorName, { cause: error })
  }
}

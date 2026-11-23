import 'server-only'
import { Client, type ClientSession } from 'eve/client'
import { emptySessionView, foldEvents, idle } from 'eve/events'
import type { MessageContent } from 'eve/channels'
import { assertEveScope, type EveScope } from './scope'
import { eveInternalOrigin } from './server-client'
import { eveRetryHeaders } from './retry'
import type { RevisionInput, RevisionSend } from '../coordinator/turn-revisions'

type ReviseSession = Pick<ClientSession, 'id' | 'snapshot' | 'send' | 'clear'>
export interface EveReviseServices {
  open(scope: EveScope, headers: Readonly<Record<string, string>>): Promise<ReviseSession>
  begin(scope: EveScope, input: RevisionInput): Promise<RevisionSend>
  abandon(scope: EveScope, id: string): Promise<void>
  cleared(scope: EveScope, id: string): Promise<void>
}

const defaultServices: EveReviseServices = {
  async open(scope, headers) {
    const base = new URL(eveInternalOrigin()); base.searchParams.set('botId', scope.botId)
    return (await new Client({ baseUrl: base.toString(), headers, redirect: 'manual' }).sessions.create()).session
  },
  async begin(scope, input) {
    const [{ db }, { beginRevision }, { botChatChanged }] = await Promise.all([import('../db'), import('../coordinator/turn-revisions'), import('../live/chats')])
    return beginRevision(db as never, { userId: scope.ownerId, botId: scope.botId, workspaceId: scope.workspaceId }, input, tx => botChatChanged(tx, scope.ownerId, scope.botId))
  },
  async abandon(scope, id) {
    const [{ db }, { abandonRevision }, { botChatChanged }] = await Promise.all([import('../db'), import('../coordinator/turn-revisions'), import('../live/chats')])
    await abandonRevision(db as never, { userId: scope.ownerId, botId: scope.botId }, id, tx => botChatChanged(tx, scope.ownerId, scope.botId))
  },
  async cleared(scope, id) {
    const [{ db }, { revisionCleared }] = await Promise.all([import('../db'), import('../coordinator/turn-revisions')])
    await revisionCleared(db as never, { userId: scope.ownerId, botId: scope.botId }, id)
  },
}

/** The person's words and images as eve takes a message, as a resend does (lib/eve/retry.ts). */
export function revisionMessage(send: RevisionSend): MessageContent {
  const files = send.images.map(image => ({ type: 'file' as const, data: image.dataUrl, mediaType: image.mediaType }))
  return files.length ? [...(send.text ? [{ type: 'text' as const, text: send.text }] : []), ...files] : send.text
}

/**
 * Edit or Regenerate on the latest turn of a Bot chat (decision 2026-11-22-1700). In order:
 * 1. the chat must be idle, in eve and in Mikka's inbox;
 * 2. the turn leaves the chat, kept as a version (lib/coordinator/turn-revisions.ts);
 * 3. eve clears the session's model history (`clear`), so the Bot forgets the turn and everything before it;
 * 4. the edited or the same words go as a new message, and the channel gives the chat's remaining history back with it
 *    (lib/eve/channel.ts `claimRevisionImport`), so the Bot answers as if the turn had never been.
 * If eve refuses to clear, the turn comes back and nothing changed. Once it has cleared, the rewrite stands; a send that
 * fails then is the ordinary send failure, and the next message carries the history back.
 */
export async function reviseEveTurn(scope: EveScope, input: RevisionInput, requestHeaders: Headers, services: EveReviseServices = defaultServices) {
  await assertEveScope(scope)
  const headers = eveRetryHeaders(requestHeaders)
  const session = await services.open(scope, headers)
  if (!idle(foldEvents(emptySessionView(), (await session.snapshot()).events))) return { queued: false as const, reason: 'working' as const }
  const send = await services.begin(scope, input)
  if (!send.cleared) {
    // eve refused the clear: the Bot still has the turn, so the chat gets it back. A clear whose outcome is unknown (the
    // connection broke) keeps the revision; clearing again is harmless, and the same request retried finishes it.
    const cleared = await (await session.clear()).result()
    if (cleared.status === 'failed') {
      await services.abandon(scope, send.id)
      return { queued: false as const, reason: 'unavailable' as const }
    }
    await services.cleared(scope, send.id)
  }
  await session.send(revisionMessage(send), { clientContext: { expectedOwnerId: scope.ownerId, expectedWorkspaceId: scope.workspaceId, botId: scope.botId }, headers: { 'x-mikka-submission-id': send.submissionId } })
  return { queued: true as const, submissionId: send.submissionId }
}

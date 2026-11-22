import 'server-only'
import { pool } from '@/lib/db'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { messageReferences, type MessageReference } from '@/lib/composer-references'

/**
 * What a typed reference in a person's message points at, as the reader may see
 * it (#2941). Tasks and threads resolve through the Coordinator's citation reader
 * (lib/coordinator/store.ts citationSources), which applies task visibility and
 * run ownership in the message's workspace; an independent chat needs an active
 * membership in it. A pull request is its URL and is never looked up here.
 */
export type ResolvedReference = MessageReference & {
  /** Deleted, outside this workspace, or not readable by the sender. */
  unavailable?: true
  title?: string
  identifier?: string | null
  status?: string
}

export type ReferenceReader = { userId: string; workspaceId: string }

export async function resolveMessageReferences(reader: ReferenceReader, text: string): Promise<ResolvedReference[]> {
  const references = messageReferences(text)
  if (!references.length) return []
  const cited = references.filter(item => item.type === 'task' || item.type === 'thread')
  const chats = [...new Set(references.filter(item => item.type === 'chat').map(item => item.id))]
  const [{ citationSources }, members] = await Promise.all([
    import('@/lib/coordinator/store'),
    chats.length ? pool.query<{ id: string; title: string | null }>(`SELECT c.id, c.title FROM conversations c
      JOIN conversation_members m ON m."conversationId"=c.id AND m."memberType"='user' AND m."memberId"=$2 AND m."leftAt" IS NULL
      WHERE c.id=ANY($1::uuid[]) AND c."workspaceId"=$3`, [chats, reader.userId, reader.workspaceId]) : null,
  ])
  const sources = cited.length
    ? await citationSources({ id: reader.userId, [tokenWorkspace]: reader.workspaceId }, cited.map(item => item.type === 'task' ? `[[issue:${item.id}]]` : `[[run:${item.id}]]`))
    : {}
  const { runTitle } = await import('@/lib/coordinator/citations')
  const chatTitles = new Map(members?.rows.map(row => [row.id, row.title]) ?? [])
  return references.map((reference): ResolvedReference => {
    if (reference.type === 'pr') return reference
    if (reference.type === 'chat') return chatTitles.has(reference.id)
      ? { ...reference, ...(chatTitles.get(reference.id) ? { title: chatTitles.get(reference.id)! } : {}) }
      : { ...reference, unavailable: true }
    const source = sources[reference.id]
    if (reference.type === 'task' && source?.kind === 'issue') return { ...reference, title: source.title, identifier: source.identifier, status: source.status }
    if (reference.type === 'thread' && source?.kind === 'run') return { ...reference, title: runTitle(source), status: source.status }
    return { ...reference, unavailable: true }
  })
}

/** The references a sender may not send: deleted, from another workspace, or not readable by them. */
export async function unavailableReferences(reader: ReferenceReader, text: string): Promise<ResolvedReference[]> {
  return (await resolveMessageReferences(reader, text)).filter(item => item.unavailable)
}

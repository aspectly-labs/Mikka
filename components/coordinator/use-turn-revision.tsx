'use client'

import { useRef, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { useTranslations } from '@/lib/intl/i18n-client'
import { coordinatorTurnVersions, reviseCoordinatorTurn } from '@/app/actions/coordinator'
import type { ChatItem } from '@/lib/coordinator/context'
import type { TurnVersion } from '@/lib/coordinator/turn-revisions'
import type { ThreadEntry } from '@/components/slots/thread-contract'
import { useActionError } from '@/lib/use-action-error'
import { MessageEditor, VersionPager } from '@/components/chat/message-revision'

/**
 * The latest turn of a Bot chat that Edit and Regenerate can rewrite (decision 2026-11-22-1700): the person's last
 * message, their own words with nothing that cannot go into an edit box (an artifact quote, browser notes, a 建议 card,
 * photos), and replies after it made of words alone. A turn that ran a tool, dispatched a thread or showed an artifact
 * changed something outside the chat that a rewrite would not undo, so it offers neither. The server checks the same.
 */
export function revisableTurn(items: readonly ChatItem[]): { person: ChatItem; reply: ChatItem | null } | null {
  const index = items.findLastIndex(item => item.from === 'person')
  const person = items[index]
  if (!person || person.pending || !person.submissionId || !person.text || person.quote || person.notes?.length || person.suggestion || person.images) return null
  const after = items.slice(index + 1)
  if (!after.every(item => item.from === 'coordinator' && !item.welcome && !item.tools.length && !item.threads.length && !item.artifacts.length && !item.pending)) return null
  return { person, reply: after.findLast(item => Boolean(item.text)) ?? null }
}

/** Keys an entry in the chat to its turn: the person entry's id and the reply entries' ids that follow it. */
export interface TurnEntries { person: string; replies: string[]; submissionId: string }

export function useTurnRevision({ botId, items, idle, refresh }: { botId: string | null; items: readonly ChatItem[]; idle: boolean; refresh: () => void }) {
  const t = useTranslations('AiElements.message')
  const actionError = useActionError()
  const [editing, setEditing] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // A retried send of the same words is the same request, so a lost answer cannot rewrite the turn twice.
  const pending = useRef<{ key: string; id: string } | null>(null)
  const [selected, setSelected] = useState<Record<string, number>>({})
  const turn = idle && !busy ? revisableTurn(items) : null
  const lastSubmission = items.findLast(item => item.from === 'person' && item.submissionId)?.submissionId ?? null
  // Read again only when the chat's newest message changes: a revision always sends a new one.
  const { data: versions } = useSWR(lastSubmission ? ['bot-turn-versions', botId, lastSubmission] : null, () => coordinatorTurnVersions(botId))

  async function revise(input: { operation: 'edit'; position: number; text: string } | { operation: 'regenerate'; position: number }) {
    const key = JSON.stringify(input)
    const request = pending.current?.key === key ? pending.current : { key, id: crypto.randomUUID() }
    pending.current = request
    setBusy(true); setError(undefined)
    try {
      const result = await reviseCoordinatorTurn(botId, { ...input, requestId: request.id })
      const message = result.error ? actionError(result.error) : !result.queued ? actionError(result.reason === 'working' ? 'chatRevisionBusy' : 'coordinatorUnavailable') : undefined
      if (message) {
        if (input.operation === 'edit') setError(message)
        else toast.error(message)
        return
      }
      pending.current = null
      setEditing(null)
      setSelected({})
      refresh()
    } catch {
      if (input.operation === 'edit') setError(actionError())
      else toast.error(actionError())
    } finally { setBusy(false) }
  }

  return {
    /** Edit on the person's message at `item`, when it is the turn that can be rewritten. */
    onEdit: (item: ChatItem) => turn?.person.position === item.position && editing === null ? () => { setError(undefined); setEditing(item.position) } : undefined,
    /** Regenerate on the reply `item`, when it is the latest turn's reply. */
    onRegenerate: (item: ChatItem) => turn?.reply?.position === item.position && editing === null ? () => { void revise({ operation: 'regenerate', position: item.position }) } : undefined,
    /** The editor in place of the person's words while they edit them. */
    editor: (item: ChatItem, text: string): ReactNode => editing === item.position && item.position === turn?.person.position
      ? <MessageEditor text={text} busy={busy} error={error} onCancel={() => { setEditing(null); setError(undefined) }} onSend={value => { void revise({ operation: 'edit', position: item.position, text: value }) }} />
      : undefined,
    /** ‹ n / N › on the person's message of a turn with earlier versions. */
    pager: (item: ChatItem): ReactNode => {
      const earlier = item.submissionId ? versions?.[item.submissionId] : undefined
      if (!earlier?.length || !item.submissionId) return undefined
      const id = item.submissionId
      const total = earlier.length + 1
      return <VersionPager index={selected[id] ?? total - 1} total={total} onChange={index => setSelected(current => ({ ...current, [id]: index }))} />
    },
    /** The earlier version shown for the turn of `submissionId`, or null for the live one. */
    shown: (submissionId: string | undefined): TurnVersion | null => {
      const earlier = submissionId ? versions?.[submissionId] : undefined
      const index = submissionId ? selected[submissionId] : undefined
      return earlier && index !== undefined && index < earlier.length ? earlier[index]! : null
    },
    label: t('editLabel'),
  }
}

/**
 * An earlier version shown in place of the live turn: the person's words then, and that reply's words as the only reply.
 * The live reply entries of the turn leave the list while it shows; the pager stays on the person's line.
 */
export function showTurnVersion(entries: ThreadEntry[], turn: TurnEntries, version: TurnVersion, reply: (text: string) => Extract<ThreadEntry, { role: 'bot' }>['parts']): ThreadEntry[] {
  const start = entries.findIndex(entry => entry.id === turn.person)
  if (start < 0) return entries
  const person = entries[start]!
  if (person.role !== 'person') return entries
  const replies = new Set(turn.replies)
  const first = entries.findIndex(entry => replies.has(entry.id))
  const kept = entries.filter(entry => !replies.has(entry.id))
  const shownPerson: ThreadEntry = { ...person, text: version.person, body: undefined, attachments: undefined }
  const at = first >= 0 ? entries[first]!.at : person.at
  const shownReply: ThreadEntry = { id: `${turn.person}-version`, role: 'bot', at, parts: reply(version.reply) }
  const index = kept.indexOf(person)
  return [...kept.slice(0, index), shownPerson, ...(version.reply ? [shownReply] : []), ...kept.slice(index + 1)]
}

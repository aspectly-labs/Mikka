'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { findThreadReferences } from '@/app/actions/task-runs'
import { mentionAt, referenceMarker, referenceQueryReady, type ThreadReference } from '@/lib/thread-references'
import { composerDisplay, editComposerDisplay, insertComposerReference, pullRequestShortName, referenceKey, slashCommandAt, tokenAtCaret, type MessageReference, type ReferenceType } from '@/lib/composer-references'
import type { ChatComposerCommand } from '@/components/slots/chat-composer-contract'

/** A row of the composer's suggestion menu: a `/` command or a reference to insert. */
export type ComposerSuggestionRow = { id: string; label: string; description?: string; kind: 'command' | ReferenceType }
export type ComposerSuggestions = {
  label: string
  sections: { title: string; rows: ComposerSuggestionRow[] }[]
  /** Searching, nothing found or the search failed: one line instead of rows. */
  status?: string
  active: number
  pick: (id: string) => void
  close: () => void
}

type Lookup = { signature: string; place: string; items?: ThreadReference[]; failed?: boolean }

/** What a reference is called in a chip: a task by its code, a pull request as `repo#12`, a thread by its title. */
export function chipLabel(item: ThreadReference): string {
  if (item.kind === 'pr') return pullRequestShortName(item.id) ?? item.title
  if (item.kind === 'task') return /^[A-Z][A-Z0-9]*-\d+$/.exec(item.title.split(' ')[0] ?? '')?.[0] ?? item.title
  return item.title
}

/**
 * The composer's typed references and `/` commands (#2924): the draft shows each
 * reference as its name and keeps its marker underneath, `@` and the ＋ menu's
 * Reference rows search the workspace, and `/` at the start lists the chat's commands.
 */
export function useComposerReferences({ stored, setStored, input, workspaceId, commands, disabled }: {
  stored: string
  setStored: (value: string) => void
  input: () => HTMLTextAreaElement | null
  workspaceId?: string
  commands?: ChatComposerCommand[]
  disabled: boolean
}) {
  const t = useTranslations('ThreadReferences')
  const [names, setNames] = useState<Record<string, string>>({})
  const [caret, setCaret] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState('')
  const [active, setActive] = useState(0)
  const [lookup, setLookup] = useState<Lookup | null>(null)
  const fallback = (reference: MessageReference) => names[referenceKey(reference)]
    ?? (reference.type === 'pr' ? pullRequestShortName(reference.id) ?? reference.id : `${t(reference.type === 'chat' ? 'thread' : reference.type)} ${reference.id.slice(0, 8)}`)
  const display = useMemo(() => composerDisplay(stored, fallback), [stored, names]) // eslint-disable-line react-hooks/exhaustive-deps
  const displayRef = useRef(display)
  displayRef.current = display

  // The caret decides what is being typed: follow it as the person types, clicks and moves.
  useEffect(() => {
    const field = input()
    if (!field) return
    const update = () => setCaret(field.selectionStart)
    const select = () => { if (field.ownerDocument.activeElement === field) update() }
    const edited = (event: Event) => { if (event.target === field) update() }
    field.ownerDocument.addEventListener('input', edited)
    field.ownerDocument.addEventListener('selectionchange', select)
    field.addEventListener('click', update)
    field.addEventListener('keyup', update)
    return () => {
      field.ownerDocument.removeEventListener('input', edited)
      field.ownerDocument.removeEventListener('selectionchange', select)
      field.removeEventListener('click', update)
      field.removeEventListener('keyup', update)
    }
  })

  const at = Math.min(caret ?? display.text.length, display.text.length)
  const insideToken = display.tokens.some(token => token.from < at && at < token.to)
  const slash = commands?.length && !insideToken ? slashCommandAt(display.text, at) : null
  const mention = workspaceId && !slash && !insideToken ? mentionAt(display.text, at) : null
  const signature = JSON.stringify([workspaceId, slash?.query, mention?.from, mention?.kind, mention?.query])
  // The same mention as it grows: its last results stay until the next arrive, so the menu never blinks to 「正在搜索」.
  const place = JSON.stringify([workspaceId, mention?.from, mention?.kind])
  const searching = Boolean(mention && referenceQueryReady(mention.query) && !disabled && dismissed !== signature)
  const listing = Boolean(slash && !disabled && dismissed !== signature)

  useEffect(() => {
    if (!searching || !mention || !workspaceId) return
    let current = true
    const timer = setTimeout(async () => {
      try {
        const items = mention.kind ? await findThreadReferences(workspaceId, mention.query, mention.kind) : await findThreadReferences(workspaceId, mention.query)
        if (current) setLookup({ signature, place, items })
      } catch { if (current) setLookup({ signature, place, failed: true }) }
    }, 180)
    return () => { current = false; clearTimeout(timer) }
  }, [signature, searching]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setActive(0), [signature])

  const found = lookup?.signature === signature ? lookup : lookup?.place === place && lookup.items ? lookup : null
  const sections: ComposerSuggestions['sections'] = []
  if (listing && slash) {
    const rows = commands!.filter(command => command.name.slice(1).startsWith(slash.query)).map(command => ({ id: `command:${command.id}`, label: command.name, description: command.description, kind: 'command' as const }))
    if (rows.length) sections.push({ title: t('commands'), rows })
  }
  if (searching && found?.items) {
    for (const kind of ['task', 'thread', 'pr'] as const) {
      const rows = found.items.filter(item => item.kind === kind).map(item => ({ id: `${item.kind}:${referenceMarker(item)}`, label: item.title, kind: item.kind === 'thread' && item.conversationKind === 'chat' ? 'chat' as const : item.kind }))
      if (rows.length) sections.push({ title: t(kind === 'task' ? 'tasks' : kind === 'thread' ? 'threads' : 'pullRequests'), rows })
    }
  }
  const rows = sections.flatMap(section => section.rows)
  const status = searching ? !found ? t('searching') : found.failed ? t('error') : rows.length ? undefined : t('empty') : undefined
  const open = (listing && rows.length > 0) || searching

  // The caret after a change the composer makes itself lands in the same commit as the new text, so nothing typed
  // right after a pick goes in at an older place, and the caret never visibly jumps.
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    const position = pendingCaret.current
    const field = input()
    if (position === null || !field) return
    pendingCaret.current = null
    field.focus({ preventScroll: true })
    field.setSelectionRange(position, position)
    setCaret(position)
  })
  function focusAt(position: number) { pendingCaret.current = position }

  function pick(id: string) {
    if (id.startsWith('command:')) {
      const command = commands?.find(item => `command:${item.id}` === id)
      if (!command) return
      setStored('')
      command.run()
      return
    }
    const item = found?.items?.find(entry => `${entry.kind}:${referenceMarker(entry)}` === id)
    if (!item || !mention) return
    const marker = referenceMarker(item)
    const type: ReferenceType = item.kind === 'thread' && item.conversationKind === 'chat' ? 'chat' : item.kind
    const label = chipLabel(item)
    setNames(previous => ({ ...previous, [referenceKey({ type, id: item.id })]: label }))
    setStored(insertComposerReference(stored, display, mention.from, mention.end, marker))
    focusAt(mention.from + label.length + 1)
  }

  const suggestions: ComposerSuggestions | null = open ? {
    label: slash ? t('commands') : t('references'), sections, status, active: Math.min(active, Math.max(0, rows.length - 1)), pick,
    close: () => setDismissed(signature),
  } : null

  return {
    text: display.text,
    tokens: display.tokens,
    suggestions,
    /** The shown text after an edit, stored with its markers. */
    edit(next: string) {
      const field = input()
      setStored(editComposerDisplay(stored, displayRef.current, next, field && field.value === next ? field.selectionEnd : undefined))
    },
    /** The ＋ menu's Reference rows start a search of one kind where the caret is. */
    startReference(kind: ThreadReference['kind']) {
      const field = input()
      const position = Math.min(field?.selectionStart ?? display.text.length, display.text.length)
      const before = display.text.slice(0, position)
      const trigger = `${before && !/\s$/.test(before) ? ' ' : ''}@${kind}:`
      setStored(editComposerDisplay(stored, display, before + trigger + display.text.slice(position), position + trigger.length))
      setDismissed('')
      focusAt(position + trigger.length)
    },
    /** Arrows, Enter, Tab and Esc move through an open menu; Backspace and Delete take a whole reference. True when handled. */
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (event.nativeEvent.isComposing) return false
      if (suggestions) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); suggestions.close(); return true }
        if (rows.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault()
          setActive(index => (index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length)
          return true
        }
        if (rows.length && (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
          event.preventDefault()
          pick(rows[suggestions.active].id)
          return true
        }
      }
      if (event.key !== 'Backspace' && event.key !== 'Delete') return false
      const field = event.currentTarget
      if (field.selectionStart !== field.selectionEnd) return false
      const token = tokenAtCaret(display, field.selectionStart, event.key)
      if (!token) return false
      // The first press selects the whole reference (Figma 1337:5000), the second removes it.
      event.preventDefault()
      field.setSelectionRange(token.from, token.to)
      return true
    },
  }
}

'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { ChevronLeft, ChevronRight } from '@/components/icons'
import { MessageAction } from '@/components/ai-elements/message'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Field, FieldError, FieldGroup } from '@/components/ui/field'

/**
 * The person's message opened for editing in place, as Claude and ChatGPT do (decision 2026-11-22-1700): the words in a
 * box where the bubble was, Cancel and Send under it. Send replaces the turn, so it is offered only once the words
 * changed; Escape cancels, ⌘/Ctrl+Enter sends.
 */
export function MessageEditor({ text, busy, error, onCancel, onSend }: {
  text: string
  busy: boolean
  /** Why the last send did not go, in the action's own words. */
  error?: string
  onCancel: () => void
  onSend: (text: string) => void
}) {
  const t = useTranslations('AiElements.message')
  const [draft, setDraft] = useState(text)
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const field = input.current
    if (!field) return
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  }, [])
  const value = draft.trim()
  const ready = !busy && value.length > 0 && value !== text.trim()
  function submit(event?: FormEvent) {
    event?.preventDefault()
    if (ready) onSend(value)
  }
  return <form className="flex w-full min-w-0 flex-col gap-2" onSubmit={submit} data-message-editor>
    <FieldGroup className="gap-2"><Field>
      <Textarea ref={input} aria-label={t('editLabel')} value={draft} maxLength={10_000} disabled={busy} className="max-h-80 min-h-20"
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); onCancel() }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event)
        }} />
      {error && <FieldError>{error}</FieldError>}
    </Field></FieldGroup>
    <div className="flex justify-end gap-2">
      <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>{t('editCancel')}</Button>
      <Button type="submit" size="sm" disabled={!ready} busy={busy}>{t('editSend')}</Button>
    </div>
  </form>
}

/** ‹ 2 / 3 › on a revised turn: which version of it shows. The newest is the live one; earlier ones only read back. */
export function VersionPager({ index, total, onChange }: { index: number; total: number; onChange: (index: number) => void }) {
  const t = useTranslations('AiElements.message')
  return <span className="inline-flex items-center" data-version-pager>
    <MessageAction tooltip={t('previousVersion')} disabled={index === 0} onClick={() => onChange(index - 1)}><ChevronLeft aria-hidden="true" className="rtl:-scale-x-100" /></MessageAction>
    <span className="px-0.5 text-xs tabular-nums text-muted-foreground">{t('versionPosition', { current: index + 1, total })}</span>
    <MessageAction tooltip={t('nextVersion')} disabled={index === total - 1} onClick={() => onChange(index + 1)}><ChevronRight aria-hidden="true" className="rtl:-scale-x-100" /></MessageAction>
  </span>
}

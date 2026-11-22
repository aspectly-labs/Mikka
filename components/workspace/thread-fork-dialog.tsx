'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslations } from '@/lib/intl/i18n-client'
import { forkThread } from '@/app/actions/task-runs'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useActionError } from '@/lib/use-action-error'

/** Where a fork starts: a run of the thread, and a message of it (ThreadItem.id) or, naming none, the whole run. */
export type ThreadForkRequest = { runId: string; itemId?: string | null; mode: 'full' | 'summary' }

/**
 * 分叉 (#2936, Figma 1318:2 sections 13 and 15): what the fork should do, then a new thread of the task that starts
 * from this one up to the message (lib/thread-fork-context.ts). The source thread is replaced by it (one thread per
 * task); `onForked` opens the new one.
 */
export function ThreadForkDialog({ request, onClose, onForked }: { request: ThreadForkRequest | null; onClose: () => void; onForked: (runId: string) => void }) {
  const t = useTranslations('IssueThreads.lifecycle')
  const common = useTranslations('Common')
  const errorText = useActionError()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  // One request id per opened dialog, so a retried submit is the same fork.
  const requestId = useRef(crypto.randomUUID())
  useEffect(() => { if (request) { setText(''); requestId.current = crypto.randomUUID() } }, [request])
  async function submit() {
    if (!request || busy || !text.trim()) return
    setBusy(true)
    try {
      const result = await forkThread({ ...request, text, requestId: requestId.current })
      if (result.error) toast.error(t('forkFailed'), { description: errorText(result.error) })
      else { onClose(); onForked(result.runId) }
    } catch { toast.error(t('forkFailed')) } finally { setBusy(false) }
  }
  return <Dialog open={Boolean(request)} onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent showCloseButton={false}>
      <DialogHeader><DialogTitle>{t(request?.mode === 'summary' ? 'forkSummary' : 'fork')}</DialogTitle></DialogHeader>
      <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void submit() }}>
        <FieldGroup><Field>
          <FieldLabel htmlFor="thread-fork-instruction" className="sr-only">{t('forkInstruction')}</FieldLabel>
          <Textarea id="thread-fork-instruction" autoFocus placeholder={t('forkInstruction')} value={text} maxLength={4000} readOnly={busy}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit() } }} />
        </Field></FieldGroup>
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{common('cancel')}</Button>
          <Button type="submit" disabled={busy || !text.trim()} aria-busy={busy}>{busy && <Spinner data-icon="inline-start" />}{t('fork')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

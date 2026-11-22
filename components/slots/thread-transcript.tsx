'use client'

import { ChatMessage } from '@ui-slot/chat-message'
import { cn } from '@/lib/utils'
import type { ThreadTranscriptMessage, ThreadTranscriptScreenProps } from './thread-contract'

function TranscriptMessage({ entry }: { entry: ThreadTranscriptMessage }) {
  return entry.message ? <ChatMessage {...entry.message} /> : entry.content
}

/** Shared list and composer layout for the group presentation. */
export function ThreadTranscript({ host, transcript, composer, beforeComposer }: ThreadTranscriptScreenProps) {
  return <>
    <div ref={transcript.scroll.ref} onScroll={transcript.scroll.onScroll} data-thread-host={host} className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-6">
        {transcript.placeholder != null ? transcript.placeholder : <>
          {transcript.before}
          <ol aria-label={transcript.scroll.label} className="flex flex-col gap-4">
            {transcript.rows.map(row => row.kind === 'author'
              ? <li key={row.id} className={cn('flex', row.mine ? 'flex-col items-end gap-1' : 'items-end gap-2')}>
                {!row.mine && row.mark}
                <div className={cn('flex min-w-0 flex-col gap-1', row.mine ? 'max-w-[min(26rem,80%)] items-end' : 'max-w-[min(35rem,85%)]')}>
                  {row.mine ? <span className="sr-only">{row.name}</span> : <span className="text-xs font-medium text-muted-foreground">{row.name}</span>}
                  {row.messages.map(entry => <TranscriptMessage key={entry.id} entry={entry} />)}
                </div>
              </li>
              : row.kind === 'pending'
                ? <li key={row.id} data-pending={row.phase} className={cn('flex flex-col items-end gap-1', row.phase === 'sending' && 'opacity-60')}>
                  <ChatMessage {...row.message} />{row.after}
                </li>
                : <li key={row.id} aria-label={row.label} className="flex">{row.content}</li>)}
          </ol>
          {transcript.after}
        </>}
        {transcript.end}
      </div>
    </div>
    <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4">
      {beforeComposer}
      {composer}
    </div>
  </>
}

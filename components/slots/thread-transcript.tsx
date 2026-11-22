'use client'

import { useRef } from 'react'
import { ChatMessage } from '@ui-slot/chat-message'
import { cn } from '@/lib/utils'
import type { ThreadTranscriptMessage, ThreadTranscriptScreenProps } from './thread-contract'
import { useTranscriptScroll } from './thread-transcript-scroll'

/** Each message is its own hover target (`group/message`): its actions line shows while it is hovered or focused. */
function TranscriptMessage({ entry, mine }: { entry: ThreadTranscriptMessage; mine?: boolean }) {
  return <div data-message-id={entry.id} className={cn('group/message flex w-full min-w-0 flex-col', mine && 'items-end')}>
    {entry.message ? <ChatMessage {...entry.message} /> : entry.content}
  </div>
}

/**
 * Shared list and composer layout for the group presentation, laid out as the Bot chat (decision
 * 2026-11-22-1500-group-chat-as-bot-chat): its 680px reading column and the composer centred under it at the same width;
 * the person's messages on the right, a Bot's reply as its words alone.
 */
export function ThreadTranscript({ host, transcript, composer, beforeComposer }: ThreadTranscriptScreenProps) {
  const column = useRef<HTMLDivElement>(null)
  const spacer = useRef<HTMLDivElement>(null)
  useTranscriptScroll({ scroller: transcript.scroll.ref, column, spacer, end: transcript.scroll.end, following: transcript.scroll.following, pin: transcript.scroll.pin })
  return <>
    <div ref={transcript.scroll.ref} onScroll={transcript.scroll.onScroll} data-thread-host={host} className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
      <div ref={column} className="mx-auto flex w-full max-w-[728px] flex-col gap-4 px-3 pb-6 sm:px-6">
        {transcript.placeholder != null ? transcript.placeholder : <>
          {transcript.before}
          <ol aria-label={transcript.scroll.label} className="flex flex-col gap-4">
            {transcript.rows.map(row => row.kind === 'author'
              ? <li key={row.id} className="flex flex-col gap-4">
                {row.before}
                {/* The person's column takes the row's width, so a short message keeps one line (the bubble sets its own width).
                  * Everyone else's run opens with its sender, as LobeHub's group chat (ChatItem header): their mark and name. */}
                <div className={cn('flex w-full min-w-0 flex-col', row.mine ? 'items-end gap-1' : 'gap-2')}>
                  {row.mine || row.quiet ? <span className="sr-only">{row.name}</span>
                    : <span data-slot="group-author" className="flex min-w-0 items-center gap-2">{row.mark}<span className="truncate text-sm font-medium text-foreground">{row.name}</span></span>}
                  {row.messages.map(entry => <TranscriptMessage key={entry.id} entry={entry} mine={row.mine} />)}
                </div>
              </li>
              : row.kind === 'pending'
                ? <li key={row.id} data-pending={row.phase} data-message-id={row.id} className={cn('flex w-full flex-col items-end gap-1', row.phase === 'sending' && 'opacity-60')}>
                  <ChatMessage {...row.message} />{row.after}
                </li>
                : <li key={row.id} aria-label={row.label} className="flex">{row.content}</li>)}
          </ol>
          {transcript.after}
        </>}
        {transcript.end}
      </div>
      {/* The space a sent message keeps at the top of the view with (send-pinning): blank, none at rest. */}
      <div ref={spacer} aria-hidden="true" data-slot="send-pin-space" />
    </div>
    <div data-thread-composer="" className="mx-auto flex w-full max-w-[728px] shrink-0 flex-col gap-2 px-3 pt-1 pb-2 sm:px-6 sm:pb-5">
      {beforeComposer}
      {composer}
    </div>
  </>
}

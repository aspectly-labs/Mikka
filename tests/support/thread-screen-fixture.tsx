// The official thread screen paints data from ThreadScreenProps (docs/ui-overlay.md `thread`). Public tests of a chat's
// reader draw those props plainly: one list item per entry by its id, an agent entry's author line where its author
// changes (as AgentThreadScreen's `mikka.author`), a waiting or failed send with its retry, the empty state, the
// notices and the composer slot.
import { ChatComposer } from '@/components/coordinator/chat-composer'
import { Button } from '@/components/ui/button'
import type { ThreadEntry, ThreadScreenProps } from '@/components/slots/thread-contract'

export let lastThreadScreen: ThreadScreenProps | undefined

const authorOf = (entry: ThreadEntry | undefined) => entry?.role === 'bot' && !entry.event ? entry.author?.id ?? null : null

export function FixtureThreadScreen(props: ThreadScreenProps) {
  lastThreadScreen = props
  const entries = props.entries
  return <div>
    <div className="overflow-y-auto">
      {entries === null ? <p aria-busy="true">{props.loadingLabel}</p>
        : entries.length === 0 ? props.empty
          : <ol aria-label={props.transcriptLabel}>{entries.map((entry, index) => entry.role === 'person'
            ? <li key={entry.id} data-entry={entry.id} {...entry.status && entry.status !== 'sent' ? { 'data-pending': entry.status } : {}}>
              {entry.body ?? entry.text}
              {entry.status === 'failed' && <span role="alert">{entry.deliveryMessage}{entry.onRetry && <Button variant="ghost" size="xs" onClick={entry.onRetry}>retry</Button>}</span>}
              {entry.actions}
            </li>
            : <li key={entry.id} data-entry={entry.id}>
              {!entry.event && entry.author && authorOf(entries[index - 1]) !== entry.author.id && <span data-slot="group-author">{entry.author.mark}{entry.author.name}</span>}
              {entry.parts.map((part, at) => part.kind === 'text' ? <div key={at}>{part.node}</div> : null)}
              {entry.actions}
            </li>)}</ol>}
    </div>
    {props.notices}
    <ChatComposer {...props.composer} />
  </div>
}

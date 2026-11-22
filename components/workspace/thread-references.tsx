'use client'

import { useContext } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { withBasePath } from '@/lib/base-path'
import { ConversationReferenceTitles } from './conversation-reference-titles'
import { personReferenceParts } from '@/lib/thread-references'
import { openGroupConversation, openTask, openThread, workspaceSearch } from './workspace-navigation'
import { IssueCitation, RunCitation, WebCitation, useAgentCitations } from './agent-citations'
import { CircleAlert } from '@/components/icons'

export function PersonReferences({ text }: { text: string }) {
  const t = useTranslations('ThreadReferences')
  const titles = useContext(ConversationReferenceTitles)
  const citations = useAgentCitations()
  return <>{personReferenceParts(text).map((part, index) => {
    if (part.kind === 'text') return part.text
    // A pull request is the chat's PR chip (#2922), with its state where the chat knows it.
    if (part.kind === 'pr' && citations) return <WebCitation key={index} url={part.id} label={null} />
    if (part.kind === 'pr') return <a key={index} href={part.id} target="_blank" rel="noreferrer" className="break-all underline">{part.id.replace('https://github.com/', '')}</a>
    const source = citations?.sources[part.id]
    if (part.kind === 'task' && source?.kind === 'issue') return <IssueCitation key={index} issue={source} onOpen={citations!.onOpenIssue} />
    if (part.kind === 'thread' && source?.kind === 'run') return <RunCitation key={index} run={source} />
    const task = part.kind === 'task'
    const title = task ? undefined : titles.get((part.kind === 'chat' ? 'chat:' : 'run:') + part.id)
    // Looked up and not there: deleted, or no longer readable (Figma 1337:5067). Struck through, with why on hover.
    if (part.kind !== 'chat' && !source && citations?.answered?.includes(part.id)) return <span key={index} data-reference-broken="" title={t('broken')}
      className="inline-flex items-baseline gap-1 text-text-tertiary line-through"><CircleAlert aria-hidden="true" className="size-3 shrink-0 translate-y-0.5 text-text-error-primary" />
      {title ?? `${t(part.kind)} ${part.id.slice(0, 8)}`}<span className="sr-only">{t('broken')}</span></span>
    const href = withBasePath('/' + workspaceSearch(task ? { task: part.id } : part.kind === 'chat' ? { section: 'group', group: part.id } : { thread: part.id }))
    return <a key={index} href={href} className="underline" onClick={event => {
      if (event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      event.preventDefault()
      if (task) openTask(part.id)
      else if (part.kind === 'chat') openGroupConversation(part.id)
      else openThread(part.id)
    }}>{title ?? `${t(part.kind === 'chat' ? 'thread' : part.kind)} ${part.id.slice(0, 8)}`}</a>
  })}</>
}

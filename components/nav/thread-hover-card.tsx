'use client'
/**
 * 任务/线程 hover 卡片 (#2930): the light read of GET /threads/:id/preview —
 * title, status, the responsible agent, the latest reply and the task's PR.
 * Touch rows keep their tap target: the card opens on hover intent only.
 */
import { useState, type ReactElement } from 'react'
import useSWR from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { withBasePath } from '@/lib/base-path'
import { ReadResponseError } from '@/lib/swr/retry'
import { TaskStatusIcon } from '@/components/workspace/task-state-icon'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import type { ThreadPreview } from '@/lib/thread-preview'

export function useThreadPreview(issueId: string | null, enabled: boolean) {
  // A plain fetch honours the route's 30-second private cache (settings fetches
  // send no-store); SWR still dedupes per issue while the card stays open.
  return useSWR<ThreadPreview | null>(issueId && enabled ? ['thread-preview', issueId] : null,
    async ([, id]) => {
      const response = await fetch(withBasePath(`/api/threads/${id}/preview`))
      if (!response.ok) throw new ReadResponseError(response.status)
      return response.json() as Promise<ThreadPreview>
    })
}

export function ThreadHoverCard({ issueId, children }: { issueId: string | null; children: ReactElement }) {
  const t = useTranslations('Shell.panel.preview')
  const common = useTranslations('Common')
  const [open, setOpen] = useState(false)
  const { data, error } = useThreadPreview(issueId, open)
  return <HoverCard closeDelay={100} onOpenChange={setOpen}>
    <HoverCardTrigger delay={400} render={children} />
    <HoverCardContent side="right" align="start" className="flex flex-col gap-1.5">
      {!data && <p className="text-xs text-muted-foreground">{error ? t('unavailable') : common('loading')}</p>}
      {data && <>
        <div className="flex items-center gap-2">
          <TaskStatusIcon status={data.issueStatus ?? data.runStatus} size="sm" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium" dir="auto">{data.title ?? t('untitled')}</span>
        </div>
        {data.agentName && <p className="truncate text-xs text-muted-foreground">{t('agent', { name: data.agentName })}</p>}
        {data.lastReply && <p className="line-clamp-2 text-xs text-muted-foreground" dir="auto">{data.lastReply}</p>}
        {data.pullRequest && <a href={data.pullRequest.url} target="_blank" rel="noreferrer"
          className="truncate text-xs text-primary underline-offset-2 hover:underline" dir="auto">
          {data.pullRequest.title ?? t('pullRequest')}
        </a>}
      </>}
    </HoverCardContent>
  </HoverCard>
}

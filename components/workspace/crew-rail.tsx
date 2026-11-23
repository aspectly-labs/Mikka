'use client'

import useSWR from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { withBasePath } from '@/lib/base-path'
import { Button } from '@/components/ui/button'
import { ExternalLink, GitPullRequest, MessageSquare } from '@/components/icons'
import { ThreadList } from '@/components/nav/thread-list'
import { useLiveKey } from '@/hooks/use-live-key'
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

interface CoordinatorOverview {
  pullRequests: { issueId: string; branch: string | null; url: string | null; state: string | null; status: string; updatedAt: string }[]
}

interface ThreadChild { id: string; threadRelation: string | null; status: string; outcome: string | null; title: string | null; createdAt: string }

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(withBasePath(url), { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw new Error(`${response.status}`)
  return response.json() as Promise<T>
}

/** Crew ＋ All threads: every thread the owner can see, opening beside the chat. */
export function RailCrewThreads({ issues, threads, loading, onOpenThread }: { issues: Issue[]; threads: Thread[]; loading?: boolean; onOpenThread: (thread: { issueId: string | null; runId: string }) => void }) {
  return <ThreadList threads={threads} issues={issues} all stateKey="crew-threads" loading={loading} onOpenThread={onOpenThread} />
}

/** Crew ＋ Pull requests: the runs' published PRs from the coordinator overview. */
export function RailCrewPulls({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('IssueThreads')
  const { data, error } = useSWR<CoordinatorOverview>('/api/coordinator/overview', url => readJson<CoordinatorOverview>(url))
  useLiveKey('task_run_list', workspaceId, ['/api/coordinator/overview'], workspaceId)
  const pulls = data?.pullRequests ?? []
  if (error) return <p className="p-4 text-sm text-muted-foreground">{t('crewPullsError')}</p>
  if (!data) return null
  if (!pulls.length) return <p className="p-4 text-sm text-muted-foreground">{t('crewPullsEmpty')}</p>
  return <ul className="p-2">
    {pulls.map(pull => <li key={`${pull.issueId}:${pull.branch ?? ''}`}>
      <Button variant="bare" size="bare" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start hover:bg-muted/60" onClick={() => { if (pull.url) window.open(pull.url, '_blank', 'noopener') }}>
        <GitPullRequest data-icon className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm">{pull.branch ?? pull.url ?? pull.issueId}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{pull.state ?? pull.status}</span>
        <ExternalLink data-icon className="shrink-0 text-muted-foreground" />
      </Button>
    </li>)}
  </ul>
}

/** Crew ＋ Side threads: this thread's side conversations, opening beside it. */
export function RailCrewSide({ runId, workspaceId, onOpenThread }: { runId: string; workspaceId: string; onOpenThread: (thread: { issueId: string | null; runId: string }) => void }) {
  const t = useTranslations('IssueThreads')
  const key = `/api/threads/${runId}/children`
  const { data, error } = useSWR<{ children: ThreadChild[] }>(key, url => readJson<{ children: ThreadChild[] }>(url))
  useLiveKey('task_run_list', workspaceId, [key], workspaceId)
  const sides = (data?.children ?? []).filter(child => child.threadRelation === 'side')
  if (error) return <p className="p-4 text-sm text-muted-foreground">{t('crewSideError')}</p>
  if (!data) return null
  if (!sides.length) return <p className="p-4 text-sm text-muted-foreground">{t('crewSideEmpty')}</p>
  return <ul className="p-2">
    {sides.map(side => <li key={side.id}>
      <Button variant="bare" size="bare" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start hover:bg-muted/60" onClick={() => onOpenThread({ issueId: null, runId: side.id })}>
        <MessageSquare data-icon className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm">{side.title ?? t('untitledThread')}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{side.status}</span>
      </Button>
    </li>)}
  </ul>
}

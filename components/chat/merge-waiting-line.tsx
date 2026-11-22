'use client'

import { useState } from 'react'
import { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTaskCards } from '@/hooks/use-task-cards'
import { useTranslations } from '@/lib/intl/i18n-client'
import { submitInboxCommand } from '@/lib/inbox/client'
import { githubPullRequestKey, type IssuePullRequest } from '@/lib/issue-metadata'
import { pullChipState, type PullChipState } from '@/lib/pull-chip'
import { webSelectionVersion } from '@/lib/web-connection/selection'
import { PullRequestChip } from './pull-request-chip'

export type MergeWaiting = { issueId: string; url: string; state: PullChipState | null }
type Candidate = { issueId: string; pulls: readonly Pick<IssuePullRequest, 'url' | 'state'>[] }

const OPEN = new Set(['open', 'draft'])

/**
 * The tasks among `candidates` waiting on the person to merge their PR (#2922): the Inbox's own attention for the task
 * says `review` (so a dismissal there clears it here too) and an open PR is known for it. The PR is the one the task's
 * review reads, else its first open one; its colour is the PR's kept state and, while open, its settled checks.
 */
export function useMergeWaitings(candidates: readonly Candidate[]): MergeWaiting[] {
  const cards = useTaskCards(candidates.map(candidate => candidate.issueId))
  const seen = new Set<string>()
  const out: MergeWaiting[] = []
  for (const { issueId, pulls } of candidates) {
    const card = cards[issueId]
    if (seen.has(issueId) || card?.inboxReason !== 'review') continue
    seen.add(issueId)
    const reviewed = card.review?.pr?.url && OPEN.has(card.review.pr.state) ? card.review.pr.url : undefined
    const url = reviewed ?? pulls.find(pull => OPEN.has(pull.state))?.url
    if (!url) continue
    const kept = pulls.find(pull => githubPullRequestKey(pull.url) === githubPullRequestKey(url))?.state
      ?? (reviewed ? card.review!.pr!.state as IssuePullRequest['state'] : undefined)
    if (kept && !OPEN.has(kept)) continue
    out.push({ issueId, url, state: pullChipState(kept, reviewed ? card.review!.checks : null) })
  }
  return out
}

/**
 * Waiting on the person, as one centred line (#2922, Figma 1318:3): 「⁘ 等你合并 Mikka#2837 忽略」. Dismiss is the
 * Inbox's own dismissal of the task's attention (`/api/inbox`), so the line, the Inbox row and the board agree.
 */
export function MergeWaitingLine({ waiting, workspaceId }: { waiting: MergeWaiting; workspaceId: string | null }) {
  const t = useTranslations('MergeWaiting')
  const { mutate } = useSWRConfig()
  const [busy, setBusy] = useState(false)
  async function dismiss() {
    if (!workspaceId || busy) return
    setBusy(true)
    try {
      await submitInboxCommand({ workspaceId, type: 'task', id: waiting.issueId, action: 'dismiss' }, webSelectionVersion())
      await mutate(key => Array.isArray(key) && (key[0] === 'task-cards' || key[0] === 'task-presentations' || key[0] === 'inbox-queue' || key[0] === 'inbox-count'))
    } catch {
      toast.error(t('dismissFailed'))
    } finally {
      setBusy(false)
    }
  }
  // As Capy's waiting marker: centred, at most 86% (80% on wide screens) of the column; the words in the foreground while it
  // needs the person, the glyph and Dismiss muted (Figma 1318:3).
  return <div data-event-line="" data-merge-waiting={waiting.issueId} className="mx-auto flex max-w-[86%] flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground md:max-w-[80%]">
    <span aria-hidden="true">⁘</span>
    <span role="status" className="inline-flex flex-wrap items-center gap-1.5 text-foreground">{t.rich('line', { pr: () => <PullRequestChip url={waiting.url} state={waiting.state} /> })}</span>
    {workspaceId && <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" disabled={busy} aria-busy={busy} onClick={() => { void dismiss() }}>{t('dismiss')}</Button>}
  </div>
}

'use client'

/**
 * A thread's PR tab (#2929): the pull request the thread published — its facts
 * (branch, checks, reviewers), its diff drawn by the shared changes pane, and
 * the checks GitHub reports. Merge when ready arms the intent the thread's
 * pull list already drains; request-changes has no backend yet (deferred, see PR).
 */
import { useState } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { useTranslations } from '@/lib/intl/i18n-client'
import { withBasePath } from '@/lib/base-path'
import { ReadResponseError } from '@/lib/swr/retry'
import { setThreadPullMergeWhenReady } from '@/app/actions/agents'
import type { PullRequestFiles } from '@/lib/github/user-access'
import type { PullCheck, PullDetail, PullReview } from '@/lib/pull-directory'
import { PULL_STATE_TONES } from '@/lib/pull-request-appearance'
import type { ThreadPullRef } from '@/lib/thread-pulls'
import { useThreadPulls } from '@/hooks/use-thread-run-reads'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ExternalLink, GitMerge } from '@/components/icons'
import type { PullReviewResult } from '@/lib/pull-directory'
import { PullRequestIcon } from './pull-request-icon'
import { ThreadChangesPane } from './thread-changes'
import { Fact, checkKeys, readDetail, reviewKeys, stateKeys } from './pull-preview'

const checkRunKeys = {
  success: 'checksState.SUCCESS',
  failure: 'checksState.FAILURE',
  pending: 'checksState.PENDING',
  skipped: 'checksState.EXPECTED',
} as const satisfies Record<PullCheck['state'], `checksState.${string}`>

const mergeableKeys: Record<NonNullable<PullDetail['mergeable']>, `mergeableState.${string}`> = {
  MERGEABLE: 'mergeableState.MERGEABLE',
  CONFLICTING: 'mergeableState.CONFLICTING',
  UNKNOWN: 'mergeableState.UNKNOWN',
}

/** The rail's PR tab for the open thread: pick the pull still open, else the newest. */
export function RailThreadPull({ issueId, runId, status }: { issueId: string | null; runId: string; status?: string }) {
  const t = useTranslations('PullDirectory')
  const pulls = useThreadPulls(issueId, runId, status)
  const pull = pulls.data?.find(item => item.state === 'open' || item.state === 'draft') ?? pulls.data?.[0]
  if (!pull) return <p className="px-4 pt-3 text-xs text-muted-foreground">{pulls.data ? t('empty') : t('loading')}</p>
  return <ThreadPullPane issueId={issueId} runId={runId} pull={pull} onChanged={() => void pulls.mutate()} />
}

function ThreadPullPane({ issueId, runId, pull, onChanged }: {
  issueId: string | null; runId: string; pull: ThreadPullRef; onChanged: () => void
}) {
  const t = useTranslations('PullDirectory')
  const refusal = useTranslations('FactoryAcceptance.mergeRefusal')
  const common = useTranslations('Common')
  const detail = useSWR(['pull-detail', pull.repo, pull.number], ([, repo, number]) => readDetail(repo, number),
    { revalidateOnFocus: false, shouldRetryOnError: false })
  const [view, setView] = useState('overview')
  const [arming, setArming] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [reviewBody, setReviewBody] = useState('')
  const [reviewBusy, setReviewBusy] = useState(false)

  async function requestChanges() {
    const body = reviewBody.trim()
    if (!body) return
    setReviewBusy(true)
    try {
      const response = await fetch(withBasePath('/api/integrations/github/repositories/pulls/review'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: pull.repo, number: pull.number, body }),
      })
      const result = (await response.json().catch(() => ({}))) as { kind?: PullReviewResult['kind']; code?: string; error?: string }
      if (result.kind === 'submitted') {
        toast.success(t('reviewSubmitted'))
        setReviewing(false)
        setReviewBody('')
        void detail.mutate()
        return
      }
      toast.error(result.code === 'githubReviewSelf' ? t('reviewSelf') : t('reviewFailed'))
    } catch {
      toast.error(t('reviewFailed'))
    } finally {
      setReviewBusy(false)
    }
  }
  const armed = pull.mergeIntentState === 'armed' || pull.autoMerge

  async function mergeWhenReady(enabled: boolean) {
    const headSha = detail.data?.headSha ?? pull.headSha
    if (!headSha) return
    setArming(true)
    try {
      // The publishing run carries the intent — a continuation's pull does not
      // answer to the run the reader happens to have open (its own receipt row).
      const result = await setThreadPullMergeWhenReady(pull.issueId, pull.runId, { repo: pull.repo, number: pull.number, headSha, enabled })
      // The arm drains once: the outcome tells whether it already merged,
      // hit a terminal refusal, or is still waiting on GitHub.
      if (result?.outcome?.outcome === 'merged') { toast.success(t('states.merged')); void detail.mutate(); onChanged(); return }
      if (result?.outcome?.outcome === 'failed') { toast.error(t('mergeFailed')); void detail.mutate(); onChanged(); return }
      if (result?.state === 'armed' || result?.state === 'cancelled') { toast.success(result.state === 'armed' ? t('mergeArmed') : t('mergeDisarmed')); onChanged(); return }
      toast.error(t('mergeFailed'))
    } catch {
      toast.error(t('mergeFailed'))
    } finally {
      setArming(false)
    }
  }

  const checks = detail.data?.checkRuns ?? []
  const failing = checks.filter(check => check.state === 'failure').length
  const pendingChecks = checks.filter(check => check.state === 'pending').length
  const passed = checks.filter(check => check.state === 'success').length
  const reviewers: [string, PullReview['state']][] = [
    ...new Map((detail.data?.reviews ?? [])
      .filter(item => item.author && item.state !== 'PENDING' && item.state !== 'COMMENTED')
      .map(item => [item.author as string, item.state])).entries(),
  ]
  const review = detail.data?.reviewDecision
  const mergeable = detail.data?.mergeable

  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex shrink-0 flex-col gap-1 px-4 pb-2 pt-3">
      <div className="flex flex-wrap items-center gap-1">
        <PullRequestIcon state={pull.state} />
        <bdi className="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums">{pull.repo} #{pull.number}</bdi>
        {(pull.state === 'open' || pull.state === 'draft') && <>
          <Button size="sm" variant={armed ? 'secondary' : 'default'} disabled={arming || !(detail.data?.headSha ?? pull.headSha)} onClick={() => void mergeWhenReady(!armed)}>
            <GitMerge data-icon />{armed ? t('mergeDisarm') : t('mergeWhenReady')}
          </Button>
        </>}
        {(pull.state === 'open' || pull.state === 'draft') && (
          <Button size="sm" variant="secondary" onClick={() => setReviewing(true)}>{t('requestChanges')}</Button>
        )}
        <Button size="sm" variant="secondary" nativeButton={false}
          render={<a href={pull.url} target="_blank" rel="noopener noreferrer" />}>
          <ExternalLink data-icon />{t('openGitHub')}
        </Button>
      </div>
      <h2 className="text-md font-semibold break-words">{pull.title || `${pull.repo} #${pull.number}`}</h2>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
        <span className={PULL_STATE_TONES[pull.state]}>{t(stateKeys[pull.state])}</span>
      </p>
    </header>
    <Tabs value={view} onValueChange={key => setView(String(key))} className="min-h-0 flex-1 gap-0">
      <TabsList aria-label={t('preview')}>
        <TabsTrigger value="overview">{t('overview')}</TabsTrigger>
        <TabsTrigger value="diff">{t('changes')}</TabsTrigger>
        <TabsTrigger value="checks">{t('checks')}</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="flex min-h-0 flex-col gap-4 overflow-auto px-4 pb-6 pt-3">
        <dl className="grid grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-y-1.5 text-xs">
          <Fact label={t('checks')}>
            {checks.length ? <span className="tabular-nums">{t('checkCounts', { passed, failing, pending: pendingChecks })}</span> : t(checkKeys[detail.data?.checks ?? 'unknown'])}
          </Fact>
          <Fact label={t('review')}>
            {t(reviewKeys[review === 'APPROVED' || review === 'CHANGES_REQUESTED' || review === 'REVIEW_REQUIRED' ? review : 'unknown'])}
          </Fact>
          {reviewers.length > 0 && <Fact label={t('reviewers')}>
            <span className="flex flex-col items-start gap-0.5">
              {reviewers.map(([author, state]) => <span key={author}>@{author} · {t(reviewKeys[state === 'APPROVED' || state === 'CHANGES_REQUESTED' ? state : 'unknown'])}</span>)}
            </span>
          </Fact>}
          <Fact label={t('branch')}>
            {detail.data?.base && detail.data.head
              ? <bdi dir="ltr" className="block break-all font-mono text-xs">{detail.data.base} ← {detail.data.head}</bdi>
              : t('notReported')}
          </Fact>
          {mergeable && <Fact label={t('mergeable')}>
            {t(mergeableKeys[mergeable] as never)}
          </Fact>}
        </dl>
        {!detail.data && <p className="text-xs text-muted-foreground">{detail.error ? t('detailFailed') : common('loading')}</p>}
      </TabsContent>
      <TabsContent value="diff" className="min-h-0 flex-1 overflow-auto">
        <PullDiff repo={pull.repo} number={pull.number} />
      </TabsContent>
      <TabsContent value="checks" className="flex min-h-0 flex-col gap-1 overflow-auto px-4 pb-6 pt-3">
        {!detail.data && <p className="text-xs text-muted-foreground">{detail.error ? t('detailFailed') : common('loading')}</p>}
        {detail.data && checks.length === 0 && <p className="text-xs text-muted-foreground">{t('noChecks')}</p>}
        {checks.map((check, index) => <div key={`${check.name}-${index}`} className="flex items-center gap-2 py-0.5 text-xs">
          <span className={check.state === 'failure' ? 'text-destructive-foreground' : check.state === 'success' ? 'text-github-pr-open' : 'text-muted-foreground'}>
            {t(checkRunKeys[check.state])}
          </span>
          {check.url
            ? <a href={check.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-foreground underline-offset-2 hover:underline">{check.name}</a>
            : <span className="min-w-0 flex-1 truncate">{check.name}</span>}
        </div>)}
        {detail.data?.moreChecks && <p className="text-xs text-muted-foreground">{t('moreChecks')}</p>}
      </TabsContent>
    </Tabs>
    <Dialog open={reviewing} onOpenChange={next => { if (!next) setReviewing(false) }}>
      <DialogContent>
        <DialogTitle>{t('requestChangesTitle', { repo: pull.repo, number: pull.number })}</DialogTitle>
        <Textarea value={reviewBody} onChange={event => setReviewBody(event.target.value)}
          placeholder={t('requestChangesBody')} rows={5} autoFocus />
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => setReviewing(false)}>{common('cancel')}</Button>
          <Button size="sm" disabled={reviewBusy || !reviewBody.trim()} onClick={() => void requestChanges()}>
            {reviewBusy ? common('saving') : t('requestChanges')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}

/** The PR's own file diff, drawn by the same pane as a thread's Changes. */
function PullDiff({ repo, number }: { repo: string; number: number }) {
  const common = useTranslations('Common')
  const t = useTranslations('PullDirectory')
  const files = useSWR(['pull-files', repo, number], async ([, name, pull]) => {
    const response = await fetch(withBasePath('/api/integrations/github/repositories/pulls/files?' + new URLSearchParams({ repo: name, number: String(pull) })))
    if (!response.ok) throw new ReadResponseError(response.status)
    return (await response.json()) as PullRequestFiles
  }, { revalidateOnFocus: false, shouldRetryOnError: false })
  if (files.error) return <p className="p-4 text-xs text-muted-foreground">{t('detailFailed')}</p>
  if (!files.data) return <p className="p-4 text-xs text-muted-foreground">{common('loading')}</p>
  return <>
    {(files.data.moreFiles || files.data.patchUnavailable > 0) && (
      <p className="px-4 pt-3 text-xs text-muted-foreground">
        {files.data.moreFiles ? t('diffPartial') : t('diffPatchUnavailable', { count: files.data.patchUnavailable })}
      </p>
    )}
    <ThreadChangesPane stateKey={`pull:${repo}:${number}`} changes={files.data.changes} />
  </>
}

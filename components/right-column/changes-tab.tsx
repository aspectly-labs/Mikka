'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { Skeleton } from '@/components/ui/skeleton'
import { InlineLoadError } from '@/components/load-error'
import dynamic from '@/lib/client-runtime/dynamic'
import { useThreadChanges } from '@/hooks/use-thread-run-reads'
import type { RightColumnScope } from './scope'

// The diff viewer (@pierre/diffs) loads with this tab, not with the thread.
const ThreadChangesPane = dynamic(() => import('@/components/workspace/thread-changes').then(module => module.ThreadChangesPane))

/** Changes (Figma 1318:7): the thread's saved diff, the same read-only pane its ⋯ 改动 view draws (getThreadChanges). */
export function ChangesTab({ scope }: { scope: Extract<RightColumnScope, { kind: 'thread' }> }) {
  const t = useTranslations('RightColumn.changes')
  const { data, error, mutate } = useThreadChanges(scope.issueId, scope.runId)
  if (error) return <div className="p-4"><InlineLoadError message={t('loadFailed')} retryLabel={t('retry')} onRetry={() => { void mutate() }} /></div>
  if (!data) return <div role="status" className="flex flex-col gap-2 p-3"><Skeleton className="h-8 w-full" /><Skeleton className="h-40 w-full" /></div>
  if (data.state !== 'ready') return <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t(data.state === 'tooLarge' ? 'tooLarge' : 'none')}</p>
  return <ThreadChangesPane changes={data.changes} stateKey={`right-column:changes:${scope.runId}`} />
}

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { withBasePath } from '@/lib/base-path'
import type { ActiveAgent } from '@/lib/active-agents'
import { activeToWorkers, workersKey, workingAvatars, workingLabel, type Worker } from '@/lib/working-status'
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from '@/components/ui/avatar'
import { BotAvatar } from '@/components/slots/bot-avatar'
import { ActionSwapRollText } from '@/components/motion/action-swap-roll'
import { TextShimmer } from '@/components/motion/text-shimmer'

const COALESCE_MS = 300

async function fetchActiveAgents(url: string): Promise<{ agents: ActiveAgent[] }> {
  const response = await fetch(withBasePath(url), { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw new Error('working status unavailable')
  return response.json()
}

/** Waits until the value has held still for `delay`, so bursts only show their last state. */
function useSettled<T>(value: T, delay: number) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return settled
}

/** "Who is working" strip above the group composer. Hidden when nobody is working.
 * Polls only after the group's live channel reports a change — an idle group
 * makes zero activity requests (tests/idle-request-budget.json). */
export function WorkingStatus({ revision }: { revision: number | undefined }) {
  const t = useTranslations('GroupChat.workingStatus')
  const { data, mutate } = useSWR('/api/agent/sessions/active', fetchActiveAgents, { revalidateOnFocus: false })
  const last = useRef(revision)
  useEffect(() => {
    if (revision !== undefined && revision !== last.current) {
      last.current = revision
      void mutate()
    }
  }, [revision, mutate])
  const workers = useMemo<Worker[]>(() => activeToWorkers(data?.agents), [data])
  const settled = useSettled(workers, COALESCE_MS)
  const key = workersKey(settled)
  const label = workingLabel(settled.map(worker => worker.name))
  if (!label) return null
  const { shown, overflow } = workingAvatars(settled)
  const text = label.key === 'many' ? t('many', label.values) : t(label.key, label.values)

  return <div aria-live="polite" className="flex h-7 min-w-0 items-center overflow-hidden">
    <ActionSwapRollText value={key} className="min-w-0">
      <span className="flex min-w-0 items-center gap-2">
        <AvatarGroup className="-space-x-1.5">
          {shown.map(worker => worker.kind === 'bot'
            ? <BotAvatar key={worker.id} color={worker.color} shape={worker.shape} size="pill" still />
            : <Avatar key={worker.id} className="size-5">
                <AvatarFallback className="text-xs">{worker.name.slice(0, 1)}</AvatarFallback>
              </Avatar>)}
          {overflow > 0 && <AvatarGroupCount className="size-5 text-xs">+{overflow}</AvatarGroupCount>}
        </AvatarGroup>
        <span className="min-w-0 truncate text-sm leading-5 text-muted-foreground">
          <TextShimmer duration={2}>{text}</TextShimmer>
        </span>
      </span>
    </ActionSwapRollText>
  </div>
}

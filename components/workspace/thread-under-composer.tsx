'use client'

import type { ReactNode } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Check, ChevronDown, GitBranch, Plus } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Link } from '@/i18n/navigation'
import { settingsHref } from '@/lib/settings-sections'
import { useThreadMachine, useThreadSummary } from '@/hooks/use-thread-run-reads'
import { MACHINE_SIZES, machineHourlyUsd, type MachineSize } from '@/lib/cloud-computer/machine-pricing'
import { machineDot, machineStateWord, type ThreadMachine } from '@/lib/thread-machine'
import { KIND_ICONS, useMachineName } from './thread-run-place'
import { ContextRing } from '@/components/chat/context-ring'
import { statusDots } from '@/lib/status-appearance'
import { cn } from '@/lib/utils'

/** Green while the machine is awake or online, red on error, grey asleep or offline (Figma 1318:2 section 19). */
function Dot({ dot }: { dot: ReturnType<typeof machineDot> }) {
  return <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', statusDots[dot === 'running' ? 'success' : dot === 'failed' ? 'destructive' : 'neutral'])} />
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** The summary's context against the model's window, when the thread read did not bring its own ring. */
function SummaryRing({ used, max }: { used: number; max: number }) {
  const t = useTranslations('ThreadUnderComposer')
  const name = t('context', { used: compact.format(used), max: compact.format(max) })
  return <span role="img" aria-label={name} title={name} data-slot="thread-context-ring" className="grid size-6 place-items-center">
    <ContextRing share={Math.round(used / max * 100)} />
  </span>
}

/** A cloud machine is awake or asleep, as Capy says it; a computer or server keeps its own state word (ThreadRunPlace.states). */
function useStateWord() {
  const t = useTranslations('ThreadUnderComposer')
  const place = useTranslations('ThreadRunPlace')
  return (machine: ThreadMachine) => machine.kind === 'cloud' && (machine.state === 'running' || machine.state === 'paused')
    ? t(machine.state === 'running' ? 'awake' : 'asleep')
    : place(`states.${machineStateWord(machine)}`)
}

/**
 * Where the thread runs, as Capy's composer footer names it (Figma `1318:2` section 19): 「Cloud」 and the state dot,
 * or the computer's name. The size, the state and the hourly price are in its menu. The menu offers only what Mikka
 * can do today: adding a machine (设置 · 电脑). Moving the thread, sleeping or keeping the machine awake and running
 * setup again have no write yet (#2936, #2940), so they are not offered.
 */
function MachineMenu({ machine, size }: { machine: ThreadMachine; size: MachineSize | null }) {
  const t = useTranslations('ThreadUnderComposer')
  const name = useMachineName()(machine)
  const state = useStateWord()(machine)
  const Icon = KIND_ICONS[machine.kind]
  const dot = machineDot(machine.state)
  const label = machine.kind === 'cloud' ? t('cloud') : name
  const spec = size ? t('size', { vcpu: MACHINE_SIZES[size].vcpu, gib: MACHINE_SIZES[size].gib }) : null
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="xs" data-slot="thread-machine-trigger"
      aria-label={t('machineLabel', { name: label, state })} className="min-w-0 gap-1.5 px-1.5 text-muted-foreground" />}>
      <Icon aria-hidden="true" data-icon="inline-start" />
      <span className="min-w-0 truncate">{label}</span>
      <Dot dot={dot} />
      <ChevronDown aria-hidden="true" data-icon="inline-end" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" side="top" className="w-72">
      <DropdownMenuGroup>
        <DropdownMenuLabel>{t('runsOn')}</DropdownMenuLabel>
        <div data-slot="thread-machine-current" className="flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-sm">
          <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{machine.kind === 'cloud' ? spec ? `${t('cloud')} · ${spec}` : t('cloud') : name}</span>
            {machine.kind === 'cloud' && size && <span className="text-xs text-muted-foreground">{t('hourly', { price: machineHourlyUsd(size).toFixed(2) })}</span>}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"><Dot dot={dot} />{state}</span>
          <Check aria-label={t('current')} className="mt-0.5 size-4 shrink-0" />
        </div>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem render={<Link href={settingsHref('computers')} />}><Plus aria-hidden="true" />{t('addMachine')}</DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
}

/**
 * The row under a thread's composer (Figma `1318:2` section 19, #2926): where it runs, its repository and branch, and
 * the context ring on the right. Each part shows only what Mikka records (lib/thread-summary.ts); a part with nothing
 * recorded is left out. The branch has no menu: Mikka has no write that moves a thread to another branch.
 */
export function ThreadUnderComposer({ issueId, runId, status, context }: { issueId: string | null; runId: string; status: string; context?: ReactNode }) {
  const t = useTranslations('ThreadUnderComposer')
  const { data: machine } = useThreadMachine(issueId, runId, status)
  const { data: summary } = useThreadSummary(runId, status)
  const repo = summary?.repo ? [summary.repo.name, summary.branch].filter(Boolean).join(' · ') : null
  const ring = context ?? (summary?.context.max ? <SummaryRing used={summary.context.used} max={summary.context.max} /> : null)
  if (!machine && !repo && !ring) return null
  return <div data-slot="thread-under-composer" className="flex min-w-0 items-center gap-2 px-1 text-xs text-muted-foreground">
    {machine && <MachineMenu machine={machine} size={summary?.machine?.kind === 'cloud' ? summary.machine.size : null} />}
    {repo && <span data-slot="thread-repository" className="flex min-w-0 items-center gap-1.5 px-1.5" title={repo} aria-label={t('repository', { name: repo })}>
      <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{repo}</span>
    </span>}
    {ring && <span className="ms-auto flex shrink-0 items-center">{ring}</span>}
  </div>
}

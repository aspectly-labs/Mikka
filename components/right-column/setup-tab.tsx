'use client'

import type { ReactNode } from 'react'
import { useFormatter, useNow, useTranslations } from '@/lib/intl/i18n-client'
import { ExternalLink, Server } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { InlineLoadError } from '@/components/load-error'
import { useThreadMachineMetrics, useThreadWorkspace } from '@/hooks/use-thread-workspace'
import { withBasePath } from '@/lib/base-path'
import { MACHINE_SIZES, isMachineSize } from '@/lib/cloud-computer/machine-pricing'
import type { ThreadMachineMetrics, ThreadWorkspace } from '@/lib/thread-workspace'
import type { RightColumnScope } from './scope'

/**
 * Setup (#2928, Figma 1318:19): where the thread runs and what it was set up with. The machine's kind, state and
 * size, how long it has run and, for a running sandbox, its recorded CPU, memory and disk; the Environment the run was
 * admitted with and its setup command. A Bot's chat has no machine and no Setup tab. Startup commands,
 * snapshots and 「Run setup again」 have no backend yet (#2940) and are left out.
 */
export function SetupTab({ scope }: { scope: RightColumnScope }) {
  return scope.kind === 'thread' ? <ThreadSetup runId={scope.runId} /> : null
}

type Environment = NonNullable<ThreadWorkspace['environment']> & { defaultMachineSize?: string | null }


function ThreadSetup({ runId }: { runId: string }) {
  const t = useTranslations('RightColumn.setup')
  const workspace = useThreadWorkspace(runId)
  const machine = workspace.data?.machine ?? null
  const metrics = useThreadMachineMetrics(workspace.data?.liveRunId ?? null, machine?.kind === 'cloud' && machine.state === 'running')
  if (workspace.error || workspace.refused) return <div className="p-4"><InlineLoadError message={t('loadFailed')} retryLabel={t('retry')} onRetry={workspace.retry} /></div>
  if (!workspace.data) return <Loading />
  return <div data-slot="right-column-setup" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
    {machine ? <Machine machine={machine} metrics={metrics} /> : <p className="text-xs text-muted-foreground">{t('noMachine')}</p>}
    {workspace.data.environment ? <EnvironmentSection environment={workspace.data.environment} /> : <p className="text-xs text-muted-foreground">{t('noEnvironment')}</p>}
  </div>
}

function Loading() {
  return <div role="status" className="flex flex-col gap-2 p-3"><Skeleton className="h-8 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-16 w-full" /></div>
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return <section aria-label={title} className="flex flex-col gap-1.5">
    <h3 className="px-1 text-xs font-medium text-muted-foreground">{title}{count !== undefined && <span className="ms-1.5 tabular-nums">{count}</span>}</h3>
    {children}
  </section>
}

const GIB = 1024 ** 3
const sizeSpec = (size: string | null | undefined) => size && isMachineSize(size) ? MACHINE_SIZES[size] : null

function Machine({ machine, metrics }: { machine: NonNullable<ThreadWorkspace['machine']>; metrics: ThreadMachineMetrics | null }) {
  const t = useTranslations('RightColumn.setup')
  const place = useTranslations('ThreadRunPlace')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const duration = useDuration()
  const spec = sizeSpec(machine.size)
  const running = machine.state === 'running' || machine.state === 'online'
  const uptime = running && machine.startedAt ? Math.max(0, now.getTime() - Date.parse(machine.startedAt)) : null
  const gb = (bytes: number) => format.number(bytes / GIB, { maximumFractionDigits: 1 })
  return <Section title={t('machine')}>
    <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
      <Badge variant={running ? 'secondary' : 'outline'}>{place(`states.${machine.state}`)}</Badge>
      <span className="min-w-0 flex-1 truncate text-sm">{machine.name || place(`kinds.${machine.kind}`)}</span>
      {spec && <span className="shrink-0 text-xs text-muted-foreground">{t('spec', { cpu: spec.vcpu, memory: spec.gib })}</span>}
    </div>
    {(metrics || uptime !== null) && <dl className="grid grid-cols-4 gap-2 px-1 text-xs">
      {metrics && <Stat label={t('cpu')} value={`${format.number(metrics.cpuUsedPct, { maximumFractionDigits: 0 })}%`} />}
      {metrics && <Stat label={t('memory')} value={`${gb(metrics.memUsed)} / ${gb(metrics.memTotal)} GB`} />}
      {metrics && <Stat label={t('disk')} value={`${gb(metrics.diskUsed)} / ${gb(metrics.diskTotal)} GB`} />}
      {uptime !== null && <Stat label={t('uptime')} value={duration(uptime)} />}
    </dl>}
  </Section>
}

function useDuration() {
  const t = useTranslations('RightColumn.setup')
  return (ms: number) => {
    const minutes = Math.floor(ms / 60_000)
    return minutes < 60 ? t('minutes', { count: minutes }) : t('hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
  }
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="flex min-w-0 flex-col gap-0.5"><dt className="text-muted-foreground">{label}</dt><dd className="truncate font-mono tabular-nums">{value}</dd></div>
}

function EnvironmentSection({ environment }: { environment: Environment }) {
  const t = useTranslations('RightColumn.setup')
  const spec = sizeSpec(environment.defaultMachineSize)
  return <>
    <Section title={t('environment')}>
      <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
        <Server className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm">{environment.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{t(`runtime.${environment.runtime === 'local' || environment.runtime === 'cloud' ? environment.runtime : 'any'}`)}{spec ? ` · ${t('spec', { cpu: spec.vcpu, memory: spec.gib })}` : ''}</span>
      </div>
      {environment.repositories.length > 0 && <p className="truncate px-1 text-xs text-muted-foreground" title={environment.repositories.join(', ')}>{environment.repositories.map(key => key.split('/').slice(-2).join('/')).join(', ')}</p>}
    </Section>
    <Section title={t('scripts')} count={environment.setup ? (environment.setup.command ? 1 : 0) + (environment.setup.copyFiles.length ? 1 : 0) : 0}>
      {!environment.setup || (!environment.setup.command && !environment.setup.copyFiles.length) ? <p className="px-1 text-xs text-muted-foreground">{t('noSetup')}</p> : <div className="flex flex-col gap-1">
        {environment.setup.command && <Script label={t('install')} body={environment.setup.command} note={environment.setup.approved ? undefined : t('unapproved')} />}
        {environment.setup.copyFiles.length > 0 && <Script label={t('copyFiles', { count: environment.setup.copyFiles.length })} body={environment.setup.copyFiles.join(' ')} />}
      </div>}
    </Section>
    <a href={withBasePath('/settings/environments')} className="inline-flex w-fit items-center gap-1.5 rounded-md px-1 text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
      {t('edit')}<ExternalLink className="size-3.5" />
    </a>
  </>
}

function Script({ label, body, note }: { label: string; body: string; note?: string }) {
  return <div className="flex flex-col gap-0.5 rounded-lg border px-3 py-2">
    <span className="text-xs text-muted-foreground">{label}{note && <span className="ms-1.5 text-warning-foreground">{note}</span>}</span>
    <code className="truncate font-mono text-xs" title={body}>{body}</code>
  </div>
}

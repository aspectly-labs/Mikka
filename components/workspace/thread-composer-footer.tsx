'use client'

import { useState, useTransition } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { useTranslations } from '@/lib/intl/i18n-client'
import { useThreadMachine, useThreadMachineDetail } from '@/hooks/use-thread-run-reads'
import { listDevices, pauseOrResumeThreadMachine, rerunThreadMachineSetup, setThreadMachineKeepAwake, moveThreadToTarget } from '@/app/actions/agents'
import { cloudShortId, machineDot, type ThreadMachine } from '@/lib/thread-machine'
import { runIsActive } from '@/lib/issue-run-conversation'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Cloud, Laptop, Server, ChevronDown, ChevronRight, GitBranch, Moon, Sun, RefreshCw, Plus, Copy, Check, Monitor } from '@/components/icons'
import { settingsHref } from '@/lib/settings-sections'
import { statusDots } from '@/lib/status-appearance'
import { markOfValue, stateMarkTone } from '@/lib/state-mark'
import { cn } from '@/lib/utils'
import { useRouter } from 'next/navigation'

const KIND_ICONS = { cloud: Cloud, laptop: Laptop, server: Server } as const

function StateDot({ machine }: { machine: ThreadMachine }) {
  const dot = machineDot(machine.state)
  return <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', statusDots[stateMarkTone(markOfValue(dot))])} />
}

function Trigger({ children, 'aria-label': ariaLabel }: { children: React.ReactNode; 'aria-label': string }) {
  return (
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="sm" aria-label={ariaLabel}
        className="h-6 gap-1.5 rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
        {children}
        <ChevronDown aria-hidden="true" className="size-3 opacity-60" />
      </Button>
    </DropdownMenuTrigger>
  )
}

/** #2926 "Under composer" row: the machine trigger (kind icon, name, state dot)
 * and the repo · branch trigger, left-aligned under the composer input. */
export function ThreadComposerFooter({ issueId, runId, status }: { issueId: string | null; runId: string; status: string }) {
  const t = useTranslations('IssueThreads.machineMenu')
  const router = useRouter()
  const machine = useThreadMachine(issueId, runId, status)
  const detail = useThreadMachineDetail(issueId, runId, status)
  const [open, setOpen] = useState(false)
  const { data: devices } = useSWR(open ? 'devices' : null, listDevices, { revalidateOnFocus: false, shouldRetryOnError: false })
  const [pending, startTransition] = useTransition()

  const m = machine.data
  const d = detail.data
  const Icon = KIND_ICONS[m?.kind ?? 'cloud'] ?? Cloud
  const running = m ? machineDot(m.state) === 'running' : false
  // Runtime admission: pause/resume/refresh_runtime need a cloud machine row, wake
  // rejects a finished E2B run and setup rejects an active one — and the sponsored
  // provider reconciles its machines outside the idle-sleep branch keepAwake guards.
  const isCloud = m?.kind === 'cloud'
  const sponsored = d?.spec.snapshotId === 'cloudflare-task-v1'
  const terminal = ['succeeded', 'failed', 'stopped', 'cancelled'].includes(status)
  const showPower = isCloud && (running || m?.state === 'paused')
  const showSetup = isCloud && terminal
  const showKeepAwake = isCloud && !sponsored
  // Moving a run whose worker is still live breaks its device-bound completion.
  const movable = !(runIsActive(status) && running)
  const refresh = () => { void machine.mutate(); void detail.mutate() }
  const act = (fn: () => Promise<unknown>, failKey: string) => startTransition(async () => {
    try { await fn(); refresh() } catch { toast.error(t(failKey)) }
  })

  return (
    <div className="flex h-5 items-center gap-1 px-1" data-slot="thread-composer-footer">
      {m && (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <Trigger aria-label={t('machine')}>
            <Icon aria-hidden="true" className="size-3.5" />
            <span className="max-w-36 truncate">{m.kind === 'cloud' ? 'Cloud' : m.name}</span>
            <StateDot machine={m} />
          </Trigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t('runOn')}</DropdownMenuLabel>
              <DropdownMenuItem disabled className="flex-col items-start gap-0.5 opacity-100">
                <span className="flex items-center gap-2">
                  <Icon aria-hidden="true" className="size-4" />
                  <span className="font-medium">{m.kind === 'cloud' ? `E2B ${t('cloud')}` : m.name}</span>
                  <Check aria-hidden="true" className="ms-auto size-3.5" />
                </span>
                <span className="ps-6 text-xs text-muted-foreground">
                  {m.kind === 'cloud'
                    ? `${t('cloud')} · ${m.cloud?.sandboxId ? cloudShortId(m.cloud.sandboxId) : ''}`
                    : m.hostname ?? m.name}
                  {' · '}{t(running ? 'awake' : 'asleep')}
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => router.push(settingsHref('computers'))}>
                <Plus aria-hidden="true" className="size-4" />{t('addMachine')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {(showPower || showSetup || showKeepAwake) && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              {showPower && (
                <DropdownMenuItem disabled={pending} onSelect={() => act(() => pauseOrResumeThreadMachine(issueId, runId, running ? 'pause' : 'resume'), running ? 'sleepFailed' : 'wakeFailed')}>
                  {running ? <Moon aria-hidden="true" className="size-4" /> : <Sun aria-hidden="true" className="size-4" />}
                  {t(running ? 'machineSleep' : 'machineWake')}
                </DropdownMenuItem>
              )}
              {showSetup && (
                <DropdownMenuItem disabled={pending} onSelect={() => act(() => rerunThreadMachineSetup(issueId, runId), 'setupFailed')}>
                  <RefreshCw aria-hidden="true" className="size-4" />{t('runSetupAgain')}
                </DropdownMenuItem>
              )}
              {showKeepAwake && (
                <DropdownMenuItem
                  onSelect={event => event.preventDefault()}
                  className="flex items-center justify-between gap-3">
                  <span className="flex flex-col gap-0.5">
                    <span className="flex items-center gap-2">{t('machineKeepAwake')}</span>
                    <span className="text-xs text-muted-foreground">{t('keepAwakeHint')}</span>
                  </span>
                  <Switch
                    checked={d?.keepAwake ?? false}
                    disabled={pending || !d}
                    onCheckedChange={checked => act(() => setThreadMachineKeepAwake(issueId, runId, checked), 'keepAwakeFailed')}
                  />
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            {movable && <DropdownMenuSeparator />}
            {movable && (
              <DropdownMenuGroup>
                {m.kind !== 'cloud' && (
                  <DropdownMenuItem disabled={pending} onSelect={() => act(() => moveThreadToTarget(issueId, runId, { deviceId: 'cloud' }), 'moveFailed')}>
                    <Cloud aria-hidden="true" className="size-4" />{t('moveToCloud')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Monitor aria-hidden="true" className="size-4" />{t('moveToDevice')}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {(devices ?? []).filter(device => device.id !== d?.spec.deviceId).map(device => (
                      <DropdownMenuItem key={device.id} disabled={pending}
                        onSelect={() => act(() => moveThreadToTarget(issueId, runId, { deviceId: device.id }), 'moveFailed')}>
                        <Laptop aria-hidden="true" className="size-4" />{device.name}
                      </DropdownMenuItem>
                    ))}
                    {devices && devices.length === 0 && <DropdownMenuItem disabled>{t('noDevices')}</DropdownMenuItem>}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuGroup>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {d?.repo && (
        <DropdownMenu>
          <Trigger aria-label={t('repo')}>
            <GitBranch aria-hidden="true" className="size-3.5" />
            <span className="max-w-48 truncate">{d.repo.name}{d.repo.baseBranch ? ` · ${d.repo.baseBranch}` : ''}</span>
          </Trigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel className="max-w-64 truncate">{d.repo.name}{d.repo.baseBranch ? ` · ${d.repo.baseBranch}` : ''}</DropdownMenuLabel>
            {d.repo.baseBranch && (
              <DropdownMenuItem onSelect={() => { void navigator.clipboard.writeText(d.repo!.baseBranch!); toast.success(t('branchCopied')) }}>
                <Copy aria-hidden="true" className="size-4" />{t('copyBranch')}
              </DropdownMenuItem>
            )}
            {d.repo.remoteUrl && (
              <DropdownMenuItem onSelect={() => window.open(remoteToUrl(d.repo!.remoteUrl!), '_blank', 'noopener')}>
                <ChevronRight aria-hidden="true" className="size-4" />{t('openRemote')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <div className="flex-1" />
    </div>
  )
}

/** git@github.com:owner/repo.git → https://github.com/owner/repo */
function remoteToUrl(remote: string): string {
  const cleaned = remote.trim().replace(/\.git$/, '')
  const ssh = cleaned.match(/^git@([^:]+):(.+)$/)
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`
  return cleaned
}


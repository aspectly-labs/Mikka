'use client'

import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import type { listActivity } from '@/app/actions/settings-activity'
import type { getUsage } from '@/app/actions/usage'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { useUsageDuration } from '@/components/settings/usage-view'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsTable } from '@/components/ui/settings-layout'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useLocale, useTranslations } from '@/lib/intl/i18n-client'
import type { ActivityItem } from '@/lib/settings/activity'
import type { ActivityFilter } from '@/lib/settings/activity-cursor'
import type { WorkspaceOpsMetricsView } from '@/lib/settings/device-policy-contract'
import { fetchSettingsData, isSettingsAccessError, settingsReadOptions } from '@/lib/settings-data'
import { settingsRead } from '@/lib/settings-read'
import { withPendingSuffix } from '@/lib/settings-sections'
import { settingsKeys } from '@/lib/swr/keys'
import { currentMonth, recentMonths } from '@/lib/usage/month'

const SWR_IDLE_SAFE = {
  ...settingsReadOptions,
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
} as const

export interface ActivitySettingsProps {
  workspaceId?: string
  admin?: boolean
  personal?: boolean
}

function formatBytes(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  const fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: exponent === 0 ? 0 : 1 })
  return `${fmt.format(value)} ${units[exponent]}`
}

/**
 * Frame 28 活动 (776px wide): workspace operational metrics (`GET /api/workspaces/:id/ops-metrics`),
 * real monthly Agent runtime & daily thread bars (`settingsRead('usage')`), personal activity
 * timeline (`listActivity`), and honest `· 待接入` markers for unmerged P8 (#2962) PR charts.
 */
export function ActivitySettings({
  workspaceId,
  admin = true,
  personal = false,
}: ActivitySettingsProps) {
  const t = useTranslations('Settings.activityPage')
  const usageT = useTranslations('Settings.usage')
  const commonT = useTranslations('Common')
  const locale = useLocale()
  const duration = useUsageDuration()

  const [month, setMonth] = useState(() => currentMonth())
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all')
  const [botFilter, setBotFilter] = useState<string>('all')
  const [memberFilter, setMemberFilter] = useState<string>('all')

  const [extraItems, setExtraItems] = useState<ActivityItem[]>([])
  const [extraCursor, setExtraCursor] = useState<string | null | undefined>(undefined)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)

  useEffect(() => {
    setExtraItems([])
    setExtraCursor(undefined)
    setLoadMoreError(null)
  }, [activityFilter])

  const opsMetrics = useSWR(
    workspaceId && admin ? (['workspace-ops-metrics', workspaceId] as const) : null,
    ([, id]) => fetchSettingsData<WorkspaceOpsMetricsView>(`/api/workspaces/${encodeURIComponent(id)}/ops-metrics`),
    SWR_IDLE_SAFE,
  )

  const usage = useSWR(
    workspaceId ? settingsKeys.usage(workspaceId, month) : null,
    () => settingsRead<Awaited<ReturnType<typeof getUsage>>>('usage', { month, workspace: workspaceId }),
    { ...SWR_IDLE_SAFE, keepPreviousData: true },
  )
  const usageData = usage.data && !usage.data.error ? usage.data : null
  const isWorkspaceScope = usageData?.scope === 'workspace'

  const timeline = useSWR(
    ['settings:activity-timeline', activityFilter] as const,
    ([, filter]) => settingsRead<Awaited<ReturnType<typeof listActivity>>>('activity', { filter }),
    SWR_IDLE_SAFE,
  )
  const firstPage = timeline.data && !timeline.data.error ? timeline.data : null

  const allTimelineItems = useMemo(() => {
    const base = firstPage?.items ?? []
    const combined = extraItems.length > 0 ? [...base, ...extraItems] : base
    if (botFilter === 'all') return combined
    return combined.filter(item => item.botId === botFilter)
  }, [botFilter, extraItems, firstPage?.items])

  const nextCursor = extraCursor !== undefined ? extraCursor : (firstPage?.nextCursor ?? null)

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setLoadMoreError(null)
    try {
      const result = await settingsRead<Awaited<ReturnType<typeof listActivity>>>('activity', { filter: activityFilter, cursor: nextCursor })
      if (result.error) {
        setLoadMoreError(t('timelineLoadFailed'))
        return
      }
      setExtraItems(prev => [...prev, ...result.items])
      setExtraCursor(result.nextCursor)
    } catch {
      setLoadMoreError(t('timelineLoadFailed'))
    } finally {
      setLoadingMore(false)
    }
  }

  const number = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const shortDay = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    [locale],
  )
  const dateTimeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    [locale],
  )

  const months = useMemo(
    () =>
      recentMonths(6).map(value => ({
        value,
        label: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(
          new Date(`${value}-01T00:00:00Z`),
        ),
      })),
    [locale],
  )

  const filteredBots = useMemo(() => {
    const bots = usageData?.bots ?? []
    return bots.filter(bot => {
      if (botFilter !== 'all' && bot.id !== botFilter) return false
      if (memberFilter !== 'all' && (bot.ownerId ?? '__unassigned__') !== memberFilter) return false
      return true
    })
  }, [botFilter, memberFilter, usageData?.bots])

  const filteredTotals = useMemo(() => {
    if (!usageData) return { threads: 0, seconds: 0 }
    if (botFilter === 'all' && memberFilter === 'all') return usageData.totals
    return {
      threads: filteredBots.reduce((sum, bot) => sum + bot.threads, 0),
      seconds: filteredBots.reduce((sum, bot) => sum + bot.seconds, 0),
    }
  }, [botFilter, filteredBots, memberFilter, usageData])

  const opsDenied = isSettingsAccessError(opsMetrics.error)
  const opsData = !opsMetrics.error ? opsMetrics.data : undefined

  const chartConfig = useMemo(
    () =>
      ({
        threads: { label: usageT('threads'), color: 'var(--sidebar-primary)' },
      }) satisfies ChartConfig,
    [usageT],
  )

  function formatActivityEvent(item: ActivityItem): string {
    const summary = item.summary
    if (summary.kind === 'credential_use') {
      return t('events.credentialUse', { site: summary.site, result: summary.result })
    }
    if (summary.kind === 'external_action') {
      const targetLabel = summary.repository ?? summary.site ?? summary.action
      return summary.decision === 'declined'
        ? t('events.externalDeclined', { action: targetLabel })
        : t('events.externalApproved', { action: targetLabel })
    }
    return t('events.reminder', { source: summary.source, title: summary.title })
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">{t('subtitle')}</p>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={month} items={months} onValueChange={value => { if (value) setMonth(value) }}>
            <SelectTrigger size="sm" aria-label={t('monthLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {months.map(item => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          <Select
            value={activityFilter}
            onValueChange={value => {
              if (value === 'all' || value === 'accounts' || value === 'reminders') setActivityFilter(value)
            }}
          >
            <SelectTrigger size="sm" aria-label={t('filterKindLabel')}>
              <span>{t(`filters.${activityFilter}`)}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">{t('filters.all')}</SelectItem>
                <SelectItem value="accounts">{t('filters.accounts')}</SelectItem>
                <SelectItem value="reminders">{t('filters.reminders')}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>

          <Select value={botFilter} onValueChange={value => { if (value) setBotFilter(value) }}>
            <SelectTrigger size="sm" aria-label={t('filterBotLabel')}>
              <span>
                {botFilter === 'all'
                  ? t('allBots')
                  : (usageData?.bots.find(bot => bot.id === botFilter)?.name ?? t('allBots'))}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">{t('allBots')}</SelectItem>
                {(usageData?.bots ?? []).map(bot => (
                  <SelectItem key={bot.id} value={bot.id}>
                    {bot.awaitingTakeover ? usageT('awaitingTakeover') : bot.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          {!personal && isWorkspaceScope && (
            <Select value={memberFilter} onValueChange={value => { if (value) setMemberFilter(value) }}>
              <SelectTrigger size="sm" aria-label={t('filterMemberLabel')}>
                <span>
                  {memberFilter === 'all'
                    ? t('allMembers')
                    : (usageData?.members.find(m => (m.id || '__unassigned__') === memberFilter)?.name ??
                      t('allMembers'))}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">{t('allMembers')}</SelectItem>
                  {(usageData?.members ?? []).map(member => {
                    const key = member.id || '__unassigned__'
                    return (
                      <SelectItem key={key} value={key}>
                        {member.awaitingTakeover ? usageT('awaitingTakeover') : member.name}
                      </SelectItem>
                    )
                  })}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <div data-settings-card className="rounded-lg border bg-card p-4">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">{t('kpis.agentHours')}</dt>
            <dd className="text-xl font-semibold tabular-nums">
              {usageData ? duration(filteredTotals.seconds) : '—'}
            </dd>
            <span className="text-xs text-muted-foreground tabular-nums">
              {t('kpis.agentHoursSub', { count: number.format(filteredTotals.threads) })}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">{t('kpis.activeQueues')}</dt>
            <dd className="text-xl font-semibold tabular-nums">
              {opsData
                ? number.format(opsData.queues.runningRuns + opsData.queues.queuedRuns)
                : '—'}
            </dd>
            <span className="text-xs text-muted-foreground tabular-nums">
              {opsData
                ? t('kpis.activeQueuesSub', {
                    running: number.format(opsData.queues.runningRuns),
                    queued: number.format(opsData.queues.queuedRuns),
                  })
                : t('kpis.activeQueuesAdminOnly')}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">{t('kpis.onlineDevices')}</dt>
            <dd className="text-xl font-semibold tabular-nums">
              {opsData
                ? `${number.format(opsData.channels.onlineDevices)} / ${number.format(opsData.channels.boundDevices)}`
                : '—'}
            </dd>
            <span className="text-xs text-muted-foreground tabular-nums">
              {opsData
                ? t('kpis.onlineDevicesSub', {
                    bound: number.format(opsData.channels.boundDevices),
                    bots: number.format(opsData.channels.activeBots),
                  })
                : t('kpis.activeQueuesAdminOnly')}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">{t('kpis.storage')}</dt>
            <dd className="text-xl font-semibold tabular-nums">
              {opsData ? formatBytes(opsData.storage.totalBytes, locale) : '—'}
            </dd>
            <span className="text-xs text-muted-foreground tabular-nums">
              {opsData
                ? t('kpis.storageSub', {
                    artifacts: number.format(opsData.storage.artifacts.count),
                    checkpoints: number.format(opsData.storage.checkpoints.count),
                  })
                : t('kpis.activeQueuesAdminOnly')}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">
              {withPendingSuffix(t('kpis.mergedPrs'), t('pendingTag'))}
            </dt>
            <dd className="text-xl font-semibold text-muted-foreground">—</dd>
            <span className="text-xs text-muted-foreground">{t('pendingTag')}</span>
          </div>

          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">
              {withPendingSuffix(t('kpis.contribution'), t('pendingTag'))}
            </dt>
            <dd className="text-xl font-semibold text-muted-foreground">—</dd>
            <span className="text-xs text-muted-foreground">{t('pendingTag')}</span>
          </div>
        </dl>
      </div>

      {workspaceId && (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 pl-1">
            <h2 className="text-sm font-medium">{t('opsHeading')}</h2>
            {opsData && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {t('opsObservedAt', { time: dateTimeFormatter.format(new Date(opsData.observedAt)) })}
              </span>
            )}
          </div>

          {!admin || opsDenied ? (
            <SettingsSection id="activity-ops-admin">
              <SettingRow title={t('opsHeading')} description={t('opsAdminOnly')} />
            </SettingsSection>
          ) : opsMetrics.error ? (
            <SettingsSaveError
              message={t('opsLoadFailed')}
              retryLabel={commonT('retry')}
              onRetry={() => { void opsMetrics.mutate() }}
            />
          ) : !opsData ? (
            <SettingsLoading label={commonT('loading')} rows={3} />
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <SettingsSection id="activity-ops-channels" title={t('channelsHeading')}>
                <SettingRow title={t('opsRows.devices')}>
                  <span className="tabular-nums">
                    {number.format(opsData.channels.onlineDevices)} / {number.format(opsData.channels.boundDevices)}
                  </span>
                </SettingRow>
                <SettingRow title={t('opsRows.activeBots')}>
                  <span className="tabular-nums">{number.format(opsData.channels.activeBots)}</span>
                </SettingRow>
                <SettingRow title={t('opsRows.slack')}>
                  <span className="tabular-nums">
                    {number.format(opsData.channels.slackInstallations)} / {number.format(opsData.channels.slackBindings)}
                  </span>
                </SettingRow>
                <SettingRow title={t('opsRows.telegram')}>
                  <span className="tabular-nums">{number.format(opsData.channels.telegramBindings)}</span>
                </SettingRow>
              </SettingsSection>

              <SettingsSection id="activity-ops-storage" title={t('storageHeading')}>
                <SettingRow title={t('opsRows.totalStorage')}>
                  <span className="font-medium tabular-nums">{formatBytes(opsData.storage.totalBytes, locale)}</span>
                </SettingRow>
                <SettingRow title={t('opsRows.artifacts')}>
                  <span className="text-muted-foreground tabular-nums">
                    {t('opsRows.artifactsMeta', {
                      count: number.format(opsData.storage.artifacts.count),
                      versions: number.format(opsData.storage.artifacts.versions),
                      size: formatBytes(opsData.storage.artifacts.bytes, locale),
                    })}
                  </span>
                </SettingRow>
                <SettingRow title={t('opsRows.checkpoints')}>
                  <span className="text-muted-foreground tabular-nums">
                    {t('opsRows.checkpointsMeta', {
                      count: number.format(opsData.storage.checkpoints.count),
                      size: formatBytes(opsData.storage.checkpoints.bytes, locale),
                    })}
                  </span>
                </SettingRow>
              </SettingsSection>

              <SettingsSection id="activity-ops-queues" title={t('queuesHeading')}>
                <SettingRow title={t('opsRows.runs')}>
                  <span className="tabular-nums">
                    {number.format(opsData.queues.runningRuns)} / {number.format(opsData.queues.queuedRuns)}
                  </span>
                </SettingRow>
                <SettingRow title={t('opsRows.subagents')}>
                  <span className="tabular-nums">
                    {number.format(opsData.queues.runningSubagents)} / {number.format(opsData.queues.queuedSubagents)}
                  </span>
                </SettingRow>
                <SettingRow title={t('opsRows.publications')}>
                  <span className="tabular-nums">{number.format(opsData.queues.pendingPublications)}</span>
                </SettingRow>
                <SettingRow title={t('opsRows.schedules')}>
                  <span className="tabular-nums">{number.format(opsData.queues.pendingScheduleOccurrences)}</span>
                </SettingRow>
              </SettingsSection>
            </div>
          )}
        </section>
      )}

      {usageData && (
        <div data-settings-card className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <h2 className="text-sm font-medium">{t('dailyThreadsHeading')}</h2>
          <ChartContainer config={chartConfig} className="aspect-auto h-44 w-full" aria-label={t('dailyThreadsChartLabel')}>
            <BarChart data={usageData.daily} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={28}
                allowDecimals={false}
                tickFormatter={value => number.format(Number(value))}
              />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                interval={0}
                ticks={usageData.daily.filter((_, index) => index % 6 === 0).map(item => item.date)}
                tickFormatter={value => shortDay.format(new Date(`${String(value)}T00:00:00Z`))}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={value => shortDay.format(new Date(`${String(value)}T00:00:00Z`))}
                  />
                }
              />
              <Bar dataKey="threads" fill="var(--color-threads)" radius={2} />
            </BarChart>
          </ChartContainer>
        </div>
      )}

      {usageData && filteredBots.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="pl-1 text-sm font-medium">{t('botBreakdownHeading')}</h2>
          <SettingsTable>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">{usageT('bot')}</TableHead>
                  <TableHead className="text-right">{usageT('threads')}</TableHead>
                  <TableHead className="pr-4 text-right">{usageT('runTime')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredBots.map(bot => (
                  <TableRow key={bot.id}>
                    <TableCell className="pl-4">
                      <span className="flex items-center gap-2">
                        <BotAvatar size="row" color={bot.color} shape={bot.shape} />
                        <bdi>{bot.awaitingTakeover ? usageT('awaitingTakeover') : bot.name}</bdi>
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {number.format(bot.threads)}
                    </TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">{duration(bot.seconds)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </SettingsTable>
        </section>
      )}

      <SettingsSection
        id="activity-pending-analytics"
        title={withPendingSuffix(t('pendingAnalyticsHeading'), t('pendingTag'))}
        description={t('pendingAnalyticsNote')}
      >
        {(
          ['contributions', 'mergedPrs', 'feedbackLoops', 'weekdayHours'] as const
        ).map(cardKey => (
          <SettingRow
            key={cardKey}
            title={withPendingSuffix(t(`pendingCards.${cardKey}`), t('pendingTag'))}
          >
            <Badge tone="neutral">{t('pendingTag')}</Badge>
          </SettingRow>
        ))}
      </SettingsSection>

      <section className="flex flex-col gap-2">
        <h2 className="pl-1 text-sm font-medium">{t('timelineHeading')}</h2>
        {timeline.error || timeline.data?.error ? (
          <SettingsSaveError
            message={t('timelineLoadFailed')}
            retryLabel={commonT('retry')}
            onRetry={() => { void timeline.mutate() }}
          />
        ) : !firstPage ? (
          <SettingsLoading label={commonT('loading')} rows={3} />
        ) : (
          <>
            <SettingsTable>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">{t('columns.event')}</TableHead>
                    <TableHead>{t('columns.bot')}</TableHead>
                    <TableHead>{t('columns.actor')}</TableHead>
                    <TableHead className="pr-4 text-right">{t('columns.time')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allTimelineItems.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="pl-4 text-muted-foreground">
                        {t('timelineEmpty')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    allTimelineItems.map(item => (
                      <TableRow key={item.id}>
                        <TableCell className="pl-4">
                          <bdi>{formatActivityEvent(item)}</bdi>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {item.botName ? <bdi>{item.botName}</bdi> : '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {t(`actors.${item.decidedBy ?? 'bot'}`)}
                        </TableCell>
                        <TableCell className="pr-4 text-right text-muted-foreground tabular-nums">
                          {dateTimeFormatter.format(new Date(item.at))}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </SettingsTable>

            {loadMoreError && (
              <SettingsSaveError
                message={loadMoreError}
                retryLabel={commonT('retry')}
                onRetry={() => { void loadMore() }}
              />
            )}

            {nextCursor && (
              <div className="flex justify-end">
                <Button variant="secondary" size="sm" busy={loadingMore} onClick={() => { void loadMore() }}>
                  {t('loadMore')}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}

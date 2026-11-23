'use client'

import { useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { Download } from '@/components/icons'
import { Link } from '@/i18n/navigation'
import { useLocale, useTranslations } from '@/lib/intl/i18n-client'
import { withBasePath } from '@/lib/base-path'
import { csvField } from '@/lib/audit/cursor'
import { billingManagementPath, billingManagementRequest } from '@/lib/billing/management-client'
import { getCreditBilling } from '@/lib/billing/verification-client'
import { creditBillingKey } from '@/components/billing/balance-section'
import { ModelLabel } from '@/components/labels/entity-labels'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { SettingsLoading, SettingsSaveError } from '@/components/settings/primitives'
import { usageRows, useUsageDuration } from '@/components/settings/usage-view'
import type { UsageView } from '@/components/slots/settings-usage-contract'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsTable } from '@/components/ui/settings-layout'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useGovernanceSummary } from '@/hooks/settings/use-workspace-governance'
import { settingsReadOptions } from '@/lib/settings-data'
import { settingsRead } from '@/lib/settings-read'
import { settingsHref } from '@/lib/settings-sections'
import { settingsKeys } from '@/lib/swr/keys'
import { ReadResponseError } from '@/lib/swr/retry'
import { currentMonth, recentMonths } from '@/lib/usage/month'
import type { BotUsageRow, UsageRow as WorkspaceBotMemberRow } from '@/lib/usage/read'
import { useActionError } from '@/lib/use-action-error'
import type { getUsage } from '@/app/actions/usage'

type UsageDimension = 'total' | 'model' | 'member' | 'environment' | 'byok'
type UsagePeriod = 'month' | '24h' | '7d' | '30d'
type UsageSourceFilter = 'all' | 'billed' | 'byok'
type ChartMetric = 'cost' | 'runs'
type RunSort = 'runs' | 'duration'

interface GovernanceHostedRow {
  day: string
  model: string
  memberId: string | null
  repository: string | null
  environmentId: string | null
  environmentName: string | null
  requests: number
  unknownRequests: number
  inputTokens: string
  outputTokens: string
  costMicroUsd: string
  freeMicroUsd: string
  purchasedMicroUsd: string
}

interface GovernanceUsageReport {
  from: string
  toExclusive: string
  currency: 'USD'
  costUnit: 'microUSD'
  groupBy: 'member' | 'repository' | 'environment' | null
  hosted: GovernanceHostedRow[]
  runs: Array<{ status: string; count: number }>
}

const SWR_IDLE_SAFE = {
  ...settingsReadOptions,
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
} as const

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function computeRange(period: UsagePeriod, month: string): { from: string; to: string } {
  const now = new Date()
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  if (period === '24h') {
    const yesterday = new Date(todayUtc)
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    return { from: utcDay(yesterday), to: utcDay(todayUtc) }
  }
  if (period === '7d') {
    const start = new Date(todayUtc)
    start.setUTCDate(start.getUTCDate() - 6)
    return { from: utcDay(start), to: utcDay(todayUtc) }
  }
  if (period === '30d') {
    const start = new Date(todayUtc)
    start.setUTCDate(start.getUTCDate() - 29)
    return { from: utcDay(start), to: utcDay(todayUtc) }
  }
  const [year, monthNumber] = month.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, monthNumber, 0))
  const cappedEnd = lastDay > todayUtc && month === currentMonth(now) ? todayUtc : lastDay
  return { from: `${month}-01`, to: utcDay(cappedEnd) }
}

async function fetchGovernanceUsageReport(
  workspaceId: string,
  range: { from: string; to: string },
  groupBy: 'member' | 'environment' | null,
): Promise<GovernanceUsageReport> {
  const params = new URLSearchParams({ from: range.from, to: range.to })
  if (groupBy) params.set('groupBy', groupBy)
  const response = await fetch(
    withBasePath(`/api/workspaces/${encodeURIComponent(workspaceId)}/governance/usage?${params}`),
    { cache: 'no-store', credentials: 'same-origin' },
  )
  if (!response.ok) throw new ReadResponseError(response.status)
  return response.json() as Promise<GovernanceUsageReport>
}

const MICRO_USD_PER_POINT = 10_000

/**
 * Frame 27 用量 (776px wide): multi-dimension workspace usage & spend breakdown
 * wired to live `/api/settings/usage`, `/api/workspaces/:id/billing`, and
 * `/api/workspaces/:id/governance/usage` (`groupBy=member|environment` + CSV).
 */
export function UsageSettings({
  workspaceId,
  personal = false,
}: {
  workspaceId: string
  /** A personal workspace has one member: no 按成员 grouping in Bot/Member switch. */
  personal?: boolean
}) {
  const t = useTranslations('Settings.usage')
  const tp = useTranslations('Settings.usagePage')
  const commonT = useTranslations('Common')
  const locale = useLocale()
  const actionError = useActionError()
  const duration = useUsageDuration()

  const [dimension, setDimension] = useState<UsageDimension>('total')
  const [period, setPeriod] = useState<UsagePeriod>('month')
  const [sourceFilter, setSourceFilter] = useState<UsageSourceFilter>('all')
  const [month, setMonth] = useState(() => currentMonth())
  const [view, setView] = useState<UsageView>('bots')
  const [chartMetric, setChartMetric] = useState<ChartMetric>('cost')
  const [runSort, setRunSort] = useState<RunSort>('runs')

  const downloadRef = useRef<HTMLAnchorElement>(null)
  const [downloadUrl, setDownloadUrl] = useState<string | undefined>()

  const usage = useSWR(
    settingsKeys.usage(workspaceId, month),
    () => settingsRead<Awaited<ReturnType<typeof getUsage>>>('usage', { month, workspace: workspaceId }),
    { ...SWR_IDLE_SAFE, keepPreviousData: true },
  )
  const data = usage.data && !usage.data.error ? usage.data : null
  const admin = data?.scope === 'workspace'

  const credits = useSWR(
    admin ? creditBillingKey(workspaceId) : null,
    () => getCreditBilling(workspaceId),
    SWR_IDLE_SAFE,
  )
  const billingMgmt = useSWR(
    admin ? billingManagementPath({ kind: 'workspace', id: workspaceId }, null) : null,
    () => billingManagementRequest({ kind: 'workspace', id: workspaceId }, undefined, null),
    SWR_IDLE_SAFE,
  )
  const govSummary = useGovernanceSummary(admin ? workspaceId : undefined)
  const canReadGovUsage = Boolean(admin && govSummary.data?.canEdit && govSummary.data?.usageExport)

  const range = useMemo(() => computeRange(period, month), [period, month])

  const govModelUsage = useSWR(
    canReadGovUsage && sourceFilter !== 'byok'
      ? ['governance-usage-models', workspaceId, range.from, range.to] as const
      : null,
    ([, id, from, to]) => fetchGovernanceUsageReport(id, { from, to }, null),
    { ...SWR_IDLE_SAFE, keepPreviousData: true },
  )

  const govEnvUsage = useSWR(
    canReadGovUsage && sourceFilter !== 'byok' && (dimension === 'total' || dimension === 'environment')
      ? ['governance-usage-environments', workspaceId, range.from, range.to] as const
      : null,
    ([, id, from, to]) => fetchGovernanceUsageReport(id, { from, to }, 'environment'),
    { ...SWR_IDLE_SAFE, keepPreviousData: true },
  )

  const govMemberUsage = useSWR(
    canReadGovUsage && !personal && sourceFilter !== 'byok' && (dimension === 'total' || dimension === 'member')
      ? ['governance-usage-members', workspaceId, range.from, range.to] as const
      : null,
    ([, id, from, to]) => fetchGovernanceUsageReport(id, { from, to }, 'member'),
    { ...SWR_IDLE_SAFE, keepPreviousData: true },
  )

  const number = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const compactNumber = useMemo(
    () => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }),
    [locale],
  )
  const usd = useMemo(
    () => new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }),
    [locale],
  )
  const usdAxis = useMemo(
    () => new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }),
    [locale],
  )
  const shortDay = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    [locale],
  )
  const resetDateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }),
    [locale],
  )

  const months = useMemo(
    () =>
      recentMonths(6).map(value => ({
        value,
        label: tp('monthUtc', {
          month: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(
            new Date(`${value}-01T00:00:00Z`),
          ),
        }),
      })),
    [locale, tp],
  )

  const balancePoints = credits.data && !credits.data.error
    ? credits.data.balancePoints
    : billingMgmt.data?.credits?.balancePoints ?? null

  const csvGroupBy = dimension === 'environment'
    ? 'environment'
    : dimension === 'member' || view === 'members'
      ? 'member'
      : null

  const governanceCsvHref = useMemo(() => {
    if (!canReadGovUsage) return null
    const params = new URLSearchParams({ from: range.from, to: range.to, format: 'csv' })
    if (csvGroupBy) params.set('groupBy', csvGroupBy)
    return withBasePath(`/api/workspaces/${encodeURIComponent(workspaceId)}/governance/usage?${params}`)
  }, [canReadGovUsage, csvGroupBy, range.from, range.to, workspaceId])

  const botMemberRows = useMemo(() => {
    const base = usageRows(data ?? undefined, view)
    return [...base].sort((a, b) =>
      runSort === 'duration'
        ? b.seconds - a.seconds || b.threads - a.threads
        : b.threads - a.threads || b.seconds - a.seconds,
    )
  }, [data, view, runSort])

  const rowName = (row: WorkspaceBotMemberRow | BotUsageRow) =>
    row.awaitingTakeover ? t('awaitingTakeover') : row.name

  function exportLocalCsv() {
    if (!data) return
    const header = [view === 'members' ? t('member') : t('bot'), t('runs'), t('runSeconds')]
    const lines = botMemberRows.map(row =>
      [rowName(row), String(row.threads), String(row.seconds)].map(csvField).join(','),
    )
    const link = downloadRef.current
    if (!link) return
    const url = URL.createObjectURL(
      new Blob([`\uFEFF${[header.map(csvField).join(','), ...lines].join('\r\n')}\r\n`], {
        type: 'text/csv;charset=utf-8',
      }),
    )
    setDownloadUrl(url)
    link.href = url
    link.download = `usage-${data.month}-${view}.csv`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const hasCustomFilters =
    dimension !== 'total' ||
    period !== 'month' ||
    sourceFilter !== 'all' ||
    view !== 'bots' ||
    month !== currentMonth()

  function resetFilters() {
    setDimension('total')
    setPeriod('month')
    setSourceFilter('all')
    setView('bots')
    setMonth(currentMonth())
  }

  const modelRows = useMemo(() => {
    const hosted = govModelUsage.data?.hosted ?? []
    const map = new Map<
      string,
      {
        model: string
        requests: number
        unknownRequests: number
        inputTokens: bigint
        outputTokens: bigint
        costMicroUsd: number
      }
    >()
    for (const row of hosted) {
      const entry = map.get(row.model) ?? {
        model: row.model,
        requests: 0,
        unknownRequests: 0,
        inputTokens: 0n,
        outputTokens: 0n,
        costMicroUsd: 0,
      }
      entry.requests += Number(row.requests)
      entry.unknownRequests += Number(row.unknownRequests)
      entry.inputTokens += BigInt(row.inputTokens || '0')
      entry.outputTokens += BigInt(row.outputTokens || '0')
      entry.costMicroUsd += Number(row.costMicroUsd || '0')
      map.set(row.model, entry)
    }
    return [...map.values()].sort((a, b) => b.costMicroUsd - a.costMicroUsd || b.requests - a.requests)
  }, [govModelUsage.data])

  const environmentRows = useMemo(() => {
    const hosted = govEnvUsage.data?.hosted ?? []
    const map = new Map<
      string,
      {
        key: string
        name: string | null
        requests: number
        unknownRequests: number
        inputTokens: bigint
        outputTokens: bigint
        costMicroUsd: number
      }
    >()
    for (const row of hosted) {
      const key = row.environmentId ?? '__unassigned__'
      const entry = map.get(key) ?? {
        key,
        name: row.environmentName,
        requests: 0,
        unknownRequests: 0,
        inputTokens: 0n,
        outputTokens: 0n,
        costMicroUsd: 0,
      }
      if (!entry.name && row.environmentName) entry.name = row.environmentName
      entry.requests += Number(row.requests)
      entry.unknownRequests += Number(row.unknownRequests)
      entry.inputTokens += BigInt(row.inputTokens || '0')
      entry.outputTokens += BigInt(row.outputTokens || '0')
      entry.costMicroUsd += Number(row.costMicroUsd || '0')
      map.set(key, entry)
    }
    return [...map.values()].sort((a, b) => b.costMicroUsd - a.costMicroUsd || b.requests - a.requests)
  }, [govEnvUsage.data])

  const memberBreakdownRows = useMemo(() => {
    const names = new Map<string, string>()
    for (const member of billingMgmt.data?.members ?? []) names.set(member.id, member.name)
    for (const member of data?.members ?? []) {
      if (member.id) names.set(member.id, member.awaitingTakeover ? t('awaitingTakeover') : member.name)
    }
    const merged = new Map<
      string,
      {
        key: string
        name: string
        threads: number
        seconds: number
        costMicroUsd: number
        unknownCalls: number
      }
    >()
    for (const member of data?.members ?? []) {
      const key = member.id || '__awaiting_takeover__'
      merged.set(key, {
        key,
        name: member.awaitingTakeover ? t('awaitingTakeover') : member.name,
        threads: member.threads,
        seconds: member.seconds,
        costMicroUsd: 0,
        unknownCalls: 0,
      })
    }
    if (govMemberUsage.data) {
      for (const row of govMemberUsage.data.hosted) {
        const key = row.memberId ?? '__unattributed__'
        const entry = merged.get(key) ?? {
          key,
          name: row.memberId ? names.get(row.memberId) ?? row.memberId : tp('unattributedMember'),
          threads: 0,
          seconds: 0,
          costMicroUsd: 0,
          unknownCalls: 0,
        }
        entry.costMicroUsd += Number(row.costMicroUsd || '0')
        entry.unknownCalls += Number(row.unknownRequests || 0)
        merged.set(key, entry)
      }
    } else if (billingMgmt.data?.usage.members) {
      for (const row of billingMgmt.data.usage.members) {
        const key = row.id ?? '__unattributed__'
        const entry = merged.get(key) ?? {
          key,
          name: row.name ?? (row.id ? names.get(row.id) ?? row.id : tp('unattributedMember')),
          threads: 0,
          seconds: 0,
          costMicroUsd: 0,
          unknownCalls: 0,
        }
        entry.costMicroUsd = row.costMicroUsd
        entry.unknownCalls = row.unknownCalls
        merged.set(key, entry)
      }
    }
    return [...merged.values()].sort(
      (a, b) => b.costMicroUsd - a.costMicroUsd || b.threads - a.threads || b.seconds - a.seconds,
    )
  }, [billingMgmt.data, data?.members, govMemberUsage.data, t, tp])

  const quotaRows = useMemo(() => {
    const billing = billingMgmt.data?.billing
    if (!billing) return []
    const rows: Array<{ id: string; source: string; used: string; remaining: string; resets: string }> = []
    const settledPoints = Math.round((billingMgmt.data?.usage.costMicroUsd ?? 0) / MICRO_USD_PER_POINT)
    if (billing.live || billing.planPoints !== null) {
      rows.push({
        id: 'plan',
        source: billing.plan ?? tp('quotaPlan'),
        used: t('points', { points: number.format(settledPoints) }),
        remaining: t('points', { points: number.format(billing.planPoints ?? 0) }),
        resets: billing.currentPeriodEnd ? resetDateFormatter.format(new Date(billing.currentPeriodEnd)) : '—',
      })
    }
    if (billing.purchasedPoints > 0) {
      rows.push({
        id: 'purchased',
        source: tp('quotaPurchased'),
        used: '—',
        remaining: t('points', { points: number.format(billing.purchasedPoints) }),
        resets: tp('neverResets'),
      })
    }
    return rows
  }, [billingMgmt.data, number, resetDateFormatter, t, tp])

  const dailySeries = useMemo(() => {
    const baseDays = (data?.daily ?? []).filter(item => item.date >= range.from && item.date <= range.to)
    const costByDay = new Map<string, { settledUsd: number; reservedUsd: number }>()
    if (billingMgmt.data?.usage.daily && period === 'month') {
      for (const item of billingMgmt.data.usage.daily) {
        costByDay.set(item.date, {
          settledUsd: item.costMicroUsd / 1_000_000,
          reservedUsd: item.reservedMicroUsd / 1_000_000,
        })
      }
    } else if (govModelUsage.data) {
      for (const row of govModelUsage.data.hosted) {
        const dayKey = row.day.slice(0, 10)
        const current = costByDay.get(dayKey) ?? { settledUsd: 0, reservedUsd: 0 }
        current.settledUsd += Number(row.costMicroUsd || '0') / 1_000_000
        costByDay.set(dayKey, current)
      }
    }
    if (baseDays.length > 0) {
      return baseDays.map(item => {
        const spend = costByDay.get(item.date)
        return {
          date: item.date,
          threads: item.threads,
          settledUsd: spend?.settledUsd ?? 0,
          reservedUsd: spend?.reservedUsd ?? 0,
        }
      })
    }
    return [...costByDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, spend]) => ({
        date,
        threads: 0,
        settledUsd: spend.settledUsd,
        reservedUsd: spend.reservedUsd,
      }))
  }, [billingMgmt.data?.usage.daily, data?.daily, govModelUsage.data, period, range.from, range.to])

  const effectiveMetric: ChartMetric =
    chartMetric === 'cost' && (Boolean(billingMgmt.data?.usage.daily) || canReadGovUsage) ? 'cost' : 'runs'

  const chartConfig = useMemo(
    () =>
      ({
        settledUsd: { label: tp('settledLegend'), color: 'var(--sidebar-primary)' },
        reservedUsd: { label: tp('reservedLegend'), color: 'var(--chart-2)' },
        threads: { label: t('threads'), color: 'var(--sidebar-primary)' },
      }) satisfies ChartConfig,
    [t, tp],
  )

  const monthSettledMicroUsd = billingMgmt.data?.usage.costMicroUsd ?? 0
  const executionAccounts = data?.executionAccounts ?? []

  const errorCode =
    usage.data?.error ??
    (usage.error
      ? `usage_read_failed (${
          usage.error instanceof ReadResponseError
            ? `http_${usage.error.status}`
            : usage.error instanceof Error
              ? usage.error.name
              : 'unknown'
        })`
      : null)

  const showBilledSections = sourceFilter !== 'byok' && dimension !== 'byok'
  const showByokSection = sourceFilter !== 'billed' && (dimension === 'total' || dimension === 'byok')

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{tp('subtitle')}</p>
        <Tabs
          value={dimension}
          onValueChange={value => {
            if (
              value === 'total' ||
              value === 'model' ||
              value === 'member' ||
              value === 'environment' ||
              value === 'byok'
            ) {
              setDimension(value)
            }
          }}
        >
          <TabsList variant="line" aria-label={tp('dimensionLabel')}>
            <TabsTrigger value="total">{tp('dimensions.total')}</TabsTrigger>
            <TabsTrigger value="model">{tp('dimensions.model')}</TabsTrigger>
            {!personal && <TabsTrigger value="member">{tp('dimensions.member')}</TabsTrigger>}
            <TabsTrigger value="environment">{tp('dimensions.environment')}</TabsTrigger>
            <TabsTrigger value="byok">{tp('dimensions.byok')}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div
        data-settings-card
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3"
      >
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{tp('summaryCurrentMonth')}</span>
          {admin && billingMgmt.data && (
            <span className="text-muted-foreground tabular-nums">
              · {tp('summarySpend', { settled: usd.format(monthSettledMicroUsd / 1_000_000) })}
            </span>
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          nativeButton={false}
          render={<Link href={settingsHref('billing', workspaceId)} />}
        >
          {tp('manageBilling')}
        </Button>
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-label={tp('periodLabel')}
            variant="segment"
            size="sm"
            spacing={0.5}
            value={[period]}
            onValueChange={values => {
              const next = values[0]
              if (next === 'month' || next === '24h' || next === '7d' || next === '30d') setPeriod(next)
            }}
          >
            <ToggleGroupItem value="month">{tp('periods.month')}</ToggleGroupItem>
            <ToggleGroupItem value="24h">{tp('periods.24h')}</ToggleGroupItem>
            <ToggleGroupItem value="7d">{tp('periods.7d')}</ToggleGroupItem>
            <ToggleGroupItem value="30d">{tp('periods.30d')}</ToggleGroupItem>
          </ToggleGroup>

          <ToggleGroup
            aria-label={tp('sourceLabel')}
            variant="segment"
            size="sm"
            spacing={0.5}
            value={[sourceFilter]}
            onValueChange={values => {
              const next = values[0]
              if (next === 'all' || next === 'billed' || next === 'byok') setSourceFilter(next)
            }}
          >
            <ToggleGroupItem value="all">{tp('sources.all')}</ToggleGroupItem>
            <ToggleGroupItem value="billed">{tp('sources.billed')}</ToggleGroupItem>
            <ToggleGroupItem value="byok">{tp('sources.byok')}</ToggleGroupItem>
          </ToggleGroup>

          {hasCustomFilters && (
            <Button variant="ghost" size="sm" className="ml-auto" onClick={resetFilters}>
              {tp('resetFilters')}
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={month} items={months} onValueChange={value => { if (value) setMonth(value) }}>
            <SelectTrigger size="sm" aria-label={t('month')}>
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

          {admin && !personal && (
            <ToggleGroup
              aria-label={t('groupBy')}
              variant="segment"
              size="sm"
              spacing={0.5}
              value={[view]}
              onValueChange={values => {
                const next = values[0]
                if (next === 'bots' || next === 'members') setView(next)
              }}
            >
              <ToggleGroupItem value="bots">{t('byBot')}</ToggleGroupItem>
              <ToggleGroupItem value="members">{t('byMember')}</ToggleGroupItem>
            </ToggleGroup>
          )}

          {admin && (
            governanceCsvHref ? (
              <Button
                variant="secondary"
                size="sm"
                className="ml-auto"
                nativeButton={false}
                render={<a href={governanceCsvHref} download />}
              >
                <Download data-icon="inline-start" />
                {t('exportCsv')}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                className="ml-auto"
                disabled={!data}
                onClick={exportLocalCsv}
              >
                <Download data-icon="inline-start" />
                {t('exportCsv')}
              </Button>
            )
          )}
        </div>
      </div>

      {!data && !errorCode && <SettingsLoading label={t('loading')} rows={3} />}
      {errorCode && (
        <SettingsSaveError
          message={actionError(usage.data?.error)}
          retryLabel={commonT('retry')}
          onRetry={() => { void usage.mutate() }}
        />
      )}

      {data && (
        <>
          {!admin && <h2 className="pl-1 text-sm font-medium">{t('yours')}</h2>}

          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-0.5 pl-1">
              <dt className="text-xs text-muted-foreground">{t('runs')}</dt>
              <dd className="text-2xl font-semibold tabular-nums">{number.format(data.totals.threads)}</dd>
            </div>
            <div className="flex flex-col gap-0.5 pl-1">
              <dt className="text-xs text-muted-foreground">{t('runTime')}</dt>
              <dd className="text-2xl font-semibold tabular-nums">{duration(data.totals.seconds)}</dd>
            </div>
            <div data-slot="balance" className="flex flex-col gap-0.5 pl-1">
              <dt className="text-xs text-muted-foreground">{t('balance')}</dt>
              <dd className="text-2xl font-semibold tabular-nums">
                {balancePoints !== null ? t('points', { points: number.format(balancePoints) }) : '—'}
              </dd>
            </div>
          </dl>

          <div data-settings-card className="flex flex-col gap-3 rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium">
                {effectiveMetric === 'cost' ? tp('dailySpendHeading') : tp('dailyRunsHeading')}
              </h2>
              <Select
                value={effectiveMetric}
                onValueChange={value => {
                  if (value === 'cost' || value === 'runs') setChartMetric(value)
                }}
              >
                <SelectTrigger size="sm" aria-label={tp('chartMetricLabel')}>
                  <span>{tp(`chartMetrics.${effectiveMetric}`)}</span>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(Boolean(billingMgmt.data?.usage.daily) || canReadGovUsage) && (
                      <SelectItem value="cost">{tp('chartMetrics.cost')}</SelectItem>
                    )}
                    <SelectItem value="runs">{tp('chartMetrics.runs')}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <ChartContainer
              config={chartConfig}
              className="aspect-auto h-48 w-full"
              aria-label={effectiveMetric === 'cost' ? tp('dailySpendHeading') : t('chartLabel')}
            >
              <BarChart data={dailySeries} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
                <CartesianGrid vertical={false} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={42}
                  allowDecimals={effectiveMetric === 'cost'}
                  tickFormatter={value =>
                    effectiveMetric === 'cost' ? usdAxis.format(Number(value)) : number.format(Number(value))
                  }
                />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  interval={0}
                  ticks={dailySeries.filter((_, index) => index % 6 === 0).map(item => item.date)}
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
                {effectiveMetric === 'cost' ? (
                  <>
                    <Bar dataKey="settledUsd" stackId="spend" fill="var(--color-settledUsd)" radius={[0, 0, 2, 2]} />
                    <Bar dataKey="reservedUsd" stackId="spend" fill="var(--color-reservedUsd)" radius={[2, 2, 0, 0]} />
                  </>
                ) : (
                  <Bar dataKey="threads" fill="var(--color-threads)" radius={2} />
                )}
              </BarChart>
            </ChartContainer>

            <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
              {effectiveMetric === 'cost' ? (
                <>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-xs bg-primary" aria-hidden="true" />
                    {tp('settledLegend')}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-xs bg-chart-2" aria-hidden="true" />
                    {tp('reservedLegend')}
                  </span>
                </>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-xs bg-primary" aria-hidden="true" />
                  {t('threads')}
                </span>
              )}
            </div>
          </div>

          {showBilledSections && (dimension === 'total' || dimension === 'model') && (
            <section className="flex flex-col gap-2">
              <h2 className="pl-1 text-sm font-medium">{tp('byModelHeading')}</h2>
              <SettingsTable>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">{tp('columns.model')}</TableHead>
                      <TableHead className="text-right">{tp('columns.cost')}</TableHead>
                      <TableHead className="text-right">{tp('columns.inputTokens')}</TableHead>
                      <TableHead className="text-right">{tp('columns.outputTokens')}</TableHead>
                      <TableHead className="pr-4 text-right">{tp('columns.unknownCalls')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {!admin ? (
                      <TableRow>
                        <TableCell colSpan={5} className="pl-4 text-muted-foreground">
                          {tp('emptyModelsMemberScope')}
                        </TableCell>
                      </TableRow>
                    ) : !canReadGovUsage && govSummary.data ? (
                      <TableRow>
                        <TableCell colSpan={5} className="pl-4 text-muted-foreground">
                          {tp('emptyModelsNoEntitlement')}
                        </TableCell>
                      </TableRow>
                    ) : modelRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="pl-4 text-muted-foreground">
                          {tp('emptyModels')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      modelRows.map(row => (
                        <TableRow key={row.model}>
                          <TableCell className="pl-4 font-medium">
                            <ModelLabel model={row.model} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {usd.format(row.costMicroUsd / 1_000_000)}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground tabular-nums">
                            {compactNumber.format(row.inputTokens)}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground tabular-nums">
                            {compactNumber.format(row.outputTokens)}
                          </TableCell>
                          <TableCell className="pr-4 text-right text-muted-foreground tabular-nums">
                            {number.format(row.unknownRequests)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </SettingsTable>
            </section>
          )}

          {showBilledSections && admin && (dimension === 'total' || dimension === 'model') && (
            <section className="flex flex-col gap-2">
              <h2 className="pl-1 text-sm font-medium">{tp('quotaHeading')}</h2>
              <SettingsTable>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">{tp('columns.source')}</TableHead>
                      <TableHead className="text-right">{tp('columns.used')}</TableHead>
                      <TableHead className="text-right">{tp('columns.remaining')}</TableHead>
                      <TableHead className="pr-4 text-right">{tp('columns.resets')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {quotaRows.length === 0 ? (
                      <TableRow>
                        <TableCell className="pl-4">{tp('quotaFree')}</TableCell>
                        <TableCell className="text-right text-muted-foreground tabular-nums">
                          {t('points', { points: '0' })}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground tabular-nums">
                          {t('points', { points: number.format(balancePoints ?? 0) })}
                        </TableCell>
                        <TableCell className="pr-4 text-right text-muted-foreground">—</TableCell>
                      </TableRow>
                    ) : (
                      quotaRows.map(row => (
                        <TableRow key={row.id}>
                          <TableCell className="pl-4 font-medium">{row.source}</TableCell>
                          <TableCell className="text-right text-muted-foreground tabular-nums">{row.used}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.remaining}</TableCell>
                          <TableCell className="pr-4 text-right text-muted-foreground">{row.resets}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </SettingsTable>
            </section>
          )}

          {showBilledSections && admin && !personal && (dimension === 'total' || dimension === 'member') && (
            <section className="flex flex-col gap-2">
              <h2 className="pl-1 text-sm font-medium">{tp('byMemberHeading')}</h2>
              <SettingsTable>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">{tp('columns.member')}</TableHead>
                      <TableHead className="text-right">{tp('columns.threads')}</TableHead>
                      <TableHead className="text-right">{tp('columns.runTime')}</TableHead>
                      <TableHead className="text-right">{tp('columns.cost')}</TableHead>
                      <TableHead className="pr-4 text-right">{tp('columns.unknownCalls')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {memberBreakdownRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="pl-4 text-muted-foreground">
                          {tp('emptyMembers')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      memberBreakdownRows.map(row => (
                        <TableRow key={row.key}>
                          <TableCell className="pl-4 font-medium">
                            <bdi>{row.name}</bdi>
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground tabular-nums">
                            {number.format(row.threads)}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground tabular-nums">
                            {duration(row.seconds)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {usd.format(row.costMicroUsd / 1_000_000)}
                          </TableCell>
                          <TableCell className="pr-4 text-right text-muted-foreground tabular-nums">
                            {number.format(row.unknownCalls)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </SettingsTable>
            </section>
          )}

          {showBilledSections && (dimension === 'total' || dimension === 'environment') && (
            <section className="flex flex-col gap-2">
              <h2 className="pl-1 text-sm font-medium">{tp('byEnvironmentHeading')}</h2>
              <SettingsTable>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">{tp('columns.environment')}</TableHead>
                      <TableHead className="text-right">{tp('columns.requests')}</TableHead>
                      <TableHead className="text-right">{tp('columns.inputTokens')}</TableHead>
                      <TableHead className="text-right">{tp('columns.outputTokens')}</TableHead>
                      <TableHead className="text-right">{tp('columns.cost')}</TableHead>
                      <TableHead className="pr-4 text-right">{tp('columns.unknownCalls')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {!admin ? (
                      <TableRow>
                        <TableCell colSpan={6} className="pl-4 text-muted-foreground">
                          {tp('emptyModelsMemberScope')}
                        </TableCell>
                      </TableRow>
                    ) : !canReadGovUsage && govSummary.data ? (
                      <TableRow>
                        <TableCell colSpan={6} className="pl-4 text-muted-foreground">
                          {tp('emptyEnvironmentsNoEntitlement')}
                        </TableCell>
                      </TableRow>
                    ) : environmentRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="pl-4 text-muted-foreground">
                          {tp('emptyEnvironments')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      environmentRows.map(row => (
                        <TableRow key={row.key}>
                          <TableCell className="pl-4 font-medium">
                            <bdi>{row.name ?? tp('unassignedEnvironment')}</bdi>
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground tabular-nums">
                            {number.format(row.requests)}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground tabular-nums">
                            {compactNumber.format(row.inputTokens)}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground tabular-nums">
                            {compactNumber.format(row.outputTokens)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {usd.format(row.costMicroUsd / 1_000_000)}
                          </TableCell>
                          <TableCell className="pr-4 text-right text-muted-foreground tabular-nums">
                            {number.format(row.unknownRequests)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </SettingsTable>
            </section>
          )}

          {dimension === 'total' && (
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 pl-1">
                <h2 className="text-sm font-medium">{tp('runBreakdownHeading')}</h2>
                <Select
                  value={runSort}
                  onValueChange={value => {
                    if (value === 'runs' || value === 'duration') setRunSort(value)
                  }}
                >
                  <SelectTrigger size="sm" aria-label={tp('sortLabel')}>
                    <span>{tp(`sorts.${runSort}`)}</span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="runs">{tp('sorts.runs')}</SelectItem>
                      <SelectItem value="duration">{tp('sorts.duration')}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <SettingsTable>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">
                        {admin ? (view === 'members' ? t('member') : t('bot')) : t('yourBots')}
                      </TableHead>
                      <TableHead className="text-right">{t('runs')}</TableHead>
                      <TableHead className="pr-4 text-right">{t('runTime')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {botMemberRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="pl-4 text-muted-foreground">
                          {tp('emptyRuns')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      botMemberRows.map(row => (
                        <TableRow key={row.id || 'awaiting-takeover'}>
                          <TableCell className="pl-4">
                            <span className="flex items-center gap-2">
                              {'color' in row && <BotAvatar size="row" color={row.color} shape={row.shape} />}
                              <bdi>{rowName(row)}</bdi>
                            </span>
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground tabular-nums">
                            {number.format(row.threads)}
                          </TableCell>
                          <TableCell className="pr-4 text-right tabular-nums">{duration(row.seconds)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </SettingsTable>
            </section>
          )}

          {showByokSection && (
            <section className="flex flex-col gap-2">
              <h2 className="pl-1 text-sm font-medium">{tp('historyHeading')}</h2>
              <SettingsTable>
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-1/3 whitespace-normal pl-4">{t('accountKind')}</TableHead>
                      <TableHead className="w-1/3 whitespace-normal">{t('accountPayer')}</TableHead>
                      <TableHead className="pr-4 text-right">{t('accountBilling')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {executionAccounts.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="pl-4 text-muted-foreground">
                          {tp('emptyByok')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      executionAccounts.map(account => (
                        <TableRow key={account.id}>
                          <TableCell className="wrap-break-word whitespace-normal pl-4 font-medium">
                            {t(`accountKinds.${account.kind}`)}
                          </TableCell>
                          <TableCell className="wrap-break-word whitespace-normal">
                            <bdi>{account.ownerName}</bdi>
                          </TableCell>
                          <TableCell className="wrap-break-word whitespace-normal pr-4 text-right text-muted-foreground">
                            {t(`accountAmounts.${account.amount}`)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </SettingsTable>
            </section>
          )}
        </>
      )}

      <a ref={downloadRef} href={downloadUrl} download="usage.csv" className="hidden" tabIndex={-1} aria-hidden="true">
        {t('exportCsv')}
      </a>
    </div>
  )
}

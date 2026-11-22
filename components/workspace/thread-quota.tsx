'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { ChevronRight } from '@/components/icons'
import { resumeQuotaPausedRunOnApiKey, retryQuotaPausedRun } from '@/app/actions/agents'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Kbd } from '@/components/ui/kbd'
import { HarnessLabel, ModelLabel } from '@/components/labels/entity-labels'
import { Link } from '@/i18n/navigation'
import { settingsHref } from '@/lib/settings-sections'
import type { ThreadQuotaView } from '@/lib/run-quota-view'
import type { ModelFallbackChoice, ThreadModelFallbackView } from '@/lib/run-model-fallback-view'
import { useAgentCopy } from '@/hooks/use-agent-copy'
import { subscriptionName, useKeyName, useResetTime } from '@/components/coordinator/quota-notice'

function FallbackModel({ choice }: { choice: ModelFallbackChoice }) {
  return <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
    <HarnessLabel harness={choice.harness} /><span aria-hidden="true">·</span>
    <ModelLabel model={choice.model} source={choice.source === 'subscription' ? choice.harness === 'codex' ? 'codex' : 'claude' : undefined} />
  </span>
}

/** A provider failure ends one run; only its committed continuation names a
 * replacement model. The reason codes are localized, never raw provider text. */
export function ThreadModelFallbackNotice({ item, retry, retrying }: { item: ThreadModelFallbackView; retry?: () => void; retrying?: boolean }) {
  const t = useTranslations('IssueThreads')
  const blocked = useTranslations('Settings.modelOrder.blocked')
  const copy = useAgentCopy()
  const reason = (code: string) => ({
    balance: copy.needsModelBalance, providerUnavailable: copy.needsModelProviderUnavailable,
    keyRefused: copy.needsModelKeyRefused, expired: blocked('expired'), quota: blocked('quota'),
    paused: blocked('paused'), missing: blocked('missing'), removed: blocked('removed'), modelGone: blocked('modelGone'), checking: blocked('checking'),
    noDevice: copy.needsModelNoPlace, cloudNotConfigured: copy.needsModelCloud,
    cloudModelsUnknown: copy.needsModelCloudModelsUnknown, cloudModelNotReported: copy.needsModelCloudModelNotReported,
    alreadyTried: copy.needsModelAlreadyTried,
  } as Record<string, string>)[code] ?? blocked('missing')
  const cause = item.failure === 'balance' ? 'balance' : item.failure === 'auth'
    ? item.from.source === 'api_key' ? 'keyRefused' : 'expired' : 'providerUnavailable'
  if (item.state === 'switched') return <div data-thread-model-switch role="status" className="mx-auto flex max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-center text-xs text-muted-foreground">
    <FallbackModel choice={item.from} /><span>{reason(cause)}</span><span aria-hidden="true">→</span>
    <span>{t('modelSwitched')}</span><FallbackModel choice={item.to} />
  </div>
  const reasons = item.reasons?.filter(entry => entry.reason !== 'taskChanged')
  const entries = reasons?.length ? reasons : [{ choice: item.from, reason: cause }]
  const options = [...new Map((item.card?.options ?? []).map(option => [option.action, option])).values()]
  if (!options.some(option => option.action === 'modelSettings')) options.push({ value: 'models', label: copy.needsModelSettings, action: 'modelSettings' })
  return <div data-thread-model-blocked role="group" aria-label={copy.needsModelTitle} className="flex w-full max-w-sm min-w-0 flex-col gap-2">
    <p className="font-medium">{copy.needsModelTitle}</p>
    {item.state === 'picked' && <p className="text-sm text-muted-foreground">{copy.needsModelPinned}</p>}
    <ul className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground">
      {entries.map((entry, index) => <li key={index} className="flex min-w-0 flex-col gap-1">
        <FallbackModel choice={entry.choice} /><span>{reason(entry.reason)}</span>
      </li>)}
    </ul>
    <div className="flex flex-col gap-1.5">
      {options.map((option, index) => <Item key={option.action} size="sm" variant="muted" render={<Link href={settingsHref(option.action === 'connectServer' ? 'computers' : 'models')} />}>
        <ItemMedia><Kbd>{String.fromCharCode(65 + index)}</Kbd></ItemMedia>
        <ItemContent><ItemTitle>{option.action === 'modelSettings' ? copy.needsModelSettings : option.action === 'e2bKey' ? copy.needsMachineE2B : copy.needsMachineConnect}</ItemTitle></ItemContent>
        <ItemActions><ChevronRight aria-hidden="true" /></ItemActions>
      </Item>)}
    </div>
    {retry && <Button size="sm" variant="outline" className="self-start" disabled={retrying} onClick={retry}>{t('retry')}</Button>}
  </div>
}

/** In an open thread: a run that went on on the person's API key when its subscription ran out. */
export function ThreadQuotaSwitchLine({ switched }: { switched: ThreadQuotaView['switched'][number] }) {
  const t = useTranslations('Coordinator.quota')
  const keyName = useKeyName()
  return <p data-thread-quota-switch className="mx-auto max-w-full text-center text-xs text-muted-foreground wrap-break-word">
    {t('switched', { name: subscriptionName(switched.subscription, switched.plan), key: keyName(switched.key.provider, switched.key.name) })}
  </p>
}

/**
 * A thread whose run paused because its subscription hit its usage limit, above the composer (Figma `1318:2`
 * section 20, #2926): 「已暂停 · 用量上限 · 订阅名」, until when, and the ways on that exist for this thread: 立即重试
 * with the original credential once the limit resets, 用 API Key 继续 once the person has a key (添加 API Key 继续
 * takes them to add one), and 查看用量. Capy's 全部重试, 全部改用 Mikka 额度 and 稍后 act on every paused thread;
 * Mikka has no such write (#2938), so they are not offered.
 */
export function ThreadQuotaPausedCard({ paused, onContinued }: { paused: NonNullable<ThreadQuotaView['paused']>; onContinued: () => unknown }) {
  const t = useTranslations('Coordinator.quota')
  const card = useTranslations('ThreadUnderComposer.paused')
  const resetTime = useResetTime()
  const [pending, setPending] = useState<'key' | 'retry' | null>(null)
  const [failed, setFailed] = useState(false)
  const [reset, setReset] = useState(() => !paused.resetsAt || Date.parse(paused.resetsAt) <= Date.now())
  useEffect(() => {
    if (!paused.resetsAt) { setReset(true); return }
    const wait = Date.parse(paused.resetsAt) - Date.now()
    setReset(wait <= 0)
    if (wait <= 0) return
    const timer = setTimeout(() => setReset(true), Math.min(wait, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [paused.resetsAt])
  async function run(kind: 'key' | 'retry') {
    if (pending) return
    setPending(kind); setFailed(false)
    try { await (kind === 'key' ? resumeQuotaPausedRunOnApiKey(paused.runId) : retryQuotaPausedRun(paused.runId)); await onContinued() }
    catch { setFailed(true) }
    finally { setPending(null) }
  }
  const name = subscriptionName(paused.subscription, paused.plan)
  const detail = paused.resetsAt && !reset ? card('until', { name, time: resetTime(paused.resetsAt) }) : reset ? card('reset', { name }) : card('paused', { name })
  return <section data-thread-quota-paused role="status" aria-label={card('label')} className="flex min-w-0 flex-col gap-2 rounded-xl border border-rule bg-card px-3 py-2.5">
    <div className="flex min-w-0 items-center gap-2">
      <Badge tone="warning" size="sm">{card('badge')}</Badge>
      <span className="min-w-0 truncate text-xs text-muted-foreground">{card('kind', { name })}</span>
    </div>
    <p className="text-sm">{detail}</p>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" disabled={!reset || pending !== null} onClick={() => void run('retry')}>{card('tryNow')}</Button>
      {paused.keyReady
        ? <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void run('key')}>{t('useKey')}</Button>
        : <Button size="sm" variant="outline" nativeButton={false} role="link" render={<Link href={settingsHref('models')} />}>{t('addKey')}</Button>}
      <Button size="sm" variant="ghost" nativeButton={false} role="link" render={<Link href={settingsHref('usage')} />}>{card('seeUsage')}</Button>
    </div>
    {failed && <FieldError className="text-xs">{t('continueFailed')}</FieldError>}
  </section>
}

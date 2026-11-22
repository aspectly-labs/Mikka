'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { Link } from '@/i18n/navigation'
import { useLocale, useTranslations } from '@/lib/intl/i18n-client'
import { BillingPage } from '@ui-slot/settings-billing'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useGatedFeature } from '@/hooks/use-feature-availability'
import { useBillingManagement } from '@/hooks/settings/use-billing-management'
import { withBasePath } from '@/lib/base-path'
import { autoRechargeInputSchema } from '@/lib/billing/auto-recharge-schema'
import type { WorkspaceBillingSettingsView } from '@/lib/billing/contract'
import { BillingManagementError } from '@/lib/billing/management-client'
import type { BillingScope } from '@/lib/billing/management-contract'
import { fetchSettingsData, isSettingsAccessError, settingsReadOptions } from '@/lib/settings-data'
import { settingsHref } from '@/lib/settings-sections'
import { useActionError } from '@/lib/use-action-error'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from './primitives'

const SWR_IDLE_SAFE = {
  ...settingsReadOptions,
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
} as const

const RECHARGE_TIERS = [1000, 2500, 5000] as const
type RechargeTier = (typeof RECHARGE_TIERS)[number]

function parseWholeNumber(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isSafeInteger(value) ? value : null
}

/**
 * V15 / Frame 26 & 38 计费: plan & quota progress bar, points balance + top-up,
 * workspace summary, WS-G (#3123) Auto-Recharge & Stripe Portal receipt policy,
 * and billing activity / refund history.
 */
export function BillingSettings({
  workspaceId,
  personal = false,
  admin = true,
}: {
  workspaceId: string
  personal?: boolean
  admin?: boolean
}) {
  return admin ? (
    <BillingContext key={workspaceId} scope={{ kind: 'workspace', id: workspaceId }} workspaceId={workspaceId} personal={personal} />
  ) : (
    <OrganizationBillingEntry />
  )
}

/** An Organization admin does not need a Workspace admin role to reach finance metadata. */
function OrganizationBillingEntry() {
  const t = useTranslations('Common')
  const actionError = useActionError()
  const read = useSWR(
    '/api/organizations',
    async path => {
      const response = await fetch(withBasePath(path), { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) {
        throw new BillingManagementError(
          [401, 403].includes(response.status) ? 'workspaceAccessDenied' : 'generic',
          response.status,
        )
      }
      return response.json() as Promise<{ organizations: { id: string; role: 'owner' | 'admin' | 'member' }[] }>
    },
    SWR_IDLE_SAFE,
  )
  if (read.error) {
    return (
      <SettingsSaveError
        message={actionError(read.error instanceof BillingManagementError ? read.error.code : 'generic')}
        retryLabel={t('retry')}
        onRetry={() => void read.mutate()}
      />
    )
  }
  if (!read.data) return <SettingsLoading label={t('loading')} rows={1} bare />
  const organization = read.data.organizations.find(row => row.role === 'owner' || row.role === 'admin')
  return organization ? <OrganizationBillingSettings organizationId={organization.id} /> : null
}

/** The same Billing page inside Organization settings; no additional settings system. */
export function OrganizationBillingSettings({ organizationId }: { organizationId: string }) {
  return <BillingContext key={organizationId} scope={{ kind: 'organization', id: organizationId }} />
}

function BillingContext({
  scope,
  workspaceId,
  personal = false,
}: {
  scope: BillingScope
  workspaceId?: string
  personal?: boolean
}) {
  const ta = useTranslations('Settings.billingAutoRecharge')
  const computerBilling = useGatedFeature('computerBilling')
  const management = useBillingManagement(scope)
  const { plan, balance } = management
  const targetWorkspaceId = scope.kind === 'workspace' ? scope.id : management.data?.account?.workspaceId

  return (
    <div className="flex flex-col gap-6">
      {workspaceId && (
        <div className="flex flex-wrap items-center justify-between gap-2 pl-1">
          <span className="text-sm font-medium">{ta('currentPeriod')}</span>
          <Button
            variant="secondary"
            size="sm"
            nativeButton={false}
            render={<Link href={settingsHref('usage', workspaceId)} />}
          >
            {ta('viewUsage')}
          </Button>
        </div>
      )}

      {/* No card verification or free allowance any more (decision 2026-11-15-1900). */}
      <BillingPage
        plan={plan}
        balance={balance}
        allowance={null}
        computerBilling={computerBilling}
        management={management}
      />

      {targetWorkspaceId && plan.plan?.configured && (
        <WorkspaceAutoRechargeCard
          key={targetWorkspaceId}
          workspaceId={targetWorkspaceId}
          personal={personal}
          hasCustomer={Boolean(plan.plan.hasCustomer)}
          portalBusy={plan.pending === 'portal'}
          onOpenPortal={plan.openPortal}
          onSaved={() => { void management.reload() }}
        />
      )}
    </div>
  )
}

function WorkspaceAutoRechargeCard({
  workspaceId,
  hasCustomer,
  portalBusy,
  onOpenPortal,
  onSaved,
}: {
  workspaceId: string
  personal?: boolean
  hasCustomer: boolean
  portalBusy: boolean
  onOpenPortal: () => void
  onSaved: () => void
}) {
  const ta = useTranslations('Settings.billingAutoRecharge')
  const commonT = useTranslations('Common')
  const locale = useLocale()
  const actionError = useActionError()
  const number = new Intl.NumberFormat(locale)

  const settingsRead = useSWR(
    ['workspace-billing-settings', workspaceId] as const,
    ([, id]) =>
      fetchSettingsData<WorkspaceBillingSettingsView>(
        `/api/workspaces/${encodeURIComponent(id)}/billing/settings`,
      ),
    SWR_IDLE_SAFE,
  )

  const data = !settingsRead.error ? settingsRead.data : undefined
  const policy = data?.autoRecharge

  const [threshold, setThreshold] = useState('200')
  const [amount, setAmount] = useState<RechargeTier>(1000)
  const [monthlyCap, setMonthlyCap] = useState('5000')
  const [consent, setConsent] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (!policy) return
    setThreshold(String(policy.thresholdPoints ?? 200))
    const nextAmount = policy.amountPoints
    if (nextAmount === 1000 || nextAmount === 2500 || nextAmount === 5000) setAmount(nextAmount)
    setMonthlyCap(String(policy.monthlyCapPoints ?? Math.max(nextAmount ?? 1000, 5000)))
  }, [policy?.revision, policy?.thresholdPoints, policy?.amountPoints, policy?.monthlyCapPoints])

  if (isSettingsAccessError(settingsRead.error)) return null
  if (settingsRead.error) {
    return (
      <SettingsSection id="billing-auto-recharge" title={ta('sectionHeading')}>
        <SettingsSaveError
          message={ta('loadFailed')}
          retryLabel={commonT('retry')}
          onRetry={() => { void settingsRead.mutate() }}
        />
      </SettingsSection>
    )
  }
  if (!data || !policy) {
    return <SettingsLoading label={commonT('loading')} rows={3} />
  }

  const readOnly = !data.canManageRecharge

  async function savePolicy() {
    if (!policy || saving || readOnly) return
    setSaved(false)
    setSaveError(null)

    const thresholdPoints = parseWholeNumber(threshold)
    const monthlyCapPoints = parseWholeNumber(monthlyCap)
    const candidate = {
      enabled: false as const,
      consent,
      expectedRevision: policy.revision,
      thresholdPoints: thresholdPoints ?? -1,
      amountPoints: amount,
      monthlyCapPoints: monthlyCapPoints ?? -1,
    }
    const parsed = autoRechargeInputSchema.safeParse(candidate)
    if (!parsed.success) {
      setValidationError(ta('validationHint'))
      return
    }
    setValidationError(null)
    setSaving(true)
    try {
      const response = await fetch(
        withBasePath(`/api/workspaces/${encodeURIComponent(workspaceId)}/billing/settings`),
        {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(parsed.data),
        },
      )
      const body = (await response.json().catch(() => null)) as
        | (WorkspaceBillingSettingsView & { error?: { code?: string } | string })
        | null
      if (!response.ok || !body || !('autoRecharge' in body)) {
        const errCode =
          typeof body?.error === 'string'
            ? body.error
            : body?.error && typeof body.error === 'object'
              ? body.error.code
              : undefined
        setSaveError(errCode ? actionError(errCode) : ta('saveFailed'))
        if (response.status === 409) void settingsRead.mutate()
        return
      }
      await settingsRead.mutate(body, { revalidate: false })
      setSaved(true)
      onSaved()
    } catch {
      setSaveError(ta('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsSection id="billing-auto-recharge" title={ta('sectionHeading')}>
      {data.receiptsManagedBy === 'stripe_portal' && (
        <SettingRow title={ta('receiptsRowTitle')} description={ta('receiptsRowDescription')}>
          {hasCustomer ? (
            <Button variant="secondary" size="sm" disabled={portalBusy} onClick={onOpenPortal}>
              {ta('manageInStripePortal')}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">{ta('portalAfterFirstCharge')}</span>
          )}
        </SettingRow>
      )}

      <SettingRow title={ta('toggleRowTitle')} description={ta('toggleRowDescription')}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {policy.state === 'provider_unsupported' && (
            <Badge tone="neutral">{ta('providerUnsupportedBadge')}</Badge>
          )}
          <Switch aria-label={ta('toggleRowTitle')} checked={policy.enabled} disabled />
        </div>
      </SettingRow>

      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`recharge-threshold-${workspaceId}`} className="text-xs text-muted-foreground">
              {ta('thresholdLabel')}
            </Label>
            <Input
              id={`recharge-threshold-${workspaceId}`}
              inputMode="numeric"
              value={threshold}
              disabled={saving || readOnly}
              onChange={event => {
                setThreshold(event.target.value)
                setSaved(false)
                setValidationError(null)
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`recharge-amount-${workspaceId}`} className="text-xs text-muted-foreground">
              {ta('amountLabel')}
            </Label>
            <Select
              value={String(amount)}
              disabled={saving || readOnly}
              onValueChange={value => {
                const numeric = Number(value)
                if (numeric === 1000 || numeric === 2500 || numeric === 5000) {
                  setAmount(numeric)
                  setSaved(false)
                  setValidationError(null)
                }
              }}
            >
              <SelectTrigger id={`recharge-amount-${workspaceId}`} aria-label={ta('amountLabel')} className="w-full">
                <span>{ta('amountOption', { points: number.format(amount) })}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {RECHARGE_TIERS.map(tier => (
                    <SelectItem key={tier} value={String(tier)}>
                      {ta('amountOption', { points: number.format(tier) })}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`recharge-cap-${workspaceId}`} className="text-xs text-muted-foreground">
              {ta('monthlyCapLabel')}
            </Label>
            <Input
              id={`recharge-cap-${workspaceId}`}
              inputMode="numeric"
              value={monthlyCap}
              disabled={saving || readOnly}
              onChange={event => {
                setMonthlyCap(event.target.value)
                setSaved(false)
                setValidationError(null)
              }}
            />
          </div>
        </div>

        <div className="flex items-start gap-2.5 text-xs text-muted-foreground">
          <Checkbox
            id={`recharge-consent-${workspaceId}`}
            checked={consent}
            disabled={saving || readOnly}
            onCheckedChange={checked => {
              setConsent(Boolean(checked))
              setSaved(false)
            }}
          />
          <Label htmlFor={`recharge-consent-${workspaceId}`} className="text-xs leading-relaxed font-normal text-foreground">
            {ta('consentLabel')}
          </Label>
        </div>

        {validationError && <FieldError>{validationError}</FieldError>}
        {saveError && (
          <SettingsSaveError
            message={saveError}
            retryLabel={commonT('retry')}
            onRetry={() => { void savePolicy() }}
          />
        )}

        {readOnly ? (
          <p className="text-xs text-muted-foreground">{ta('readOnlyNote')}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" busy={saving} onClick={() => { void savePolicy() }}>
              {ta('saveButton')}
            </Button>
            {saved && (
              <span role="status" className="text-xs text-muted-foreground">
                {ta('savedStatus')}
              </span>
            )}
          </div>
        )}
      </div>
    </SettingsSection>
  )
}

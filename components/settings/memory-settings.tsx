'use client'

import { useState } from 'react'
import useSWR from 'swr'
import type { SettingsView } from '@mikka/protocol/settings'
import { useLocale, useTranslations } from '@/lib/intl/i18n-client'
import { Pencil, Plus } from '@/components/icons'
import { addFact } from '@/app/actions/memory'
import { updatePreferences } from '@/app/actions/preferences'
import { withBasePath } from '@/lib/base-path'
import { USER_FACT_KINDS, type UserFactKind } from '@/lib/profile/kinds'
import { relativeTime } from '@/lib/relative-time'
import { fetchSettingsData, settingsReadOptions } from '@/lib/settings-data'
import { settingsRead } from '@/lib/settings-read'
import { withPendingSuffix } from '@/lib/settings-sections'
import { settingsKeys } from '@/lib/swr/keys'
import { useMemorySettings, type MemoryFact } from '@/hooks/settings/use-memory-settings'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  SettingRow,
  SettingSelect,
  SettingSwitch,
  SettingsLoading,
  SettingsSaveError,
  SettingsSection,
  settingsSectionAction,
} from '@/components/settings/primitives'

interface MemoryPreferencesDto {
  dailySuggestions?: boolean
  memoryEnabled?: boolean
  error?: string
}

export interface MemorySettingsProps {
  workspaceId?: string
}

function makeRequestId(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * 记忆 (Figma 1508:2 Frame 42): memory & suggestion switches (including live
 * `memoryAutoApprove` via `GET/PATCH /api/settings/personal`), plus the unified
 * pending & remembered facts list with manual fact creation and uniform row actions.
 */
export function MemorySettings({ workspaceId }: MemorySettingsProps = {}) {
  const m = useTranslations('Settings.memory')
  const p = useTranslations('Settings.memoryPage')
  const common = useTranslations('Common')
  const locale = useLocale()

  const { data, error, failed, reload, setEnabled, correct, remove, review } = useMemorySettings()

  const prefsRead = useSWR<MemoryPreferencesDto>(
    settingsKeys.preferences(),
    () => settingsRead<MemoryPreferencesDto>('preferences'),
    settingsReadOptions,
  )

  const personalUrl = workspaceId
    ? `/api/settings/personal?workspaceId=${encodeURIComponent(workspaceId)}`
    : '/api/settings/personal'
  const personalRegistry = useSWR<SettingsView>(
    workspaceId ? [settingsKeys.personalRegistry(), workspaceId] : settingsKeys.personalRegistry(),
    () => fetchSettingsData<SettingsView>(personalUrl),
    settingsReadOptions,
  )

  const [prefsBusy, setPrefsBusy] = useState(false)
  const [autoApproveBusy, setAutoApproveBusy] = useState(false)
  const [settingsFailed, setSettingsFailed] = useState<(() => void) | null>(null)

  const [editing, setEditing] = useState<{ id: string; subject: string } | null>(null)
  const [addingOpen, setAddingOpen] = useState(false)
  const [draftSubject, setDraftSubject] = useState('')
  const [draftKind, setDraftKind] = useState<UserFactKind>('preference')
  const [draftScope, setDraftScope] = useState<string>('global')
  const [draftRequestId, setDraftRequestId] = useState<string>(makeRequestId)
  const [addingBusy, setAddingBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const memoryEnabled = data?.enabled ?? prefsRead.data?.memoryEnabled ?? true
  const dailySuggestions = memoryEnabled && Boolean(prefsRead.data?.dailySuggestions ?? true)
  const rawAutoApprove = personalRegistry.data?.values?.memoryAutoApprove?.value
  const autoApprove = typeof rawAutoApprove === 'boolean' ? rawAutoApprove : Boolean(data?.autoApprove)

  function openAddDialog() {
    setDraftSubject('')
    setDraftKind('preference')
    setDraftScope('global')
    setDraftRequestId(makeRequestId())
    setAddError(null)
    setAddingOpen(true)
  }

  async function saveDailySuggestions(next: boolean) {
    setPrefsBusy(true)
    setSettingsFailed(null)
    try {
      const result = await updatePreferences({ dailySuggestions: next })
      if ('error' in result && result.error) {
        setSettingsFailed(() => () => { void saveDailySuggestions(next) })
        return
      }
      await prefsRead.mutate()
    } catch {
      setSettingsFailed(() => () => { void saveDailySuggestions(next) })
    } finally {
      setPrefsBusy(false)
    }
  }

  async function saveAutoApprove(next: boolean) {
    setAutoApproveBusy(true)
    setSettingsFailed(null)
    try {
      const response = await fetch(withBasePath(personalUrl), {
        method: 'PATCH',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: { memoryAutoApprove: next } }),
      })
      const body = await response.json().catch(() => null) as (SettingsView & { error?: string }) | null
      if (!response.ok || !body || body.error) {
        setSettingsFailed(() => () => { void saveAutoApprove(next) })
        return
      }
      await personalRegistry.mutate(body, { revalidate: false })
    } catch {
      setSettingsFailed(() => () => { void saveAutoApprove(next) })
    } finally {
      setAutoApproveBusy(false)
    }
  }

  async function toggleMemoryEnabled(next: boolean) {
    await setEnabled(next)
    await prefsRead.mutate()
  }

  async function commitEdit() {
    if (!editing) return
    const { id, subject } = editing
    setEditing(null)
    await correct(id, subject)
  }

  async function submitNewFact() {
    const trimmed = draftSubject.trim()
    if (!trimmed) return
    setAddingBusy(true)
    setAddError(null)
    try {
      const scope = draftScope === 'global'
        ? { kind: 'global' as const, ids: [] as [] }
        : { kind: 'workspaces' as const, ids: [draftScope] }
      const createdId = await addFact({
        requestId: draftRequestId,
        kind: draftKind,
        subject: trimmed,
        scope,
      })
      if (createdId === null) {
        setAddError(p('duplicateError'))
        setDraftRequestId(makeRequestId())
        return
      }
      await reload()
      setAddingOpen(false)
    } catch {
      setAddError(p('addError'))
    } finally {
      setAddingBusy(false)
    }
  }

  function factScopeText(fact: MemoryFact): string {
    if (fact.scope.kind === 'workspaces') return p('scopeWorkspace')
    if (fact.scope.kind === 'projects') return p('scopeProject')
    return p('scopePersonal')
  }

  function pendingMeta(fact: MemoryFact): string {
    const parts = [p('statusPending'), m(`kinds.${fact.kind}`)]
    if (fact.createdAt) parts.push(relativeTime(fact.createdAt, locale))
    if (fact.source?.kind === 'thread') parts.push(p('fromThread'))
    if (fact.repository) parts.push(m('scopedTo', { repository: fact.repository }))
    return parts.join(' · ')
  }

  function approvedMeta(fact: MemoryFact): string {
    const parts = [p('statusRemembered'), factScopeText(fact), m(`kinds.${fact.kind}`)]
    if (fact.repository) parts.push(m('scopedTo', { repository: fact.repository }))
    return parts.join(' · ')
  }

  const workspaceChoices = data?.scopeOptions.workspaces ?? []
  const scopeOptions = [
    { value: 'global', label: p('scopePersonal') },
    ...workspaceChoices.map(ws => ({ value: ws.id, label: `${p('scopeWorkspace')} · ${ws.name}` })),
  ]
  const kindOptions = USER_FACT_KINDS.map(kind => ({ value: kind, label: m(`kinds.${kind}`) }))

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection id="memory-settings" title={p('sectionTitle')}>
        <SettingRow title={p('manageFacts')} description={p('manageFactsHint')}>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={p('addFact')} onClick={openAddDialog}>
            <Pencil />
          </Button>
        </SettingRow>
        <SettingRow title={p('dailySuggestions')} description={p('dailySuggestionsHint')}>
          <SettingSelect
            label={p('dailySuggestions')}
            value={dailySuggestions ? 'on' : 'off'}
            disabled={!memoryEnabled || prefsBusy}
            options={[
              { value: 'on', label: p('on') },
              { value: 'off', label: p('off') },
            ]}
            onValueChange={value => {
              if (value === 'on' || value === 'off') void saveDailySuggestions(value === 'on')
            }}
          />
        </SettingRow>
        <SettingRow
          title={withPendingSuffix(p('shareToWorkspace'), p('pendingBadge'))}
          description={p('shareToWorkspaceHint')}
        >
          <span className="text-xs text-muted-foreground">{p('pendingBadge')}</span>
        </SettingRow>
        <SettingRow title={p('autoApprove')} description={p('autoApproveHint')}>
          <SettingSwitch
            label={p('autoApprove')}
            checked={autoApprove}
            disabled={autoApproveBusy || (!personalRegistry.data && personalRegistry.isLoading)}
            onCheckedChange={checked => { void saveAutoApprove(checked) }}
          />
        </SettingRow>
        <SettingRow title={p('contextInjection')} description={p('contextInjectionHint')}>
          <SettingSwitch
            label={p('contextInjection')}
            checked={memoryEnabled}
            disabled={!data}
            onCheckedChange={enabled => { void toggleMemoryEnabled(enabled) }}
          />
        </SettingRow>
      </SettingsSection>

      {(error || failed) && (
        <SettingsSaveError message={m('error')} retryLabel={common('retry')} onRetry={() => { void reload() }} />
      )}
      {settingsFailed && (
        <SettingsSaveError message={p('settingsError')} retryLabel={common('retry')} onRetry={settingsFailed} />
      )}

      {!data && !error ? (
        <SettingsLoading label={p('factsSectionTitle')} rows={3} />
      ) : data ? (
        <SettingsSection
          id="memory-facts"
          title={p('factsSectionTitle')}
          action={
            <Button {...settingsSectionAction} onClick={openAddDialog}>
              <Plus data-icon="inline-start" />
              {p('addFact')}
            </Button>
          }
        >
          {data.pending.length === 0 && data.facts.length === 0 && (
            <p className="px-4 py-4 text-sm text-muted-foreground">{m('empty')}</p>
          )}

          {data.pending.map(fact => (
            <SettingRow key={fact.id} title={fact.subject} description={pendingMeta(fact)}>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button type="button" variant="secondary" size="sm" onClick={() => { void review(fact.id, 'approve') }}>
                  {p('accept')}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => { void review(fact.id, 'reject') }}>
                  {p('ignore')}
                </Button>
              </div>
            </SettingRow>
          ))}

          {data.facts.map(fact =>
            editing?.id === fact.id ? (
              <div key={fact.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                <Input
                  autoFocus
                  aria-label={m('correct')}
                  className="min-w-0 flex-1"
                  value={editing.subject}
                  maxLength={200}
                  onChange={event => setEditing({ id: fact.id, subject: event.target.value })}
                  onKeyDown={event => {
                    if (event.key === 'Enter') void commitEdit()
                    if (event.key === 'Escape') setEditing(null)
                  }}
                />
                <Button type="button" onClick={() => { void commitEdit() }}>
                  {common('save')}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                  {common('cancel')}
                </Button>
              </div>
            ) : (
              <SettingRow key={fact.id} title={fact.subject} description={approvedMeta(fact)}>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={p('editFactNamed', { subject: fact.subject })}
                    onClick={() => setEditing({ id: fact.id, subject: fact.subject })}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={p('deleteFactNamed', { subject: fact.subject })}
                    onClick={() => { void remove(fact.id) }}
                  >
                    {m('delete')}
                  </Button>
                </div>
              </SettingRow>
            ),
          )}
        </SettingsSection>
      ) : null}

      <Dialog open={addingOpen} onOpenChange={open => { if (!open && !addingBusy) setAddingOpen(false) }}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{p('addFact')}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={event => {
              event.preventDefault()
              void submitNewFact()
            }}
            className="flex flex-col gap-4"
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="memory-fact-subject">{p('factSubjectLabel')}</FieldLabel>
                <Input
                  id="memory-fact-subject"
                  required
                  maxLength={200}
                  disabled={addingBusy}
                  placeholder={p('factSubjectPlaceholder')}
                  value={draftSubject}
                  onChange={event => {
                    setDraftSubject(event.target.value)
                    setDraftRequestId(makeRequestId())
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="memory-fact-kind">{p('factKindLabel')}</FieldLabel>
                <Select
                  items={kindOptions}
                  value={draftKind}
                  disabled={addingBusy}
                  onValueChange={value => {
                    if (value && (USER_FACT_KINDS as readonly string[]).includes(value)) {
                      setDraftKind(value as UserFactKind)
                      setDraftRequestId(makeRequestId())
                    }
                  }}
                >
                  <SelectTrigger id="memory-fact-kind"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {kindOptions.map(option => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {scopeOptions.length > 1 && (
                <Field>
                  <FieldLabel htmlFor="memory-fact-scope">{p('factScopeLabel')}</FieldLabel>
                  <Select
                    items={scopeOptions}
                    value={draftScope}
                    disabled={addingBusy}
                    onValueChange={value => {
                      if (value) {
                        setDraftScope(value)
                        setDraftRequestId(makeRequestId())
                      }
                    }}
                  >
                    <SelectTrigger id="memory-fact-scope"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {scopeOptions.map(option => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </FieldGroup>
            {addError ? <FieldError>{addError}</FieldError> : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={addingBusy} onClick={() => setAddingOpen(false)}>
                {common('cancel')}
              </Button>
              <Button type="submit" busy={addingBusy} disabled={!draftSubject.trim()}>
                {common('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

'use client'

import { useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Bot, Building2, ChevronRight, Folder, User } from '@/components/icons'
import type { EnvironmentsView } from '@/app/actions/environments'
import { listBotsForWorkspace, type BotView } from '@/app/actions/bots'
import { updatePreferences } from '@/app/actions/preferences'
import type { ActionResult } from '@/lib/action-result'
import { withBasePath } from '@/lib/base-path'
import { fetchSettingsData, settingsReadOptions } from '@/lib/settings-data'
import { settingsRead } from '@/lib/settings-read'
import { withPendingSuffix } from '@/lib/settings-sections'
import { settingsKeys } from '@/lib/swr/keys'
import { useActionError } from '@/lib/use-action-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { SettingRow, SettingSelect, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'

const INSTRUCTIONS_MAX = 2000

type PreviewLevel = 'workspace' | 'environment' | 'bot' | 'personal' | 'memory'

interface InstructionPreviewLayerDto {
  level: PreviewLevel
  source: PreviewLevel
  sourceId: string | null
  content: string
  charCount: number
}

interface InstructionContextPreviewDto {
  workspaceId: string
  environmentId: string | null
  botId: string | null
  layers: InstructionPreviewLayerDto[]
  mergedPreview: string
}

interface EnvironmentInstructionsDto {
  workspaceId: string
  environmentId: string
  name: string
  instructions: string
  charCount: number
  maxChars: number
  revision: number
  archived: boolean
  canEdit: boolean
  source: 'environment' | 'default'
}

interface BotInstructionsDto {
  botId: string
  workspaceId: string
  name: string
  instructions: string
  charCount: number
  maxChars: number
  archived: boolean
  canEdit: boolean
  source: 'bot' | 'default'
}

interface PersonalPreferencesDto {
  personalInstructions?: string
  error?: string
}

type EditorTarget =
  | { kind: 'personal'; title: string; scopeBadge: string; instructions: string; canEdit: true }
  | { kind: 'environment'; id: string; revision?: number; title: string; scopeBadge: string; instructions: string; canEdit: boolean }
  | { kind: 'bot'; id: string; title: string; scopeBadge: string; instructions: string; canEdit: boolean }

export interface InstructionsSettingsProps {
  workspaceId?: string
  workspaceName?: string
  personal?: boolean
  admin?: boolean
}

function previewUrl(workspaceId?: string, environmentId?: string, botId?: string): string {
  const params = new URLSearchParams()
  if (workspaceId) params.set('workspaceId', workspaceId)
  if (environmentId) params.set('environmentId', environmentId)
  if (botId) params.set('botId', botId)
  const query = params.toString()
  return `/api/settings/instructions/preview${query ? `?${query}` : ''}`
}

function summarize(text: string, emptyLabel: string, charLabel: (count: number) => string): string {
  const trimmed = text.trim()
  if (!trimmed) return emptyLabel
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const snippet = [...firstLine].length > 64 ? `${[...firstLine].slice(0, 64).join('')}…` : firstLine
  return `${charLabel([...trimmed].length)} · ${snippet}`
}

function ScopeIconTile({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
      {children}
    </span>
  )
}

/**
 * 指令 (Figma 1508:2 Frame 16): scoped standing instruction files (workspace pending,
 * personal, active environments, and owned Bots) plus live pre-first-message context preview.
 */
export function InstructionsSettings({ workspaceId, workspaceName, admin = false }: InstructionsSettingsProps = {}) {
  const t = useTranslations('Settings.instructionsPage')
  const common = useTranslations('Common')
  const actionError = useActionError()

  const [previewEnvId, setPreviewEnvId] = useState<string>('none')
  const [previewBotId, setPreviewBotId] = useState<string>('none')
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const prefsRead = useSWR<PersonalPreferencesDto>(
    settingsKeys.preferences(),
    () => settingsRead<PersonalPreferencesDto>('preferences'),
    settingsReadOptions,
  )

  const basePreviewRead = useSWR<InstructionContextPreviewDto>(
    ['settings:instructions-base-preview', workspaceId ?? ''],
    () => fetchSettingsData<InstructionContextPreviewDto>(previewUrl(workspaceId)),
    settingsReadOptions,
  )

  const effectiveWorkspaceId = workspaceId ?? basePreviewRead.data?.workspaceId

  const envsRead = useSWR<ActionResult<EnvironmentsView>>(
    effectiveWorkspaceId ? settingsKeys.environments(effectiveWorkspaceId) : null,
    () => settingsRead('environments', { workspace: effectiveWorkspaceId }),
    settingsReadOptions,
  )
  const activeEnvs = (envsRead.data && !envsRead.data.error ? envsRead.data.environments : []).filter(env => !env.archived)
  const activeEnvKey = activeEnvs.map(env => env.id).join(',')

  const envInstructionsRead = useSWR<EnvironmentInstructionsDto[]>(
    effectiveWorkspaceId && activeEnvs.length > 0 ? ['settings:env-instructions', effectiveWorkspaceId, activeEnvKey] : null,
    () => Promise.all(
      activeEnvs.map(env =>
        fetchSettingsData<EnvironmentInstructionsDto>(
          `/api/workspaces/${encodeURIComponent(effectiveWorkspaceId!)}/environments/${encodeURIComponent(env.id)}/instructions`,
        ),
      ),
    ),
    settingsReadOptions,
  )

  const botsRead = useSWR<BotView[]>(
    effectiveWorkspaceId ? ['settings:instructions-bots', effectiveWorkspaceId] : null,
    () => listBotsForWorkspace(effectiveWorkspaceId!),
    settingsReadOptions,
  )
  const bots = botsRead.data ?? []
  const botsKey = bots.map(bot => bot.id).join(',')

  const botInstructionsRead = useSWR<BotInstructionsDto[]>(
    effectiveWorkspaceId && bots.length > 0 ? ['settings:bot-instructions', effectiveWorkspaceId, botsKey] : null,
    async () => {
      const results = await Promise.all(
        bots.map(bot =>
          fetchSettingsData<BotInstructionsDto>(
            `/api/bots/${encodeURIComponent(bot.id)}/instructions?workspaceId=${encodeURIComponent(effectiveWorkspaceId!)}`,
          ).catch(() => null),
        ),
      )
      return results.filter((item): item is BotInstructionsDto => item !== null)
    },
    settingsReadOptions,
  )

  const resolvedPreviewEnv = previewEnvId !== 'none' && activeEnvs.some(env => env.id === previewEnvId) ? previewEnvId : undefined
  const resolvedPreviewBot = previewBotId !== 'none' && bots.some(bot => bot.id === previewBotId) ? previewBotId : undefined
  const isDefaultPreview = !resolvedPreviewEnv && !resolvedPreviewBot

  const filteredPreviewRead = useSWR<InstructionContextPreviewDto>(
    !isDefaultPreview && effectiveWorkspaceId
      ? ['settings:instructions-preview', effectiveWorkspaceId, resolvedPreviewEnv ?? '', resolvedPreviewBot ?? '']
      : null,
    () => fetchSettingsData<InstructionContextPreviewDto>(previewUrl(effectiveWorkspaceId, resolvedPreviewEnv, resolvedPreviewBot)),
    settingsReadOptions,
  )

  const activePreview = isDefaultPreview ? basePreviewRead : filteredPreviewRead
  const workspaceLayer = basePreviewRead.data?.layers.find(layer => layer.level === 'workspace')
  const personalInstructions = prefsRead.data && !prefsRead.data.error ? prefsRead.data.personalInstructions ?? '' : ''

  const envMap = new Map((envInstructionsRead.data ?? []).map(item => [item.environmentId, item]))
  const botMap = new Map((botInstructionsRead.data ?? []).map(item => [item.botId, item]))

  const initialLoading = prefsRead.isLoading && !prefsRead.data && basePreviewRead.isLoading && !basePreviewRead.data
  const filesError = Boolean((prefsRead.error || prefsRead.data?.error) && !prefsRead.data)

  function openEditor(target: EditorTarget) {
    setSaveError(null)
    setDraft(target.instructions)
    setEditor(target)
  }

  async function refreshPreviews() {
    await Promise.all([
      basePreviewRead.mutate(),
      isDefaultPreview ? Promise.resolve(undefined) : filteredPreviewRead.mutate(),
    ])
  }

  async function saveCurrentEditor() {
    if (!editor || !editor.canEdit) return
    setSaving(true)
    setSaveError(null)
    try {
      if (editor.kind === 'personal') {
        const result = await updatePreferences({ personalInstructions: draft })
        if ('error' in result && result.error) {
          setSaveError(actionError(result.error))
          return
        }
        await prefsRead.mutate()
      } else if (editor.kind === 'environment') {
        if (!effectiveWorkspaceId) return
        const response = await fetch(
          withBasePath(`/api/workspaces/${encodeURIComponent(effectiveWorkspaceId)}/environments/${encodeURIComponent(editor.id)}/instructions`),
          {
            method: 'PATCH',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instructions: draft,
              ...(editor.revision !== undefined ? { revision: editor.revision } : {}),
            }),
          },
        )
        const body = await response.json().catch(() => null) as { error?: string } | null
        if (!response.ok || body?.error) {
          setSaveError(body?.error ? actionError(body.error) : t('saveError'))
          await envInstructionsRead.mutate()
          return
        }
        await envInstructionsRead.mutate()
      } else {
        const response = await fetch(
          withBasePath(`/api/bots/${encodeURIComponent(editor.id)}/instructions`),
          {
            method: 'PATCH',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instructions: draft,
              ...(effectiveWorkspaceId ? { workspaceId: effectiveWorkspaceId } : {}),
            }),
          },
        )
        const body = await response.json().catch(() => null) as { error?: string } | null
        if (!response.ok || body?.error) {
          setSaveError(body?.error ? actionError(body.error) : t('saveError'))
          return
        }
        await botInstructionsRead.mutate()
      }
      await refreshPreviews()
      setEditor(null)
    } catch {
      setSaveError(t('saveError'))
    } finally {
      setSaving(false)
    }
  }

  const envOptions = [
    { value: 'none', label: t('previewEnvNone') },
    ...activeEnvs.map(env => ({ value: env.id, label: env.name })),
  ]
  const botOptions = [
    { value: 'none', label: t('previewBotNone') },
    ...bots.map(bot => ({ value: bot.id, label: bot.name })),
  ]

  return (
    <div className="flex flex-col gap-6">
      <p className="-mt-4 text-xs text-muted-foreground">{t('lead')}</p>

      {initialLoading ? (
        <SettingsLoading label={t('filesTitle')} rows={4} />
      ) : filesError ? (
        <SettingsSaveError
          message={t('loadError')}
          retryLabel={common('retry')}
          onRetry={() => {
            void prefsRead.mutate()
            void basePreviewRead.mutate()
          }}
        />
      ) : (
        <SettingsSection id="instructions-files" title={t('filesTitle')} description={t('filesDescription')}>
          <SettingRow
            icon={<ScopeIconTile><Building2 className="size-4" aria-hidden="true" /></ScopeIconTile>}
            title={workspaceName || t('workspaceFallback')}
            description={workspaceLayer ? summarize(workspaceLayer.content, t('emptyInstructions'), count => t('charSummary', { count })) : t('emptyInstructions')}
          >
            <Badge variant="secondary">{withPendingSuffix(t('scopeWorkspace'), t('pendingBadge'))}</Badge>
          </SettingRow>

          <InstructionFileRow
            icon={<User data-icon aria-hidden="true" />}
            title={t('personalTitle')}
            scopeBadge={t('scopePersonal')}
            summary={summarize(personalInstructions, t('emptyInstructions'), count => t('charSummary', { count }))}
            onOpen={() =>
              openEditor({
                kind: 'personal',
                title: t('personalTitle'),
                scopeBadge: t('scopePersonal'),
                instructions: personalInstructions,
                canEdit: true,
              })
            }
          />

          {activeEnvs.map(env => {
            const view = envMap.get(env.id)
            const text = view?.instructions ?? ''
            const canEditEnv = view ? view.canEdit : admin
            return (
              <InstructionFileRow
                key={env.id}
                icon={<Folder data-icon aria-hidden="true" />}
                title={env.name}
                scopeBadge={canEditEnv ? t('scopeEnvironment') : `${t('scopeEnvironment')} · ${t('readOnlyBadge')}`}
                summary={summarize(text, t('emptyInstructions'), count => t('charSummary', { count }))}
                disabled={envInstructionsRead.isLoading && !view}
                onOpen={() =>
                  openEditor({
                    kind: 'environment',
                    id: env.id,
                    revision: view?.revision,
                    title: env.name,
                    scopeBadge: t('scopeEnvironment'),
                    instructions: text,
                    canEdit: canEditEnv,
                  })
                }
              />
            )
          })}

          {bots.map(bot => {
            const view = botMap.get(bot.id)
            const text = view?.instructions ?? ''
            const canEditBot = view ? view.canEdit : true
            return (
              <InstructionFileRow
                key={bot.id}
                icon={<Bot data-icon aria-hidden="true" />}
                title={bot.name}
                scopeBadge={t('scopeBot')}
                summary={summarize(text, t('emptyInstructions'), count => t('charSummary', { count }))}
                disabled={botInstructionsRead.isLoading && !view}
                onOpen={() =>
                  openEditor({
                    kind: 'bot',
                    id: bot.id,
                    title: bot.name,
                    scopeBadge: t('scopeBot'),
                    instructions: text,
                    canEdit: canEditBot,
                  })
                }
              />
            )
          })}
        </SettingsSection>
      )}

      <section className="flex flex-col gap-2" aria-labelledby="instructions-preview-heading">
        <header className="flex flex-wrap items-center justify-between gap-2 pl-1">
          <h2 id="instructions-preview-heading" className="text-sm font-medium">
            {t('previewTitle')}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {activeEnvs.length > 0 && (
              <SettingSelect
                fluid
                label={t('previewEnvLabel')}
                value={resolvedPreviewEnv ?? 'none'}
                options={envOptions}
                onValueChange={value => setPreviewEnvId(value ?? 'none')}
              />
            )}
            {bots.length > 0 && (
              <SettingSelect
                fluid
                label={t('previewBotLabel')}
                value={resolvedPreviewBot ?? 'none'}
                options={botOptions}
                onValueChange={value => setPreviewBotId(value ?? 'none')}
              />
            )}
          </div>
        </header>

        {activePreview.error && !activePreview.data ? (
          <SettingsSaveError
            message={t('previewLoadError')}
            retryLabel={common('retry')}
            onRetry={() => { void activePreview.mutate() }}
          />
        ) : (
          <div data-settings-card className="overflow-hidden rounded-lg border bg-card">
            {!activePreview.data ? (
              <div role="status" aria-label={common('loading')} className="flex flex-col gap-2.5 px-4 py-4">
                <Skeleton className="h-3.5 w-44" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-36" />
              </div>
            ) : (
              <div className="divide-y divide-border">
                {activePreview.data.layers.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5">
                    {activePreview.data.layers.map(layer => (
                      <Badge key={`${layer.level}:${layer.sourceId ?? ''}`} variant="outline">
                        {t(`layer.${layer.level}`)} · {t('charSummary', { count: layer.charCount })}
                      </Badge>
                    ))}
                  </div>
                )}
                {activePreview.data.mergedPreview.trim() ? (
                  <pre className="max-h-80 overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground">
                    {activePreview.data.mergedPreview}
                  </pre>
                ) : (
                  <p className="px-4 py-4 text-sm text-muted-foreground">{t('previewEmpty')}</p>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <Dialog open={editor !== null} onOpenChange={open => { if (!open && !saving) setEditor(null) }}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>{editor?.title ?? ''}</span>
              {editor ? <Badge variant="secondary">{editor.scopeBadge}</Badge> : null}
            </DialogTitle>
          </DialogHeader>
          <form
            onSubmit={event => {
              event.preventDefault()
              void saveCurrentEditor()
            }}
            className="flex flex-col gap-4"
          >
            <FieldGroup>
              <Field>
                <Textarea
                  aria-label={editor?.title ?? t('filesTitle')}
                  value={draft}
                  maxLength={INSTRUCTIONS_MAX}
                  rows={8}
                  readOnly={!editor?.canEdit}
                  disabled={saving}
                  placeholder={t('editorPlaceholder')}
                  onChange={event => setDraft(event.target.value)}
                />
                <FieldDescription className="text-right">
                  {t('charLimit', { count: [...draft.trim()].length, max: INSTRUCTIONS_MAX })}
                </FieldDescription>
              </Field>
            </FieldGroup>
            {saveError ? <FieldError>{saveError}</FieldError> : null}
            <DialogFooter>
              {editor?.canEdit ? (
                <>
                  <Button type="button" variant="outline" disabled={saving} onClick={() => setEditor(null)}>
                    {common('cancel')}
                  </Button>
                  <Button type="submit" busy={saving}>
                    {common('save')}
                  </Button>
                </>
              ) : (
                <Button type="button" variant="outline" onClick={() => setEditor(null)}>
                  {common('close')}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function InstructionFileRow({
  icon,
  title,
  scopeBadge,
  summary,
  disabled = false,
  onOpen,
}: {
  icon: ReactNode
  title: string
  scopeBadge: string
  summary: string
  disabled?: boolean
  onOpen: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      disabled={disabled}
      onClick={onOpen}
      className="flex h-auto w-full items-center justify-between gap-3 rounded-none px-4 py-3 text-left font-normal whitespace-normal"
    >
      <span className="flex min-w-0 items-center gap-3">
        <ScopeIconTile>{icon}</ScopeIconTile>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm leading-snug font-medium text-foreground">{title}</span>
            <span className="text-xs text-muted-foreground">{scopeBadge}</span>
          </span>
          <span className="truncate text-xs text-muted-foreground">{summary}</span>
        </span>
      </span>
      <ChevronRight data-icon="inline-end" className="shrink-0 text-muted-foreground" aria-hidden="true" />
    </Button>
  )
}

'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Plus } from '@/components/icons'
import { useTranslations } from '@/lib/intl/i18n-client'
import { withBasePath } from '@/lib/base-path'
import { settingsReadOptions } from '@/lib/settings-data'
import { listTeamSkills, reviewTeamSkill, type TeamSkillEntry } from '@/lib/team-skill-client'
import { shareWorkspaceSkill, useAgentProfiles } from './factory-profiles-data'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SearchInput } from '@/components/ui/search-input'
import {
  SettingRow,
  SettingSelect,
  SettingSwitch,
  SettingsLoading,
  SettingsSaveError,
  SettingsSection,
} from '@/components/settings/primitives'

const SKILL_SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/
const SKILL_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/

interface InstalledSkillItem {
  id: string
  name: string
  source: string
  slug: string
  sourceKind: 'skills.sh' | 'built-in' | 'self-improvement'
  sourceRevision: string
  sourcePath: string
  sha256: string
  enabled: boolean
  createdAt: string
}

interface InstalledSkillsResponse {
  skills: InstalledSkillItem[]
  count: number
  scope: 'personal'
}

interface TeamSkillVersionDetail {
  markdown?: string
  status: 'pending' | 'approved' | 'withdrawn'
  artifact: { sha256: string }
}

type SelectedSkill =
  | { kind: 'installed'; id: string }
  | { kind: 'team'; versionId: string }

export interface TeamSkillsSettingsProps {
  admin?: boolean
  workspaceId?: string
  personal?: boolean
}

async function fetchInstalledSkills(): Promise<InstalledSkillsResponse> {
  const response = await fetch(withBasePath('/api/skills'), {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error('skillsLoadFailed')
  return response.json() as Promise<InstalledSkillsResponse>
}

/**
 * 技能 (Figma 1508:2 Frame 17 empty state & Frame 33 populated view + #232 team skills):
 * manages installed skills (`GET/POST/PATCH/DELETE /api/skills` + workspace share via `/api/skills/share`)
 * alongside the workspace team-skill registry (`listTeamSkills`, `reviewTeamSkill`, version detail).
 */
export function TeamSkillsSettings({ admin = false, workspaceId }: TeamSkillsSettingsProps) {
  const t = useTranslations('Settings.teamSkills')
  const s = useTranslations('Settings.skillsPage')
  const common = useTranslations('Common')

  const installedRead = useSWR('settings:installed-skills', fetchInstalledSkills, settingsReadOptions)
  const teamRead = useSWR(
    workspaceId ? ['team-skills', workspaceId, admin] : null,
    ([, id, inspect]: [string, string, boolean]) => listTeamSkills(id, inspect),
    settingsReadOptions,
  )
  const profilesRead = useAgentProfiles(workspaceId, Boolean(workspaceId))

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SelectedSkill | null>(null)
  const [detailModalOpen, setDetailModalOpen] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  const [draftSource, setDraftSource] = useState('')
  const [draftSlug, setDraftSlug] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  const [updatingSkill, setUpdatingSkill] = useState(false)
  const [skillMutationError, setSkillMutationError] = useState<string | null>(null)
  const [removingSkill, setRemovingSkill] = useState<InstalledSkillItem | null>(null)

  const [acting, setActing] = useState<string | null>(null)
  const [actError, setActError] = useState<string | null>(null)
  const [withdrawing, setWithdrawing] = useState<TeamSkillEntry | null>(null)

  const installedSkills = installedRead.data?.skills ?? []
  const teamSkills = teamRead.data ?? []

  const activeSelection: SelectedSkill | null = (() => {
    if (selected?.kind === 'installed' && installedSkills.some(item => item.id === selected.id)) return selected
    if (selected?.kind === 'team' && teamSkills.some(item => item.versionId === selected.versionId)) return selected
    if (installedSkills.length > 0) return { kind: 'installed', id: installedSkills[0].id }
    if (teamSkills.length > 0) return { kind: 'team', versionId: teamSkills[0].versionId }
    return null
  })()

  const selectedInstalled = activeSelection?.kind === 'installed'
    ? installedSkills.find(item => item.id === activeSelection.id) ?? null
    : null
  const selectedTeam = activeSelection?.kind === 'team'
    ? teamSkills.find(item => item.versionId === activeSelection.versionId) ?? null
    : null

  const teamDetailRead = useSWR<TeamSkillVersionDetail>(
    detailModalOpen && selectedTeam && workspaceId
      ? ['team-skill-detail', workspaceId, selectedTeam.versionId, admin]
      : null,
    async () => {
      const response = await fetch(
        withBasePath(`/api/workspaces/${encodeURIComponent(workspaceId!)}/skills?versionId=${encodeURIComponent(selectedTeam!.versionId)}${admin ? '&inspect=1' : ''}`),
        { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000) },
      )
      if (!response.ok) throw new Error('teamSkillDetailFailed')
      return response.json() as Promise<TeamSkillVersionDetail>
    },
    settingsReadOptions,
  )

  function openAddModal() {
    setDraftSource('')
    setDraftSlug('')
    setInstallError(null)
    setAddOpen(true)
  }

  async function installNewSkill() {
    const source = draftSource.trim()
    const slug = draftSlug.trim()
    if (!SKILL_SOURCE_PATTERN.test(source) || !SKILL_SLUG_PATTERN.test(slug)) {
      setInstallError(s('invalidInput'))
      return
    }
    setInstalling(true)
    setInstallError(null)
    try {
      const response = await fetch(withBasePath('/api/skills'), {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, slug }),
      })
      const body = await response.json().catch(() => null) as { skill?: InstalledSkillItem; error?: string } | null
      if (!response.ok || !body?.skill) {
        setInstallError(s('installError'))
        return
      }
      await Promise.all([installedRead.mutate(), profilesRead.mutate()])
      setSelected({ kind: 'installed', id: body.skill.id })
      setAddOpen(false)
    } catch {
      setInstallError(s('installError'))
    } finally {
      setInstalling(false)
    }
  }

  async function toggleInstalledEnabled(skill: InstalledSkillItem, enabled: boolean) {
    setUpdatingSkill(true)
    setSkillMutationError(null)
    try {
      const response = await fetch(withBasePath('/api/skills'), {
        method: 'PATCH',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: skill.id, enabled }),
      })
      if (!response.ok) {
        setSkillMutationError(s('updateError'))
        return
      }
      await Promise.all([installedRead.mutate(), profilesRead.mutate()])
    } catch {
      setSkillMutationError(s('updateError'))
    } finally {
      setUpdatingSkill(false)
    }
  }

  async function changeInstalledScope(skill: InstalledSkillItem, nextScope: 'personal' | 'workspace') {
    if (!workspaceId) return
    setUpdatingSkill(true)
    setSkillMutationError(null)
    try {
      await shareWorkspaceSkill(workspaceId, skill.id, nextScope === 'workspace')
      await profilesRead.mutate()
    } catch {
      setSkillMutationError(s('updateError'))
    } finally {
      setUpdatingSkill(false)
    }
  }

  async function confirmRemoveInstalled(skill: InstalledSkillItem) {
    setUpdatingSkill(true)
    setSkillMutationError(null)
    try {
      const response = await fetch(withBasePath('/api/skills'), {
        method: 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: skill.id }),
      })
      if (!response.ok) {
        setSkillMutationError(s('updateError'))
        return
      }
      setRemovingSkill(null)
      setDetailModalOpen(false)
      await Promise.all([installedRead.mutate(), profilesRead.mutate()])
    } catch {
      setSkillMutationError(s('updateError'))
    } finally {
      setUpdatingSkill(false)
    }
  }

  function actOnTeamSkill(entry: TeamSkillEntry, operation: 'approve' | 'withdraw') {
    if (!workspaceId) return
    setActing(entry.versionId)
    setActError(null)
    void reviewTeamSkill(workspaceId, { versionId: entry.versionId, sha256: entry.artifact.sha256, operation })
      .then(() => {
        setWithdrawing(null)
        return teamRead.mutate()
      })
      .catch(() => setActError(entry.versionId))
      .finally(() => setActing(null))
  }

  const loading = installedRead.isLoading && !installedRead.data && (workspaceId ? teamRead.isLoading && !teamRead.data : true)
  const loadFailed = Boolean(installedRead.error && !installedRead.data) || Boolean(workspaceId && teamRead.error && !teamRead.data)

  const normalizedQuery = query.trim().toLowerCase()
  const filteredInstalled = normalizedQuery
    ? installedSkills.filter(skill =>
        skill.name.toLowerCase().includes(normalizedQuery)
        || skill.source.toLowerCase().includes(normalizedQuery)
        || skill.slug.toLowerCase().includes(normalizedQuery),
      )
    : installedSkills
  const filteredTeam = normalizedQuery
    ? teamSkills.filter(entry =>
        entry.name.toLowerCase().includes(normalizedQuery)
        || entry.description.toLowerCase().includes(normalizedQuery)
        || entry.source.toLowerCase().includes(normalizedQuery),
      )
    : teamSkills

  const totalCount = installedSkills.length + teamSkills.length
  const profileCatalogEntry = selectedInstalled
    ? profilesRead.data?.catalog.skills.find(item => item.id === `personal:${selectedInstalled.id}` || item.id === selectedInstalled.id)
    : undefined
  const canShareSelected = Boolean(workspaceId && profileCatalogEntry?.shareable)
  const isSelectedShared = Boolean(profileCatalogEntry?.shared)

  return (
    <div className="flex flex-col gap-6">
      <p className="-mt-4 text-xs text-muted-foreground">{s('lead')}</p>

      {loading ? (
        <SettingsLoading label={common('loading')} rows={2} />
      ) : loadFailed ? (
        <SettingsSaveError
          message={workspaceId && teamRead.error ? t('loadError') : s('loadError')}
          retryLabel={common('retry')}
          onRetry={() => {
            void installedRead.mutate()
            if (workspaceId) void teamRead.mutate()
          }}
        />
      ) : totalCount === 0 ? (
        <SettingsSection id="skills-empty" title={s('emptySectionTitle')} description={s('emptySectionDescription')}>
          <SettingRow title={s('empty')}>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={s('addSkill')} onClick={openAddModal}>
              <Plus />
            </Button>
          </SettingRow>
        </SettingsSection>
      ) : (
        <>
          <SettingsSection id="skills-installed" title={s('installedTitle')}>
            <SettingRow title={s('searchLabel')}>
              <SearchInput
                className="w-56"
                aria-label={s('searchLabel')}
                placeholder={s('searchPlaceholder')}
                value={query}
                onChange={event => setQuery(event.target.value)}
              />
            </SettingRow>
            <SettingRow title={s('catalogLabel')}>
              <Button type="button" size="sm" onClick={openAddModal}>
                {s('addSkill')}
              </Button>
            </SettingRow>

            {filteredInstalled.length === 0 && filteredTeam.length === 0 && (
              <p className="px-4 py-3 text-sm text-muted-foreground">{s('noMatch')}</p>
            )}

            {filteredInstalled.map(skill => {
              const isCurrent = activeSelection?.kind === 'installed' && activeSelection.id === skill.id
              return (
                <SettingRow
                  key={skill.id}
                  title={skill.name}
                  description={`${skill.source} · ${skill.slug}${!skill.enabled ? ` · ${s('disabledBadge')}` : ''}`}
                >
                  <Button
                    type="button"
                    variant={isCurrent ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={() => {
                      setSelected({ kind: 'installed', id: skill.id })
                      setDetailModalOpen(true)
                    }}
                  >
                    {s('view')}
                  </Button>
                </SettingRow>
              )
            })}

            {filteredTeam.map(entry => {
              const isCurrent = activeSelection?.kind === 'team' && activeSelection.versionId === entry.versionId
              return (
                <SettingRow
                  key={entry.versionId}
                  title={entry.name}
                  description={
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <Badge variant={entry.status === 'approved' ? 'secondary' : entry.status === 'pending' ? 'outline' : 'destructive'}>
                        {t(`status.${entry.status}`)}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {new Date(entry.createdAt).toLocaleDateString()} · {entry.versionId.slice(0, 8)}
                      </span>
                      {entry.description ? <span className="truncate">{entry.description}</span> : null}
                    </span>
                  }
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    {actError === entry.versionId ? <span className="text-xs text-destructive">{t('actError')}</span> : null}
                    {admin && entry.status === 'pending' ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={acting !== null}
                        onClick={() => actOnTeamSkill(entry, 'approve')}
                      >
                        {t('approve')}
                      </Button>
                    ) : null}
                    {admin && entry.status !== 'withdrawn' ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={acting !== null}
                        onClick={() => setWithdrawing(entry)}
                      >
                        {t('withdraw')}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant={isCurrent ? 'secondary' : 'outline'}
                      size="sm"
                      onClick={() => {
                        setSelected({ kind: 'team', versionId: entry.versionId })
                        setDetailModalOpen(true)
                      }}
                    >
                      {s('view')}
                    </Button>
                  </div>
                </SettingRow>
              )
            })}
          </SettingsSection>

          {(selectedInstalled || selectedTeam) && (
            <SettingsSection
              id="skills-detail"
              title={s('detailTitle')}
              description={selectedInstalled ? selectedInstalled.name : selectedTeam?.name}
            >
              {selectedInstalled ? (
                <>
                  <SettingRow title={s('scopeLabel')}>
                    {canShareSelected ? (
                      <SettingSelect
                        label={s('scopeLabel')}
                        value={isSelectedShared ? 'workspace' : 'personal'}
                        disabled={updatingSkill}
                        options={[
                          { value: 'personal', label: s('scopePersonal') },
                          { value: 'workspace', label: s('scopeWorkspace') },
                        ]}
                        onValueChange={value => {
                          if (value === 'personal' || value === 'workspace') {
                            void changeInstalledScope(selectedInstalled, value)
                          }
                        }}
                      />
                    ) : (
                      <span className="text-muted-foreground">
                        {isSelectedShared ? s('scopeWorkspace') : s('scopePersonal')}
                      </span>
                    )}
                  </SettingRow>
                  <SettingRow title={s('enabledLabel')}>
                    <SettingSwitch
                      label={s('enabledLabel')}
                      checked={selectedInstalled.enabled}
                      disabled={updatingSkill}
                      onCheckedChange={enabled => { void toggleInstalledEnabled(selectedInstalled, enabled) }}
                    />
                  </SettingRow>
                  <SettingRow
                    title={s('revisionLabel')}
                    description={`${selectedInstalled.source} · ${selectedInstalled.sourceRevision.slice(0, 12)}`}
                  >
                    <Button type="button" variant="outline" size="sm" onClick={() => setDetailModalOpen(true)}>
                      {s('view')}
                    </Button>
                  </SettingRow>
                </>
              ) : selectedTeam ? (
                <>
                  <SettingRow title={s('scopeLabel')}>
                    <span className="text-muted-foreground">{s('scopeWorkspace')}</span>
                  </SettingRow>
                  <SettingRow
                    title={s('revisionLabel')}
                    description={`${selectedTeam.versionId.slice(0, 8)} · ${selectedTeam.artifact.sha256.slice(0, 12)}`}
                  >
                    <Button type="button" variant="outline" size="sm" onClick={() => setDetailModalOpen(true)}>
                      {s('view')}
                    </Button>
                  </SettingRow>
                </>
              ) : null}
            </SettingsSection>
          )}

          {skillMutationError ? (
            <SettingsSaveError
              message={skillMutationError}
              retryLabel={common('retry')}
              onRetry={() => {
                setSkillMutationError(null)
                void installedRead.mutate()
              }}
            />
          ) : null}
        </>
      )}

      <Dialog open={addOpen} onOpenChange={open => { if (!open && !installing) setAddOpen(false) }}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{s('addSkill')}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={event => {
              event.preventDefault()
              void installNewSkill()
            }}
            className="flex flex-col gap-4"
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="skill-source">{s('sourceLabel')}</FieldLabel>
                <Input
                  id="skill-source"
                  required
                  maxLength={201}
                  disabled={installing}
                  placeholder={s('sourcePlaceholder')}
                  value={draftSource}
                  onChange={event => setDraftSource(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="skill-slug">{s('slugLabel')}</FieldLabel>
                <Input
                  id="skill-slug"
                  required
                  maxLength={100}
                  disabled={installing}
                  placeholder={s('slugPlaceholder')}
                  value={draftSlug}
                  onChange={event => setDraftSlug(event.target.value)}
                />
              </Field>
            </FieldGroup>
            {installError ? <FieldError>{installError}</FieldError> : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={installing} onClick={() => setAddOpen(false)}>
                {common('cancel')}
              </Button>
              <Button type="submit" busy={installing} disabled={!draftSource.trim() || !draftSlug.trim()}>
                {s('addSkill')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={detailModalOpen && Boolean(selectedInstalled || selectedTeam)} onOpenChange={setDetailModalOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{selectedInstalled?.name ?? selectedTeam?.name ?? s('detailTitle')}</DialogTitle>
          </DialogHeader>
          {selectedInstalled ? (
            <div className="flex flex-col gap-3 text-xs">
              <dl className="flex flex-col gap-2 break-all">
                <div>
                  <dt className="font-medium text-muted-foreground">{s('sourceLabel')}</dt>
                  <dd className="font-mono text-foreground">{selectedInstalled.source} · {selectedInstalled.slug}</dd>
                </div>
                <div>
                  <dt className="font-medium text-muted-foreground">{s('pathLabel')}</dt>
                  <dd className="font-mono text-foreground">{selectedInstalled.sourcePath}</dd>
                </div>
                <div>
                  <dt className="font-medium text-muted-foreground">{s('revisionLabel')}</dt>
                  <dd className="font-mono text-foreground">{selectedInstalled.sourceRevision}</dd>
                </div>
                <div>
                  <dt className="font-medium text-muted-foreground">{s('hashLabel')}</dt>
                  <dd className="font-mono text-foreground">{selectedInstalled.sha256}</dd>
                </div>
              </dl>
              <DialogFooter>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={updatingSkill}
                  onClick={() => setRemovingSkill(selectedInstalled)}
                >
                  {s('remove')}
                </Button>
                <Button type="button" variant="outline" onClick={() => setDetailModalOpen(false)}>
                  {common('close')}
                </Button>
              </DialogFooter>
            </div>
          ) : selectedTeam ? (
            <div className="flex flex-col gap-3 text-xs">
              <dl className="flex flex-col gap-2 break-all">
                <div>
                  <dt className="font-medium text-muted-foreground">{s('revisionLabel')}</dt>
                  <dd className="font-mono text-foreground">{selectedTeam.versionId}</dd>
                </div>
                <div>
                  <dt className="font-medium text-muted-foreground">{s('hashLabel')}</dt>
                  <dd className="font-mono text-foreground">{selectedTeam.artifact.sha256}</dd>
                </div>
              </dl>
              {teamDetailRead.data?.markdown ? (
                <pre className="max-h-64 overflow-y-auto rounded-lg border bg-card p-3 font-mono text-xs whitespace-pre-wrap break-words text-foreground">
                  {teamDetailRead.data.markdown}
                </pre>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDetailModalOpen(false)}>
                  {common('close')}
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog open={removingSkill !== null} onOpenChange={open => { if (!open && !updatingSkill) setRemovingSkill(null) }}>
        <AlertDialogContent aria-describedby={undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>{s('removeConfirmTitle', { name: removingSkill?.name ?? '' })}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={updatingSkill}>{common('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={updatingSkill}
              onClick={event => {
                event.preventDefault()
                if (removingSkill) void confirmRemoveInstalled(removingSkill)
              }}
            >
              {s('remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={withdrawing !== null} onOpenChange={open => { if (!open && acting === null) setWithdrawing(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('withdrawTitle', { name: withdrawing?.name ?? '' })}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogDescription>{t('withdrawBody')}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={acting !== null}>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={acting !== null}
              onClick={() => {
                const entry = withdrawing
                if (entry) actOnTeamSkill(entry, 'withdraw')
              }}
            >
              {t('withdraw')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

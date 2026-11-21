'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { useTranslations } from '@/lib/intl/i18n-client'
import { listTeamSkills, reviewTeamSkill, type TeamSkillEntry } from '@/lib/team-skill-client'

/**
 * 团队技能 (#232): the workspace's team-skill registry — what members and bots have submitted for
 * the team to reuse. Members see the approved list; admins also see pending and withdrawn
 * versions (`?inspect=1`) and act on them here: 批准 makes a pending version distributable,
 * 撤回 takes an approved version back out. The POST re-checks admin on the server and binds each
 * review to the artifact's sha256.
 */
export function TeamSkillsSettings({ admin = false, workspaceId }: { admin?: boolean; workspaceId?: string }) {
  const t = useTranslations('Settings.teamSkills')
  const common = useTranslations('Common')
  const { data, error, isLoading, mutate } = useSWR(
    workspaceId ? ['team-skills', workspaceId, admin] : null,
    ([, id, inspect]: [string, string, boolean]) => listTeamSkills(id, inspect),
  )
  const [acting, setActing] = useState<string | null>(null)
  const [actError, setActError] = useState<string | null>(null)
  const [withdrawing, setWithdrawing] = useState<TeamSkillEntry | null>(null)

  const act = (entry: TeamSkillEntry, operation: 'approve' | 'withdraw') => () => {
    setActing(entry.versionId); setActError(null)
    void reviewTeamSkill(workspaceId!, { versionId: entry.versionId, sha256: entry.artifact.sha256, operation })
      .then(() => { setWithdrawing(null); return mutate() })
      .catch(() => setActError(entry.versionId))
      .finally(() => setActing(null))
  }

  if (!workspaceId) return null
  if (isLoading) return <SettingsLoading />
  if (error || !data) return <SettingsSaveError message={t('loadError')} retryLabel={common('retry')} onRetry={() => void mutate()} />
  if (!data.length) return <SettingsSection title={t('title')}>
    <SettingRow title={t('empty')} />
  </SettingsSection>

  return <><SettingsSection title={t('title')}>
    {data.map(entry => <SettingRow key={entry.versionId} title={entry.name}
      description={<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <Badge variant={entry.status === 'approved' ? 'secondary' : entry.status === 'pending' ? 'outline' : 'destructive'}>{t(`status.${entry.status}`)}</Badge>
        <span className="text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleDateString()} · {entry.versionId.slice(0, 8)}</span>
        {entry.description && <span className="truncate">{entry.description}</span>}
      </span>}>
      {admin && <div className="flex items-center gap-2">
        {actError === entry.versionId && <span className="text-xs text-destructive">{t('actError')}</span>}
        {entry.status === 'pending' && <Button variant="secondary" size="sm" disabled={acting !== null}
          onClick={act(entry, 'approve')}>{t('approve')}</Button>}
        {entry.status !== 'withdrawn' && <Button variant="ghost" size="sm" disabled={acting !== null}
          onClick={() => setWithdrawing(entry)}>{t('withdraw')}</Button>}
      </div>}
    </SettingRow>)}
  </SettingsSection>
  <AlertDialog open={withdrawing !== null} onOpenChange={open => { if (!open && acting === null) setWithdrawing(null) }}>
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{t('withdrawTitle', { name: withdrawing?.name ?? '' })}</AlertDialogTitle></AlertDialogHeader>
      <AlertDialogDescription>{t('withdrawBody')}</AlertDialogDescription>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={acting !== null}>{t('cancel')}</AlertDialogCancel>
        <AlertDialogAction disabled={acting !== null} onClick={() => { const entry = withdrawing; if (entry) act(entry, 'withdraw')() }}>{t('withdraw')}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
  </>
}

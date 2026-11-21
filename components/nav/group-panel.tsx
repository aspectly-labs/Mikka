'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { useViewScroll } from '@/lib/hooks/view-state'
import { useTranslations } from '@/lib/intl/i18n-client'
import type { BotView } from '@/app/actions/bots'
import { InlineLoadError } from '@/components/load-error'
import { Skeleton } from '@/components/ui/skeleton'
import { ResizeHandle } from '@/components/ui/resizable-pane'
import { PanelHeader } from '@ui-slot/panel-header'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { usePanelInitialWidth, useWidenToggle } from '@/hooks/use-panel-width'
import { setGroupLead, writeGroupMember, type GroupMember } from '@/lib/group-messages'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { BotAvatar } from './bot-avatar'
import { GroupAvatar, memberAvatar, useGroupMembers } from './group-avatar'
import { GroupHeader } from './group-header'
import { LetterAvatar } from './letter-avatar'

// The same right column as a bot's 概览, so it shares that column's remembered width.
const WIDTH = { storageKey: 'mikka:context-panel-width', min: 320, max: 'half', initial: 360, edge: 'start' } as const

/** A member row: people with their letter, bots with their bloub (R-36), then the name. The owner removes non-owner rows. */
function MemberRow({ member, removeLabel, onRemove }: { member: GroupMember; removeLabel?: string; onRemove?: () => void }) {
  return <li className="group/member flex min-w-0 items-center gap-2 px-2 py-1.5 text-sm">
    {member.memberType === 'bot' ? <BotAvatar {...memberAvatar(member)} size="row" still /> : <LetterAvatar name={member.name} size="row" />}
    <span className="truncate">{member.name}</span>
    {onRemove && <Button variant="ghost" size="icon-xs" aria-label={removeLabel} className="ml-auto text-muted-foreground opacity-0 transition-opacity group-hover/member:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100" onClick={onRemove}><X /></Button>}
  </li>
}

/** The owner's add-member dialog: the workspace's owned Bots that are not in the group yet. */
function AddMembers({ group, bots, members, open, onOpenChange, onAdded }: { group: { id: string; title: string }; bots: readonly BotView[]; members: readonly GroupMember[] | undefined; open: boolean; onOpenChange: (open: boolean) => void; onAdded: () => void }) {
  const t = useTranslations('Shell.panel')
  const [picked, setPicked] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const inside = new Set((members ?? []).map(member => `${member.memberType}:${member.id}`))
  const choices = bots.filter(bot => !inside.has(`bot:${bot.id}`))
  async function submit() {
    if (saving || !picked.length) return
    setSaving(true)
    try {
      for (const memberId of picked) await writeGroupMember(group.id, 'POST', { memberType: 'bot', memberId })
      onOpenChange(false)
      setPicked([])
    } catch { toast.error(t('membersWriteError')) } finally { setSaving(false); onAdded() }
  }
  return <Dialog open={open} onOpenChange={next => { onOpenChange(next); if (!next) setPicked([]) }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{t('addMembers', { group: group.title })}</DialogTitle></DialogHeader>
      {!members ? <p className="py-4 text-sm text-muted-foreground">{t('membersLoading')}</p>
        : choices.length === 0 ? <p className="py-4 text-sm text-muted-foreground">{t('noMoreBots')}</p>
        : <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {choices.map(bot => <li key={bot.id}>
            <Label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm font-normal hover:bg-muted">
              <Checkbox checked={picked.includes(bot.id)} onCheckedChange={checked => setPicked(current => checked === true ? [...current, bot.id] : current.filter(id => id !== bot.id))} />
              <BotAvatar id={bot.id} color={bot.color} shape={bot.shape} size="row" still />
              <span className="truncate">{bot.name}</span>
            </Label>
          </li>)}
        </ul>}
      <DialogFooter>
        <Button variant="outline" onClick={() => { onOpenChange(false); setPicked([]) }}>{t('cancel')}</Button>
        <Button disabled={saving || !picked.length} onClick={() => { void submit() }}>{saving && <Spinner data-icon="inline-start" role="presentation" aria-hidden="true" />}{t('add')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

/**
 * A group chat's right column (R-13): the group's avatar and name, then its
 * members, people and bots. Read-only for members (R-51); the group's owner
 * manages membership here — the API keeps the same checks. No computer: a
 * group has none, a bot's own chat shows its.
 */
export function GroupPanel({ group, userId, bots, onClose, sheet = false }: { group: { id: string; title: string }; userId?: string; bots?: readonly BotView[]; onClose: () => void; sheet?: boolean }) {
  const t = useTranslations('Shell.panel')
  const { data: members, error, mutate } = useGroupMembers(group.id)
  const [adding, setAdding] = useState(false)
  const owner = !!userId && !!members?.some(member => member.memberType === 'user' && member.id === userId && member.role === 'owner')
  const scroll = useViewScroll<HTMLElement>(`group-panel:${group.id}`, !!members)
  const label = members ? t('members', { count: members.length }) : t('membersLoading')
  // A UI layer may size the default from the main area (panel-header slot); a remembered width still wins.
  const resize = useResizableWidth({ ...WIDTH, initial: usePanelInitialWidth(WIDTH.initial) })
  // ⤢ as 概览 has it; only a layer's header offers it, the default keeps 详情 · ✕.
  const widen = useWidenToggle(resize)
  const asideRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => { asideRef.current?.style.setProperty('--group-panel-width', `${resize.width}px`) }, [resize.width])
  const tCommon = useTranslations('Common')
  // Each pending removal keeps the group it happened in: navigating groups must not retarget a restore.
  const undoKey = useRef(0)
  const [undos, setUndos] = useState<{ key: number; groupId: string; member: GroupMember }[]>([])
  const restore = (entry: { key: number; groupId: string; member: GroupMember }) => {
    setUndos(list => list.filter(item => item.key !== entry.key))
    const member = entry.member
    const lead = member.lead ? (member.memberType === 'bot' ? { leadBotId: member.id } : { leadAgentId: member.id }) : null
    void writeGroupMember(entry.groupId, 'POST', { memberType: member.memberType, memberId: member.id })
      .then(() => lead ? setGroupLead(entry.groupId, lead).catch(() => toast.error(t('leadRestoreError', { name: member.name }))) : undefined)
      .then(() => mutate())
      .catch(() => toast.error(t('membersWriteError')))
  }
  const remove = (member: GroupMember) => () => {
    void writeGroupMember(group.id, 'DELETE', { memberType: member.memberType, memberId: member.id })
      .then(() => {
        void mutate()
        const key = ++undoKey.current
        setUndos(list => [...list, { key, groupId: group.id, member }])
        setTimeout(() => setUndos(list => list.filter(item => item.key !== key)), 8000)
      })
      .catch(() => toast.error(t('membersWriteError')))
  }
  // R-37: opening and closing are instant, no motion (decision 2026-11-01-2320).
  return <aside ref={asideRef} aria-label={t('label')}
    className={cn('relative min-h-0 shrink-0 flex-col', sheet ? 'flex size-full' : 'hidden w-(--group-panel-width) overflow-hidden border-l bg-background xl:flex', resize.dragging && 'select-none')}>
    {!sheet && <ResizeHandle resize={resize} label={tCommon('resize.groupPanel')} edge="start" onDoubleClick={widen.reset} />}
    <div className={cn('flex min-h-0 flex-1 flex-col', !sheet && 'min-w-80')}>
      <PanelHeader variant="group" title={t('details')} actions={[]} onClose={onClose} widen={sheet ? undefined : { wide: widen.wide, onToggle: widen.onToggle }} />
      <div className="flex shrink-0 flex-col items-center gap-3 px-4 pt-9 pb-4">
        <GroupAvatar title={group.title} members={members} size="profile" />
        <h2 className="max-w-full truncate text-xl font-semibold">{group.title}</h2>
      </div>
      <section ref={scroll} aria-label={label} className="flex min-h-0 flex-col gap-1 overflow-y-auto px-4 pb-4">
        <GroupHeader action={owner && members ? <Button variant="ghost" size="icon-xs" aria-label={t('addMember')} onClick={() => setAdding(true)}><Plus /></Button> : undefined}>{label}</GroupHeader>
        {undos.length > 0 && <div className="sticky top-0 z-10 mb-1 flex flex-col gap-1 px-2">
          {undos.map(entry => <div key={entry.key} className="flex items-center justify-between gap-2 rounded-lg bg-muted px-2 py-1.5 text-sm shadow-sm">
            <span className="truncate text-muted-foreground">{t('memberRemoved', { name: entry.member.name })}</span>
            <Button variant="secondary" size="xs" onClick={() => restore(entry)}>{t('undo')}</Button>
          </div>)}
        </div>}
        {error ? <div className="px-2 py-1.5"><InlineLoadError message={t('membersError')} retryLabel={t('retry')} onRetry={() => { void mutate() }} /></div>
          : !members ? <div aria-busy="true" className="flex flex-col gap-2 px-2 py-1.5">{[0, 1, 2].map(index => <Skeleton key={index} className="h-5 w-40" />)}</div>
          : <ul className="flex flex-col">{members.map(member => <MemberRow key={`${member.memberType}:${member.id}`} member={member} removeLabel={t('removeMember', { name: member.name })} onRemove={owner && member.role !== 'owner' ? remove(member) : undefined} />)}</ul>}
      </section>
    </div>
    {owner && bots && <AddMembers group={group} bots={bots} members={members} open={adding} onOpenChange={setAdding} onAdded={() => { void mutate() }} />}
  </aside>
}

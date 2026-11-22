'use client'

import { useState } from 'react'
import { z } from 'zod'
import useSWR from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Circle, Ellipsis } from '@/components/icons'
import { getNewTaskOptions } from '@/app/actions/issue-metadata'
import { createWorkspaceIssueState, deleteWorkspaceIssueState, reorderWorkspaceIssueStates, setDefaultWorkspaceIssueState, updateWorkspaceIssueState } from '@/app/actions/issue-states'
import type { ActionResult } from '@/lib/action-result'
import { useActionError } from '@/lib/use-action-error'
import { useIssueStates } from '@/hooks/use-issue-states'
import { ISSUE_STATUS_CODES, type IssueStatus } from '@/lib/issue-meta'
import { ISSUE_STATUS_MARKS, type MarkTone } from '@/lib/state-mark'
import { ISSUE_STATE_COLORS, ISSUE_STATE_ICONS, ISSUE_STATE_NAME_MAX, groupIssueStates, issueStateLabel, issueStateType, type IssueStateIcon, type IssueStateType, type IssueStateView } from '@/lib/issue-states'
import { settingsReadOptions } from '@/lib/settings-data'
import { withPendingSuffix } from '@/lib/settings-sections'
import { cn } from '@/lib/utils'
import { Mark } from '@/components/workspace/state-mark'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingsLoading, SettingsSaveError, SettingsSection, settingsSelectTriggerClass } from './primitives'

type Editing = { state?: IssueStateView; type: IssueStateType; allowAnyCategory?: boolean }

const issueStateFormSchema = z.object({
  name: z.string().trim().min(1).max(ISSUE_STATE_NAME_MAX),
  category: z.enum(ISSUE_STATUS_CODES),
  icon: z.enum(ISSUE_STATE_ICONS),
  color: z.enum(ISSUE_STATE_COLORS),
})

/**
 * 任务状态与标签 (frame 1508:24): the workspace's task states under Open and Closed, in their order,
 * followed by workspace task labels read from visible tasks.
 */
export function IssueStatesSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.issueStates')
  const tp = useTranslations('Settings.polish')
  const common = useTranslations('Common')
  const tIssue = useTranslations('Issue')
  const actionError = useActionError()
  const { states, canEdit, error, mutate } = useIssueStates(workspaceId, { live: true })
  const [editing, setEditing] = useState<Editing | null>(null)
  const [deleting, setDeleting] = useState<IssueStateView | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const label = (state: Pick<IssueStateView, 'name' | 'category'>) => issueStateLabel(state, category => tIssue(`status.${category}`))
  const grouped = groupIssueStates(states ?? [])
  const ordered = [...grouped.open, ...grouped.closed]

  async function run(write: () => Promise<ActionResult<unknown>>): Promise<boolean> {
    setPending(true); setFailure(null)
    try {
      const result = await write()
      if (result.error) { setFailure(actionError(result.error)); return false }
      return true
    } catch { setFailure(actionError()); return false }
    finally { setPending(false); void mutate() }
  }

  function move(state: IssueStateView, offset: -1 | 1) {
    const group = state.type === 'open' ? grouped.open : grouped.closed
    const index = group.indexOf(state), swap = group[index + offset]
    if (!swap) return
    const ids = ordered.map(item => item.id === state.id ? swap.id : item.id === swap.id ? state.id : item.id)
    void run(() => reorderWorkspaceIssueStates({ workspaceId, ids }))
  }

  return <div className="flex flex-col gap-6" data-settings-state={error ? 'error' : states ? 'ready' : 'loading'}>
    <p className="-mt-4 text-xs text-muted-foreground">{tp('issueStatesLead')}</p>
    {!states && !error && <SettingsLoading rows={4} label={common('loading')} />}
    {states && <SettingsSection id="issue-states-all" title={tp('statesHeading')}>
      <div className="flex items-center justify-between gap-2 bg-inset px-4 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{tp('statesCount', { count: ordered.length })}</span>
        {canEdit && <Button type="button" variant="ghost" size="xs" disabled={pending} onClick={() => setEditing({ type: 'open', allowAnyCategory: true })}>{tp('addState')}</Button>}
      </div>
      {ordered.map(state => {
        const group = state.type === 'open' ? grouped.open : grouped.closed
        const groupIndex = group.indexOf(state)
        const displayTitle = state.isDefault ? `${label(state)} · ${t('default')}` : label(state)
        return <div key={state.id} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Mark shape={state.icon} tone={state.color} size="md" />
            <span className="truncate text-sm font-medium text-foreground">{displayTitle}</span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="text-xs text-muted-foreground">{t('tasks', { count: state.taskCount })}</span>
            <Badge variant="outline">{state.type === 'open' ? tp('stateOpenBadge') : t('closed')}</Badge>
            {canEdit && <DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" disabled={pending} aria-label={t('actions', { name: label(state) })} />}><Ellipsis /></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => setEditing({ state, type: state.type })}>{t('look')}</DropdownMenuItem>
                  <DropdownMenuItem disabled={state.isDefault} onClick={() => { void run(() => setDefaultWorkspaceIssueState({ workspaceId, id: state.id })) }}>{t('makeDefault')}</DropdownMenuItem>
                  <DropdownMenuItem disabled={groupIndex === 0} onClick={() => move(state, -1)}>{t('moveUp')}</DropdownMenuItem>
                  <DropdownMenuItem disabled={groupIndex === group.length - 1} onClick={() => move(state, 1)}>{t('moveDown')}</DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem variant="destructive" disabled={state.isDefault} onClick={() => setDeleting(state)}>{t('delete')}</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>}
          </div>
        </div>
      })}
    </SettingsSection>}
    {error && !states && <SettingsSaveError message={actionError(error === 'generic' ? undefined : error)} retryLabel={common('retry')} onRetry={() => { void mutate() }} />}
    {failure && <FieldError>{failure}</FieldError>}
    <WorkspaceLabelsSection workspaceId={workspaceId} />
    {canEdit && editing && <IssueStateEditor key={editing.state?.id ?? `new-${editing.type}`} type={editing.type} allowAnyCategory={editing.allowAnyCategory} state={editing.state} label={label} pending={pending}
      onClose={() => setEditing(null)}
      onSave={async values => {
        const saved = editing.state
          ? await run(() => updateWorkspaceIssueState({ workspaceId, id: editing.state!.id, name: values.name, icon: values.icon, color: values.color }))
          : await run(() => createWorkspaceIssueState({ workspaceId, name: values.name ?? '', category: values.category, icon: values.icon, color: values.color }))
        if (saved) setEditing(null)
      }} />}
    {canEdit && deleting && states && <MoveAndDelete key={deleting.id} state={deleting} states={states} label={label} pending={pending}
      onClose={() => setDeleting(null)}
      onDelete={async moveTo => { if (await run(() => deleteWorkspaceIssueState({ workspaceId, id: deleting.id, moveTo }))) setDeleting(null) }} />}
  </div>
}

function WorkspaceLabelsSection({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.issueStates')
  const tp = useTranslations('Settings.polish')
  const tColors = useTranslations('Metadata.colors')
  const common = useTranslations('Common')
  const actionError = useActionError()
  const options = useSWR(['settings:workspace-labels', workspaceId], () => getNewTaskOptions(workspaceId), settingsReadOptions)
  const labels = options.data?.labels ?? []
  const loading = !options.data && !options.error

  return <SettingsSection id="workspace-labels" title={tp('labelsHeading')} action={<span className="text-xs text-muted-foreground">{withPendingSuffix(tp('addLabel'), tp('pendingBadge'))}</span>}>
    <div className="grid grid-cols-[minmax(0,1fr)_6rem_5rem] items-center gap-3 bg-inset px-4 py-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{tp('labelsCount', { count: labels.length })}</span>
      <span>{t('color')}</span>
      <span>{tp('labelsColumnSource')}</span>
    </div>
    {loading && <SettingsLoading bare rows={2} label={common('loading')} />}
    {options.error && <SettingsSaveError message={actionError()} retryLabel={common('retry')} onRetry={() => { void options.mutate() }} />}
    {!loading && !options.error && labels.length === 0 && <p className="px-4 py-4 text-sm text-muted-foreground">{tp('labelsEmpty')}</p>}
    {!loading && !options.error && labels.map(item => <div key={item.name.toLowerCase()} className="grid grid-cols-[minmax(0,1fr)_6rem_5rem] items-center gap-3 px-4 py-3 text-sm">
      <div className="flex min-w-0 items-center gap-2.5">
        <Circle className={cn('size-2.5 shrink-0 fill-current', {
          'text-label-violet': item.color === 'violet',
          'text-label-blue': item.color === 'blue',
          'text-success-foreground': item.color === 'green',
          'text-warning-foreground': item.color === 'yellow',
          'text-destructive-foreground': item.color === 'red',
          'text-muted-foreground': item.color === 'gray',
        })} />
        <span className="truncate font-medium text-foreground">{item.name}</span>
      </div>
      <span className="text-xs text-muted-foreground">{tColors(item.color)}</span>
      <span className="text-xs text-muted-foreground">{tp('labelsSourceTasks')}</span>
    </div>)}
  </SettingsSection>
}

type EditorValues = { name: string | null; category: IssueStatus; icon: IssueStateIcon; color: MarkTone }

/** New state, or a state's name, icon and color. A state's category is fixed once it exists. */
function IssueStateEditor({ type, allowAnyCategory = false, state, label, pending, onClose, onSave }: {
  type: IssueStateType; allowAnyCategory?: boolean; state?: IssueStateView; label: (state: Pick<IssueStateView, 'name' | 'category'>) => string; pending: boolean
  onClose: () => void; onSave: (values: EditorValues) => Promise<void>
}) {
  const t = useTranslations('Settings.issueStates')
  const tIssue = useTranslations('Issue')
  const categories = allowAnyCategory ? ISSUE_STATUS_CODES : ISSUE_STATUS_CODES.filter(category => issueStateType(category) === type)
  const [name, setName] = useState(state ? label(state) : '')
  const [category, setCategory] = useState<IssueStatus>(state?.category ?? categories[0])
  const [icon, setIcon] = useState<IssueStateIcon>(state?.icon ?? ISSUE_STATUS_MARKS[categories[0]].shape as IssueStateIcon)
  const [color, setColor] = useState<MarkTone>(state?.color ?? ISSUE_STATUS_MARKS[categories[0]].tone)
  const trimmed = name.trim()
  // A built-in state left at its translated name keeps following the language.
  const storedName = state && state.name === null && trimmed === label(state) ? null : trimmed
  const categoryItems = categories.map(value => ({ value, label: tIssue(`status.${value}`) }))

  function handleSubmit() {
    const parsed = issueStateFormSchema.safeParse({ name, category, icon, color })
    if (!parsed.success) return
    void onSave({ name: storedName, category: parsed.data.category, icon: parsed.data.icon, color: parsed.data.color })
  }

  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent aria-describedby={undefined} className="sm:max-w-md">
      <DialogHeader><DialogTitle>{state ? label(state) : allowAnyCategory ? t('new') : t('newIn', { type: t(type) })}</DialogTitle></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); handleSubmit() }}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="issue-state-name">{t('name')}</FieldLabel>
            <div className="flex items-center gap-2">
              <Mark shape={icon} tone={color} size="md" />
              <Input id="issue-state-name" autoFocus maxLength={ISSUE_STATE_NAME_MAX} className="border-border bg-background" value={name} onChange={event => setName(event.target.value)} />
            </div>
            {state && state.name !== null && <Button type="button" variant="link" size="sm" className="self-start px-0" onClick={() => setName(tIssue(`status.${state.category}`))}>{t('resetName')}</Button>}
          </Field>
          {!state && <Field>
            <FieldLabel>{t('category')}</FieldLabel>
            <Select value={category} items={categoryItems} onValueChange={value => {
              if (!value) return
              const next = value as IssueStatus
              setCategory(next); setIcon(ISSUE_STATUS_MARKS[next].shape as IssueStateIcon); setColor(ISSUE_STATUS_MARKS[next].tone)
            }}>
              <SelectTrigger aria-label={t('category')} className={cn(settingsSelectTriggerClass, 'w-full')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{categoryItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Field>}
          <Field>
            <FieldLabel>{t('icon')}</FieldLabel>
            <ToggleGroup aria-label={t('icon')} className="flex-wrap justify-start" value={[icon]} onValueChange={(values: string[]) => { if (values[0]) setIcon(values[0] as IssueStateIcon) }}>
              {ISSUE_STATE_ICONS.map(shape => <ToggleGroupItem key={shape} value={shape} aria-label={shape} size="sm"><Mark shape={shape} tone={color} /></ToggleGroupItem>)}
            </ToggleGroup>
          </Field>
          <Field>
            <FieldLabel>{t('color')}</FieldLabel>
            <ToggleGroup aria-label={t('color')} className="flex-wrap justify-start" value={[color]} onValueChange={(values: string[]) => { if (values[0]) setColor(values[0] as MarkTone) }}>
              {ISSUE_STATE_COLORS.map(tone => <ToggleGroupItem key={tone} value={tone} aria-label={t(`colors.${tone}`)} title={t(`colors.${tone}`)} size="sm"><Mark shape={icon} tone={tone} /></ToggleGroupItem>)}
            </ToggleGroup>
          </Field>
        </FieldGroup>
        <DialogFooter className="mt-6">
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{t('cancel')}</Button>
          <Button type="submit" busy={pending} disabled={pending || !trimmed}>{state ? t('save') : t('create')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

/** Capy's MoveAndDelete: pick where the state's tasks go, then the state is removed. */
function MoveAndDelete({ state, states, label, pending, onClose, onDelete }: {
  state: IssueStateView; states: IssueStateView[]; label: (state: Pick<IssueStateView, 'name' | 'category'>) => string; pending: boolean
  onClose: () => void; onDelete: (moveTo: string) => Promise<void>
}) {
  const t = useTranslations('Settings.issueStates')
  const targets = groupIssueStates(states.filter(item => item.id !== state.id))
  const ordered = [...targets.open, ...targets.closed]
  const [moveTo, setMoveTo] = useState(states.find(item => item.isDefault && item.category === state.category)?.id ?? ordered[0]?.id ?? '')
  const items = ordered.map(item => ({ value: item.id, label: label(item) }))
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent aria-describedby={undefined} className="sm:max-w-md">
      <DialogHeader><DialogTitle>{t('deleteTitle', { name: label(state) })}</DialogTitle></DialogHeader>
      <FieldGroup><Field>
        <FieldLabel>{t('moveTo')}</FieldLabel>
        <Select value={moveTo} items={items} onValueChange={value => { if (value) setMoveTo(value) }}>
          <SelectTrigger aria-label={t('moveTo')} className={cn(settingsSelectTriggerClass, 'w-full')}><SelectValue /></SelectTrigger>
          <SelectContent>
            {([['open', targets.open], ['closed', targets.closed]] as const).map(([type, group]) => group.length > 0 && <SelectGroup key={type}>
              {group.map(item => <SelectItem key={item.id} value={item.id}><Mark shape={item.icon} tone={item.color} />{label(item)}</SelectItem>)}
            </SelectGroup>)}
          </SelectContent>
        </Select>
      </Field></FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{t('cancel')}</Button>
        <Button type="button" variant="destructive" busy={pending} disabled={pending || !moveTo} onClick={() => { void onDelete(moveTo) }}>{t('moveAndDelete')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

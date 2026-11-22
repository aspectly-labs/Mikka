'use client'

import { useEffect, useState } from 'react'
import { z } from 'zod'
import useSWR, { unstable_serialize } from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Archive, Folder, Pencil, Plus } from '@/components/icons'
import type { EnvironmentView, EnvironmentsView } from '@/app/actions/environments'
import { listProjectSetupVersions, rollbackProjectSetup, saveEnvironment, setProjectDefaultEnvironment } from '@/app/actions/project-resources'
import type { EnvironmentConfiguration, ProjectSetupHistory } from '@/lib/project-resources/contracts'
import { isReservedEnvName, SECRET_NAME } from '@/lib/secrets/format'
import type { ActionResult } from '@/lib/action-result'
import { MACHINE_SIZES, isMachineSize, type MachineSize } from '@/lib/cloud-computer/machine-pricing'
import { cn } from '@/lib/utils'
import { settingsRead } from '@/lib/settings-read'
import { settingsKeys } from '@/lib/swr/keys'
import { readAccessFailure } from '@/lib/swr/persistent-cache'
import { settingsReadOptions } from '@/lib/settings-data'
import { useLiveKey } from '@/hooks/use-live-key'
import { useActionError } from '@/lib/use-action-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SearchInput } from '@/components/ui/search-input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SettingsLoading, SettingsSaveError, SettingsSection, SettingRow, settingsSelectTriggerClass } from './primitives'

const envVarKeySchema = z.string().regex(SECRET_NAME).refine(name => !isReservedEnvName(name))
const clientEnvironmentConfiguration = z.object({
  runtime: z.enum(['any', 'local', 'cloud']),
  harness: z.enum(['any', 'claude_code', 'codex', 'cursor']),
  setup: z.object({
    command: z.string().max(16_384).optional(),
    copyFiles: z.array(z.string().max(512)).max(100),
    approved: z.boolean().optional(),
  }).optional(),
  variables: z.record(envVarKeySchema, z.string().max(32_768)),
  secretIds: z.array(z.uuid()).max(100),
  repositoryKeys: z.array(z.string()).max(100),
}).refine(value => Object.keys(value.variables).length <= 100)

const environmentFormSchema = z.object({
  name: z.string().trim().min(1).max(120),
  configuration: clientEnvironmentConfiguration,
})

function formatRepositoryList(repositoryKeys: readonly string[], boundProjects: readonly string[]): string {
  const repos = repositoryKeys.map(key => {
    const parts = key.split('/')
    return parts.length >= 4 ? `${parts[2]}/${parts[3]}` : key
  })
  const items = repos.length > 0 ? repos : boundProjects
  if (items.length === 0) return '—'
  if (items.length <= 2) return items.join('、')
  return `${items.slice(0, 2).join('、')} +${items.length - 2}`
}

function parseVariableLines(raw: string): Record<string, string> | null {
  const variables: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex <= 0) return null
    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1)
    if (Object.hasOwn(variables, key)) return null
    variables[key] = value
  }
  return variables
}

export function EnvironmentsSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.environments')
  const tp = useTranslations('Settings.polish')
  const common = useTranslations('Common')
  const actionError = useActionError()
  const key = settingsKeys.environments(workspaceId)
  const list = useSWR<ActionResult<EnvironmentsView>>(key, () => settingsRead('environments', { workspace: workspaceId }), settingsReadOptions)
  useLiveKey('workspace_settings', workspaceId, [unstable_serialize(key)], workspaceId)
  const data = !list.error && list.data && !list.data.error ? list.data : null
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<{ environment?: EnvironmentView } | null>(null)
  const [historyProject, setHistoryProject] = useState<string | null>(null)
  const [archiving, setArchiving] = useState<EnvironmentView | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const readError = list.error ? actionError() : list.data?.error ? actionError(list.data.error) : null
  const active = data?.environments.filter(environment => !environment.archived) ?? []
  const archived = data?.environments.filter(environment => environment.archived) ?? []
  const needle = query.trim().toLowerCase()
  const filteredActive = needle
    ? active.filter(environment => environment.name.toLowerCase().includes(needle) || environment.configuration.repositoryKeys.some(repo => repo.toLowerCase().includes(needle)))
    : active
  const canManage = data?.canManage === true
  const selectedProject = data?.projects.find(project => project.id === historyProject)
  const selectedEnvironment = active.find(env => env.id === selectedProject?.environmentId)

  useEffect(() => {
    if (!canManage) { setEditing(null); setArchiving(null) }
  }, [canManage])

  function refuse(code: string) {
    if (['authRequired', 'workspaceAccessDenied', 'workspaceMembershipSuspended'].includes(code)) {
      setEditing(null); setArchiving(null)
      void list.mutate(undefined, { revalidate: false })
    }
    setFailure(actionError(code))
  }

  async function archive(environment: EnvironmentView, restore = false) {
    setPending(true); setFailure(null)
    try {
      const result = await saveEnvironment({ workspaceId, id: environment.id, revision: environment.revision,
        name: environment.name, configuration: environment.configuration, archived: !restore })
      if (result.error) refuse(result.error)
      else setArchiving(null)
      await list.mutate()
    } catch (error) {
      const access = readAccessFailure(error)
      if (access) refuse(access === 'session' ? 'authRequired' : 'workspaceAccessDenied')
      else setFailure(actionError())
    }
    finally { setPending(false) }
  }

  async function choose(projectId: string, revision: number, environmentId: string) {
    setPending(true); setFailure(null)
    try {
      const result = await setProjectDefaultEnvironment({ workspaceId, projectId, revision, environmentId: environmentId === 'none' ? null : environmentId })
      if (result.error) refuse(result.error)
      await list.mutate()
    } catch (error) {
      const access = readAccessFailure(error)
      if (access) refuse(access === 'session' ? 'authRequired' : 'workspaceAccessDenied')
      else setFailure(actionError())
    }
    finally { setPending(false) }
  }

  return <div className="flex flex-col gap-6" data-settings-state={readError ? 'error' : data ? 'ready' : 'loading'}>
    <p className="-mt-4 text-xs text-muted-foreground">{tp('environmentsLead')}</p>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <SearchInput value={query} placeholder={tp('environmentsSearchPlaceholder')} aria-label={tp('environmentsSearchPlaceholder')} className="h-(--control-sm) w-full sm:w-64" onChange={event => setQuery(event.target.value)} />
      {canManage && <Button type="button" variant="outline" size="sm" onClick={() => setEditing({})}><Plus data-icon="inline-start" />{tp('newEnvironment')}</Button>}
    </div>
    {!data && !readError && <SettingsLoading rows={3} label={common('loading')} />}
    {data && <Table>
      <TableHeader className="[&_tr]:border-0">
        <TableRow className="border-0 hover:bg-transparent">
          <TableHead className="h-9 bg-inset px-3 text-xs font-medium text-muted-foreground first:rounded-l-lg">{active.length > 0 ? `${t('title')} ${active.length}` : t('title')}</TableHead>
          <TableHead className="h-9 bg-inset px-3 text-xs font-medium text-muted-foreground">{tp('envColumnRepos')}</TableHead>
          <TableHead className="h-9 bg-inset px-3 text-xs font-medium text-muted-foreground">{tp('envColumnSetup')}</TableHead>
          <TableHead className="h-9 bg-inset px-3 text-xs font-medium text-muted-foreground">{t('runtime')}</TableHead>
          <TableHead className="h-9 bg-inset px-3 text-xs font-medium text-muted-foreground">{tp('envColumnVersion')}</TableHead>
          <TableHead className="h-9 w-24 bg-inset px-3 text-right text-xs font-medium text-muted-foreground last:rounded-r-lg"><span className="sr-only">{tp('columnActions')}</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="divide-y divide-border">
        {active.length === 0 && <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="px-3 py-6 text-sm text-muted-foreground">{t('empty')}</TableCell>
        </TableRow>}
        {active.length > 0 && filteredActive.length === 0 && <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="px-3 py-6 text-sm text-muted-foreground">{tp('noMatchingEnvironments')}</TableCell>
        </TableRow>}
        {filteredActive.map(environment => {
          const boundProjects = data.projects.filter(project => project.environmentId === environment.id).map(project => project.name)
          const hasSetup = Boolean(environment.configuration.setup?.command || environment.configuration.setup?.copyFiles?.length)
          const setupLabel = !hasSetup ? tp('envSetupDefault') : environment.configuration.setup?.approved ? tp('envSetupApproved') : tp('envSetupPending')
          return <TableRow key={environment.id}>
            <TableCell className="px-3 py-3 font-medium text-foreground">
              <div className="flex items-center gap-2.5">
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{environment.name}</span>
              </div>
            </TableCell>
            <TableCell className="max-w-52 truncate px-3 py-3 text-muted-foreground">{formatRepositoryList(environment.configuration.repositoryKeys, boundProjects)}</TableCell>
            <TableCell className="px-3 py-3 text-muted-foreground">{setupLabel}</TableCell>
            <TableCell className="px-3 py-3 text-muted-foreground">{t(`runtimes.${environment.configuration.runtime}`)}</TableCell>
            <TableCell className="px-3 py-3 text-muted-foreground">{t('version', { revision: environment.revision })}</TableCell>
            <TableCell className="px-3 py-3 text-right">
              {canManage && <div className="inline-flex items-center justify-end gap-1">
                <Button type="button" variant="ghost" size="icon-sm" disabled={pending} aria-label={t('editNamed', { name: environment.name })} onClick={() => setEditing({ environment })}><Pencil /></Button>
                <Button type="button" variant="ghost" size="icon-sm" disabled={pending} aria-label={t('archiveNamed', { name: environment.name })} onClick={() => setArchiving(environment)}><Archive /></Button>
              </div>}
            </TableCell>
          </TableRow>
        })}
      </TableBody>
    </Table>}
    {data && data.projects.length > 0 && <SettingsSection id="environment-defaults" title={t('projectDefaults')}>
      {data.projects.map(project => {
        const items = [{ value: 'none', label: t('none') }, ...active.map(environment => ({ value: environment.id, label: environment.name }))]
        if (project.environmentId && !active.some(environment => environment.id === project.environmentId)) items.push({ value: project.environmentId, label: t('archived') })
        return <SettingRow key={project.id} title={project.name}><div className="flex flex-wrap items-center gap-2">
          {active.some(environment => environment.id === project.environmentId) && <Button type="button" variant="ghost" size="sm"
            aria-label={t('historyFor', { name: project.name })} onClick={() => setHistoryProject(project.id)}>{t('history')}</Button>}
          <Select value={project.environmentId ?? 'none'} items={items}
            disabled={!data.canManage || pending} onValueChange={value => { if (value) void choose(project.id, project.revision, value) }}>
            <SelectTrigger size="sm" className={cn(settingsSelectTriggerClass, 'w-48')} aria-label={t('defaultFor', { name: project.name })}><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select></div></SettingRow>
      })}
    </SettingsSection>}
    {selectedProject && selectedEnvironment && <SetupHistory key={workspaceId + ':' + selectedProject.id + ':' + selectedEnvironment.id}
      workspaceId={workspaceId} projectId={selectedProject.id} environment={selectedEnvironment}
      canRestore={canManage && selectedProject.canEditProperties}
      onClose={() => setHistoryProject(null)} onSaved={() => { setHistoryProject(null); void list.mutate() }} />}
    {archived.length > 0 && <SettingsSection id="archived-environments" title={t('archived')}>
      {archived.map(environment => <SettingRow key={environment.id} title={environment.name} description={t('version', { revision: environment.revision })}>
        {canManage && <Button type="button" variant="outline" size="sm" busy={pending} disabled={pending} onClick={() => { void archive(environment, true) }}>{t('restore')}</Button>}
      </SettingRow>)}
    </SettingsSection>}
    {readError && <SettingsSaveError message={readError} retryLabel={common('retry')} onRetry={() => { void list.mutate() }} />}
    {failure && <FieldError>{failure}<Button type="button" variant="link" size="sm" onClick={() => { setEditing(null); setArchiving(null); setFailure(null); void list.mutate() }}>{common('refresh')}</Button></FieldError>}
    {canManage && editing && <EnvironmentEditor key={`${editing.environment?.id ?? 'new'}:${editing.environment?.revision ?? 0}`} workspaceId={workspaceId} environment={editing.environment}
      onClose={() => setEditing(null)} onRefused={refuse} onReload={() => { setEditing(null); void list.mutate() }} onSaved={() => { setEditing(null); void list.mutate() }} />}
    <AlertDialog open={canManage && !!archiving} onOpenChange={open => { if (!open && !pending) setArchiving(null) }}>
      <AlertDialogContent aria-describedby={undefined}>
        <AlertDialogHeader><AlertDialogTitle>{t('archiveNamed', { name: archiving?.name ?? '' })}</AlertDialogTitle></AlertDialogHeader>
        {failure && <FieldError>{failure}<Button type="button" variant="link" size="sm" onClick={() => { setArchiving(null); setFailure(null); void list.mutate() }}>{common('refresh')}</Button></FieldError>}
        <AlertDialogFooter><AlertDialogCancel disabled={pending}>{common('cancel')}</AlertDialogCancel>
          {/* Reversible: the archived list above restores it, so this is a write, not a delete (R-102). */}
          <AlertDialogAction variant="default" busy={pending} disabled={pending} onClick={event => { event.preventDefault(); if (archiving) void archive(archiving) }}>{t('archive')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}

function EnvironmentEditor({ workspaceId, environment, onClose, onSaved, onRefused, onReload }: {
  workspaceId: string; environment?: EnvironmentView; onClose: () => void; onSaved: () => void
  onRefused: (code: string) => void; onReload: () => void
}) {
  const t = useTranslations('Settings.environments')
  const tp = useTranslations('Settings.polish')
  const common = useTranslations('Common')
  const actionError = useActionError()
  const [name, setName] = useState(environment?.name ?? '')
  const [runtime, setRuntime] = useState<EnvironmentConfiguration['runtime']>(environment?.configuration.runtime ?? 'any')
  const [harness, setHarness] = useState<EnvironmentConfiguration['harness']>(environment?.configuration.harness ?? 'any')
  const [variablesText, setVariablesText] = useState(() => Object.entries(environment?.configuration.variables ?? {}).map(([key, val]) => `${key}=${val}`).join('\n'))
  const [command, setCommand] = useState(environment?.configuration.setup?.command ?? '')
  const [copyFiles, setCopyFiles] = useState(environment?.configuration.setup?.copyFiles?.join('\n') ?? '')
  const [approved, setApproved] = useState(environment?.configuration.setup?.approved ?? false)
  const [machineSize, setMachineSize] = useState<MachineSize | 'default'>(environment?.defaultMachineSize ?? 'default')
  const sizes = [{ value: 'default', label: t('machineSizeDefault') }, ...(Object.keys(MACHINE_SIZES) as MachineSize[])
    .map(value => ({ value, label: t('machineSizeOption', { vcpu: MACHINE_SIZES[value].vcpu, gib: MACHINE_SIZES[value].gib }) }))]
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const options = (['any', 'local', 'cloud'] as const).map(value => ({ value, label: t(`runtimes.${value}`) }))
  const harnessOptions = (['any', 'claude_code', 'codex', 'cursor'] as const).map(value => ({ value, label: tp(`harnesses.${value}`) }))

  async function save() {
    const existing: EnvironmentConfiguration = environment?.configuration ?? { runtime: 'any', harness: 'any', variables: {}, secretIds: [], repositoryKeys: [] }
    const parsedVariables = parseVariableLines(variablesText)
    if (!parsedVariables) { setFailure(t('invalid')); return }
    const files = copyFiles.split('\n').map(path => path.trim()).filter(Boolean)
    const setup = { copyFiles: files, ...(command.trim() ? { command } : {}), approved }
    const candidate = environmentFormSchema.safeParse({
      name,
      configuration: {
        ...existing,
        runtime,
        harness,
        variables: parsedVariables,
        setup: setup.command || setup.copyFiles.length ? setup : undefined,
      },
    })
    if (!candidate.success) { setFailure(t('invalid')); return }
    setPending(true); setFailure(null)
    try {
      const result = await saveEnvironment({ workspaceId, name: candidate.data.name, configuration: candidate.data.configuration, defaultMachineSize: machineSize === 'default' ? null : machineSize,
        ...(environment ? { id: environment.id, revision: environment.revision } : {}) })
      if (result.error) {
        if (['authRequired', 'workspaceAccessDenied', 'workspaceMembershipSuspended'].includes(result.error)) onRefused(result.error)
        else setFailure(actionError(result.error))
      }
      else onSaved()
    } catch (error) {
      const access = readAccessFailure(error)
      if (access) onRefused(access === 'session' ? 'authRequired' : 'workspaceAccessDenied')
      else setFailure(actionError())
    }
    finally { setPending(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{environment ? t('edit') : t('add')}</DialogTitle></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); void save() }} className="flex flex-col gap-5">
        <FieldGroup>
          <Field><FieldLabel htmlFor="environment-name">{t('name')}</FieldLabel><Input id="environment-name" className="border-border bg-background" value={name} maxLength={120} required disabled={pending} onChange={event => setName(event.target.value)} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field><FieldLabel htmlFor="environment-runtime">{t('runtime')}</FieldLabel><Select items={options} value={runtime} disabled={pending}
              onValueChange={value => { if (value === 'any' || value === 'local' || value === 'cloud') setRuntime(value) }}>
              <SelectTrigger id="environment-runtime" className={cn(settingsSelectTriggerClass, 'w-full')}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select></Field>
            <Field><FieldLabel htmlFor="environment-harness">{tp('envHarness')}</FieldLabel><Select items={harnessOptions} value={harness} disabled={pending}
              onValueChange={value => { if (value === 'any' || value === 'claude_code' || value === 'codex' || value === 'cursor') setHarness(value) }}>
              <SelectTrigger id="environment-harness" className={cn(settingsSelectTriggerClass, 'w-full')}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{harnessOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select></Field>
          </div>
          <Field><FieldLabel htmlFor="environment-machine-size">{t('machineSize')}</FieldLabel><Select items={sizes} value={machineSize} disabled={pending}
            onValueChange={value => { if (value === 'default' || isMachineSize(value)) setMachineSize(value) }}>
            <SelectTrigger id="environment-machine-size" className={cn(settingsSelectTriggerClass, 'w-full')}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{sizes.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select></Field>
          <Field><FieldLabel htmlFor="environment-variables">{tp('envVariables')}</FieldLabel><Textarea id="environment-variables" value={variablesText} rows={3} spellCheck={false} className="font-mono text-xs" placeholder="NODE_ENV=development" disabled={pending} onChange={event => setVariablesText(event.target.value)} /></Field>
          <Field><FieldLabel htmlFor="environment-setup">{t('setup')}</FieldLabel><Textarea id="environment-setup" value={command} maxLength={2000} rows={4} disabled={pending} onChange={event => { setCommand(event.target.value); setApproved(false) }} /></Field>
          <Field><FieldLabel htmlFor="environment-copy">{t('copyFiles')}</FieldLabel><Textarea id="environment-copy" value={copyFiles} rows={3} disabled={pending} onChange={event => { setCopyFiles(event.target.value); setApproved(false) }} /></Field>
          <Field orientation="horizontal"><Checkbox id="environment-approved" checked={approved} disabled={pending} onCheckedChange={value => setApproved(value === true)} /><FieldLabel htmlFor="environment-approved">{t('approveSetup')}</FieldLabel></Field>
        </FieldGroup>
        {failure && <FieldError>{failure}<Button type="button" variant="link" size="sm" onClick={onReload}>{common('refresh')}</Button></FieldError>}
        <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={onClose}>{common('cancel')}</Button><Button type="submit" busy={pending} disabled={pending}>{pending ? common('saving') : common('save')}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

function SetupHistory({ workspaceId, projectId, environment, canRestore, onClose, onSaved }: {
  workspaceId: string; projectId: string; environment: EnvironmentView; canRestore: boolean; onClose: () => void; onSaved: () => void
}) {
  const t = useTranslations('Settings.environments'), common = useTranslations('Common'), actionError = useActionError()
  const [pages, setPages] = useState<number[]>([])
  const [selected, setSelected] = useState<{ version: number; revision: number; bindingSnapshot: string; totalProjects: number } | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const before = pages.at(-1)
  const list = useSWR<ActionResult<ProjectSetupHistory>>(['project-setup-history', workspaceId, projectId, environment.id, environment.revision, before ?? null],
    () => listProjectSetupVersions({ workspaceId, projectId, environmentId: environment.id, before }), { ...settingsReadOptions, revalidateOnMount: true })
  const data = !list.error && !list.isValidating && list.data && !list.data.error ? list.data : null
  const readError = list.error ? actionError() : list.data?.error ? actionError(list.data.error) : null
  async function restore() {
    if (!data || !canRestore || selected === null) return
    setPending(true); setFailure(null)
    try {
      const result = await rollbackProjectSetup({ workspaceId, projectId, environmentId: environment.id,
        revision: selected.revision, bindingSnapshot: selected.bindingSnapshot, version: selected.version })
      if (!result.error) { onSaved(); return }
      if (['authRequired', 'workspaceAccessDenied', 'workspaceMembershipSuspended', 'projectNotFound'].includes(result.error)) { onClose(); return }
      setFailure(actionError(result.error)); setSelected(null); await list.mutate()
    } catch { setFailure(actionError()); setSelected(null) }
    finally { setPending(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}><DialogContent aria-describedby={undefined}>
    <DialogHeader><DialogTitle>{t('historyFor', { name: environment.name })}</DialogTitle></DialogHeader>
    {readError ? <FieldError>{readError}<Button type="button" variant="link" onClick={() => void list.mutate()}>{common('refresh')}</Button></FieldError>
      : !data ? <SettingsLoading bare label={common('loading')} />
        : <div className="grid max-h-[55vh] gap-2 overflow-y-auto">
            {data.versions.map(version => <div key={version.revision} className="grid gap-1">
              <div className="flex items-center justify-between gap-2"><span>{t('version', { revision: version.revision })}</span>
                {canRestore && version.revision < data.revision && <Button type="button" variant="outline" size="sm" disabled={pending}
                  onClick={() => { setFailure(null); setSelected({ version: version.revision, revision: data.revision, bindingSnapshot: data.bindingSnapshot, totalProjects: data.totalProjects }) }}>{t('restoreSetup')}</Button>}</div>
              {version.recipe?.command && <pre className="whitespace-pre-wrap break-words text-xs">{version.recipe.command}</pre>}
              {version.recipe?.copyFiles.length ? <pre className="whitespace-pre-wrap break-words text-xs">{version.recipe.copyFiles.join('\n')}</pre> : null}
              {!version.recipe && <span>{t('emptySetup')}</span>}
            </div>)}
            {(!!pages.length || data.before !== null) && <div className="flex gap-2">
              <Button type="button" variant="ghost" disabled={!pages.length || pending} onClick={() => { setSelected(null); setPages(p => p.slice(0, -1)) }}>{t('newer')}</Button>
              <Button type="button" variant="ghost" disabled={data.before === null || pending} onClick={() => { const next = data.before; if (next !== null) { setSelected(null); setPages(p => [...p, next]) } }}>{t('older')}</Button>
            </div>}
          </div>}
    {failure && <FieldError>{failure}</FieldError>}
    {selected !== null && data && canRestore && <AlertDialog open onOpenChange={open => { if (!open && !pending) setSelected(null) }}>
      <AlertDialogContent aria-describedby={undefined}><AlertDialogHeader><AlertDialogTitle>{t('confirmSetup', { revision: selected.version, name: environment.name })}</AlertDialogTitle></AlertDialogHeader>
        <p className="text-sm text-muted-foreground">{t('setupImpact', { count: selected.totalProjects })}</p>
        <AlertDialogFooter><AlertDialogCancel disabled={pending}>{common('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="default" busy={pending} disabled={pending} onClick={event => { event.preventDefault(); void restore() }}>{t('restoreSetup')}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent></AlertDialog>}
  </DialogContent></Dialog>
}

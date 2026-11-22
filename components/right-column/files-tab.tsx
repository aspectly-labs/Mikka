'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import type { WorkspaceEntry } from '@mikka/protocol/coding-workspace'
import { useFormatter, useTranslations } from '@/lib/intl/i18n-client'
import { Copy, Download, File, FileDiff, Folder, FolderOpen, MoreHorizontal } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { InlineLoadError } from '@/components/load-error'
import { Counts } from '@/components/workspace/thread-changes'
import { useThreadChanges } from '@/hooks/use-thread-run-reads'
import { useBotChatUploads, useThreadWorkspace } from '@/hooks/use-thread-workspace'
import { cn } from '@/lib/utils'
import type { ThreadWorkspace } from '@/lib/thread-workspace'
import type { ChangedFile } from '@/lib/thread-changes'
import { changeMark, readFile, readTree, searchFiles, uploadDownloadUrl, WorkspaceFilesError, type FilesScope, type TreePage } from '@/lib/right-column/workspace-files'
import { useRightColumnNavigation, type RightColumnScope } from './scope'

type View = 'all' | 'thread' | 'uploads'
type Upload = ThreadWorkspace['uploads'][number]

/**
 * Files (#2928, Figma 1318:15): the thread's checkout as a tree read from its machine (All files), the files this
 * thread changed (This thread) and what the person sent (Uploads). A changed file carries its M / A mark in the tree.
 * A Bot's chat has no machine of its own, so it has Uploads only. Nothing here is drawn without a read behind it.
 */
export function FilesTab({ scope }: { scope: RightColumnScope }) {
  return scope.kind === 'thread' ? <ThreadFiles runId={scope.runId} issueId={scope.issueId} /> : <BotFiles botId={scope.botId} />
}

function ThreadFiles({ runId, issueId }: { runId: string; issueId: string | null }) {
  const t = useTranslations('RightColumn.files')
  const workspace = useThreadWorkspace(runId)
  const { data: changes } = useThreadChanges(issueId, runId)
  const changed = useMemo(() => changes?.state === 'ready' ? changes.changes.files : [], [changes])
  const [view, setView] = useState<View>('all')
  const [query, setQuery] = useState('')
  if (workspace.error || workspace.refused) return <div className="p-4"><InlineLoadError message={t('loadFailed')} retryLabel={t('retry')} onRetry={workspace.retry} /></div>
  if (!workspace.data) return <Loading />
  const data = workspace.data
  const scope = data.checkout ? { runId: data.checkout.runId, repoId: data.checkout.repoId, workspaceId: data.workspaceId } : null
  return <div data-slot="right-column-files" className="flex min-h-0 flex-1 flex-col gap-3 p-3">
    <SearchInput aria-label={t('search')} placeholder={t('search')} value={query} onChange={event => setQuery(event.target.value)} />
    <ToggleGroup aria-label={t('views')} variant="segment" size="sm" spacing={0.5} value={[view]} onValueChange={values => { const next = values[0]; if (next === 'all' || next === 'thread' || next === 'uploads') setView(next) }}>
      <ToggleGroupItem value="all">{t('all')}</ToggleGroupItem>
      <ToggleGroupItem value="thread">{t('thread', { count: changed.length })}</ToggleGroupItem>
      <ToggleGroupItem value="uploads">{t('uploads', { count: data.uploads.length })}</ToggleGroupItem>
    </ToggleGroup>
    <div className="min-h-0 flex-1 overflow-y-auto">
      {view === 'all' ? scope ? <Tree key={`${scope.runId}:${scope.repoId}`} scope={scope} changed={changed} query={query} machineState={data.machine?.state ?? null} />
        : <Note>{t('noCheckout')}</Note>
        : view === 'thread' ? <ChangedList files={changed} query={query} empty={changes?.state === 'tooLarge' ? t('tooLarge') : t('noChanges')} />
          : <UploadList uploads={data.uploads} query={query} />}
    </div>
  </div>
}

function BotFiles({ botId }: { botId: string | null }) {
  const t = useTranslations('RightColumn.files')
  const uploads = useBotChatUploads(botId)
  const [query, setQuery] = useState('')
  if (uploads.error) return <div className="p-4"><InlineLoadError message={t('loadFailed')} retryLabel={t('retry')} onRetry={uploads.retry} /></div>
  if (!uploads.data) return uploads.loading ? <Loading /> : <Note>{t('noUploads')}</Note>
  return <div data-slot="right-column-files" className="flex min-h-0 flex-1 flex-col gap-3 p-3">
    <SearchInput aria-label={t('search')} placeholder={t('search')} value={query} onChange={event => setQuery(event.target.value)} />
    <p className="px-1 text-xs text-muted-foreground">{t('botUploads')}</p>
    <div className="min-h-0 flex-1 overflow-y-auto"><UploadList uploads={uploads.data} query={query} /></div>
  </div>
}

function Loading() {
  return <div role="status" className="flex flex-col gap-2 p-3"><Skeleton className="h-8 w-full" /><Skeleton className="h-6 w-2/3" /><Skeleton className="h-6 w-1/2" /></div>
}

function Note({ children }: { children: ReactNode }) {
  return <p className="px-2 py-6 text-center text-xs text-muted-foreground">{children}</p>
}

const matches = (query: string, path: string) => !query.trim() || path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())

/** The error code the workspace API answered with, in the person's words; an unknown code is still shown. */
function useFailure() {
  const t = useTranslations('RightColumn.files')
  return (error: unknown) => {
    const code = error instanceof WorkspaceFilesError ? error.code : 'unknown'
    return code === 'workspace_machine_unavailable' ? t('machineUnavailable') : code === 'workspace_checkout_unavailable' ? t('checkoutUnavailable')
      : code === 'workspace_not_found' ? t('notFound') : t('readFailed', { code })
  }
}

/** The checkout, a folder at a time (`kind=tree`), or the API's own search while there is a query. */
function Tree({ scope, changed, query, machineState }: { scope: FilesScope; changed: ChangedFile[]; query: string; machineState: string | null }) {
  const t = useTranslations('RightColumn.files')
  const failure = useFailure()
  const [pages, setPages] = useState<Record<string, TreePage>>({})
  const [failed, setFailed] = useState<Record<string, unknown>>({})
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const pending = useRef(new Map<string, AbortController>())
  const marks = useMemo(() => new Map(changed.map(file => [file.path, file])), [changed])
  async function load(path: string, cursor?: string) {
    if (pending.current.has(path)) return
    const controller = new AbortController()
    pending.current.set(path, controller)
    setFailed(current => { const next = { ...current }; delete next[path]; return next })
    try {
      const page = await readTree(scope, path, cursor, controller.signal)
      setPages(current => ({ ...current, [path]: cursor ? { entries: [...current[path]?.entries ?? [], ...page.entries], nextCursor: page.nextCursor } : page }))
    } catch (error) {
      if (!controller.signal.aborted) setFailed(current => ({ ...current, [path]: error }))
    } finally {
      if (pending.current.get(path) === controller) pending.current.delete(path)
    }
  }
  useEffect(() => {
    void load('')
    const requests = pending.current
    return () => { for (const request of requests.values()) request.abort(); requests.clear() }
    // The tree is keyed by its run and repository; a new checkout remounts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const search = query.trim()
  const found = useSWR(search ? ['workspace-search', scope.runId, scope.repoId, search] : null, () => searchFiles(scope, search), { revalidateOnFocus: false, shouldRetryOnError: false, keepPreviousData: true })
  const toggle = (path: string) => setOpen(current => {
    const next = new Set(current)
    if (next.has(path)) next.delete(path)
    else { next.add(path); if (!pages[path]) void load(path) }
    return next
  })
  const row = (entry: WorkspaceEntry, depth: number): ReactNode => entry.kind === 'directory'
    ? <div key={entry.path}>
      <Button variant="ghost" size="sm" aria-expanded={open.has(entry.path)} onClick={() => toggle(entry.path)} className="w-full justify-start gap-1.5 font-normal">
        {open.has(entry.path) ? <FolderOpen data-icon="inline-start" className="text-muted-foreground" /> : <Folder data-icon="inline-start" className="text-muted-foreground" />}
        <span className="truncate">{entry.name}</span>
      </Button>
      {open.has(entry.path) && <div role="group" className="ps-3">{children(entry.path, depth + 1)}</div>}
    </div>
    : <FileRow key={entry.path} path={entry.path} name={entry.name} depth={depth} change={marks.get(entry.path)} selected={selected === entry.path} onOpen={() => setSelected(selected === entry.path ? null : entry.path)} />
  const children = (path: string, depth: number): ReactNode => {
    const page = pages[path]
    if (failed[path]) return <div className="py-1"><InlineLoadError message={failure(failed[path])} retryLabel={t('retry')} onRetry={() => void load(path)} /></div>
    if (!page) return <div className="py-1"><Skeleton className="h-5 w-1/2" /></div>
    return <>
      {page.entries.map(entry => row(entry, depth))}
      {page.nextCursor && <Button variant="ghost" size="sm" onClick={() => void load(path, page.nextCursor!)}>{t('more')}</Button>}
    </>
  }
  return <div role="tree" aria-label={t('all')} className="flex flex-col">
    {machineState && machineState !== 'running' && machineState !== 'online' && <p className="px-2 pb-2 text-xs text-muted-foreground">{t('asleep')}</p>}
    {search ? found.error ? <InlineLoadError message={failure(found.error)} retryLabel={t('retry')} onRetry={() => { void found.mutate() }} />
      : !found.data ? <Skeleton className="h-5 w-1/2" />
        : found.data.length ? found.data.map(entry => row(entry, 0)) : <Note>{t('noMatches')}</Note>
      : children('', 0)}
    {selected && <Preview scope={scope} path={selected} />}
  </div>
}

function FileRow({ path, name, depth, change, selected, onOpen, extra }: { path: string; name: string; depth: number; change?: ChangedFile; selected?: boolean; onOpen?: () => void; extra?: ReactNode }) {
  const t = useTranslations('RightColumn.files')
  const navigation = useRightColumnNavigation()
  async function copyPath() {
    try { await navigator.clipboard.writeText(path); toast.success(t('pathCopied')) } catch { toast.error(t('copyFailed')) }
  }
  return <div role="treeitem" aria-selected={selected} className={cn('group flex items-center gap-1.5 rounded-md pe-1', selected && 'bg-accent')}>
    <Button variant="ghost" size="sm" onClick={onOpen} disabled={!onOpen} title={path} className="min-w-0 flex-1 justify-start gap-1.5 font-normal disabled:opacity-100">
      <File data-icon="inline-start" className="text-muted-foreground" />
      <span className="truncate font-mono text-xs">{name}</span>
    </Button>
    {change && <Counts additions={change.additions} deletions={change.deletions} />}
    {change && <span role="img" aria-label={t(`status.${change.status}`)} title={t(`status.${change.status}`)} className={cn('grid size-4 shrink-0 place-items-center rounded font-mono text-xs font-semibold', change.status === 'added' ? 'text-success-foreground' : change.status === 'deleted' ? 'text-destructive-foreground' : 'text-warning-foreground')}>{changeMark[change.status]}</span>}
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('actions', { name })} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100" />}><MoreHorizontal /></DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuGroup>
        {onOpen && <DropdownMenuItem onClick={onOpen}><File />{t('open')}</DropdownMenuItem>}
        {change && navigation && <DropdownMenuItem onClick={() => navigation.show('changes')}><FileDiff />{t('viewDiff')}</DropdownMenuItem>}
        <DropdownMenuItem onClick={() => { void copyPath() }}><Copy />{t('copyPath')}</DropdownMenuItem>
      </DropdownMenuGroup>{extra}</DropdownMenuContent>
    </DropdownMenu>
  </div>
}

/** A file's text as the machine has it now (`kind=file`); a binary or oversized file says so. */
function Preview({ scope, path }: { scope: FilesScope; path: string }) {
  const t = useTranslations('RightColumn.files')
  const failure = useFailure()
  const { data, error, mutate } = useSWR(['workspace-file', scope.runId, scope.repoId, path], () => readFile(scope, path), { revalidateOnFocus: false, shouldRetryOnError: false })
  return <section aria-label={path} className="mt-3 flex min-h-0 flex-col rounded-lg border">
    <header className="truncate rounded-t-lg bg-muted px-3 py-1.5 font-mono text-xs text-muted-foreground" title={path}>{path}</header>
    {error ? <div className="p-3"><InlineLoadError message={failure(error)} retryLabel={t('retry')} onRetry={() => { void mutate() }} /></div>
      : !data ? <div className="p-3"><Skeleton className="h-16 w-full" /></div>
        : data.format !== 'text' || data.content === null ? <Note>{t(`format.${data.format === 'text' ? 'unsupported' : data.format}`)}</Note>
          : <pre className="max-h-96 overflow-auto p-3 font-mono text-xs leading-5">{data.content}{data.truncated ? `\n${t('truncated')}` : ''}</pre>}
  </section>
}

/** The files this thread changed, from its saved checkpoint diff (getThreadChanges), with their marks and counts. */
function ChangedList({ files, query, empty }: { files: ChangedFile[]; query: string; empty: string }) {
  const shown = files.filter(file => matches(query, file.path))
  if (!files.length) return <Note>{empty}</Note>
  return <div role="tree" className="flex flex-col">
    {shown.map(file => <FileRow key={file.path} path={file.path} name={file.path} depth={0} change={file} />)}
  </div>
}

function UploadList({ uploads, query }: { uploads: Upload[]; query: string }) {
  const t = useTranslations('RightColumn.files')
  const format = useFormatter()
  const shown = uploads.filter(upload => matches(query, upload.name))
  if (!uploads.length) return <Note>{t('noUploads')}</Note>
  return <div role="tree" className="flex flex-col">
    {shown.map(upload => <div key={upload.id} className="flex items-center gap-2">
      <div className="min-w-0 flex-1"><FileRow path={upload.name} name={upload.name} depth={0}
        extra={<DropdownMenuGroup><DropdownMenuItem render={<a href={uploadDownloadUrl(upload.id)} download={upload.name} />}><Download />{t('download')}</DropdownMenuItem></DropdownMenuGroup>} /></div>
      <span className="shrink-0 text-xs text-muted-foreground">{format.number(upload.size / 1024, { maximumFractionDigits: 0 })} KB</span>
    </div>)}
  </div>
}


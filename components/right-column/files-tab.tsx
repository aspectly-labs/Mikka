'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import type { WorkspaceEntry } from '@mikka/protocol/coding-workspace'
import type { GitStatus } from '@pierre/trees'
import { FileTree, useFileTree } from '@pierre/trees/react'
import { useFormatter, useTranslations } from '@/lib/intl/i18n-client'
import { Copy, Download, File, FileDiff, MoreHorizontal } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { InlineLoadError } from '@/components/load-error'
import { useThreadChanges } from '@/hooks/use-thread-run-reads'
import { useBotChatUploads, useThreadWorkspace } from '@/hooks/use-thread-workspace'
import type { ThreadWorkspace } from '@/lib/thread-workspace'
import type { ChangedFile } from '@/lib/thread-changes'
import { readFile, readTree, searchFiles, uploadDownloadUrl, WorkspaceFilesError, type FilesScope } from '@/lib/right-column/workspace-files'
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

/** A directory's id in the tree model: @pierre/trees marks a directory with a trailing slash. */
const dirId = (path: string) => `${path}/`
const plain = (id: string) => id.replace(/\/$/, '')
const STATUS: Record<ChangedFile['status'], GitStatus> = { added: 'added', deleted: 'deleted', modified: 'modified', renamed: 'renamed' }

/**
 * A file tree drawn by @pierre/trees (the same vendor as the diffs, Alex 2026-11-22): its git marks (M / A) and a
 * `+x −y` lane from the thread's changes, a row menu (Open, View thread diff, Copy path), and selection opening a
 * file. `onExpand` hears a folder opened that has not been read yet, so the caller can load it lazily.
 */
function PierreTree({ paths, changed, query, onOpen, onExpand, label, open = false }: {
  paths: readonly string[]; changed: ChangedFile[]; query: string; label: string
  /** Every folder open from the start: a short list of changed files, not a checkout read a folder at a time. */
  open?: boolean
  onOpen?: (path: string) => void; onExpand?: (path: string) => void
}) {
  const t = useTranslations('RightColumn.files')
  const navigation = useRightColumnNavigation()
  const marks = useRef(new Map<string, ChangedFile>())
  marks.current = new Map(changed.map(file => [file.path, file]))
  const opener = useRef(onOpen)
  opener.current = onOpen
  const { model } = useFileTree({
    paths, density: 'compact', initialExpansion: open ? 'open' : 'closed', flattenEmptyDirectories: false,
    gitStatus: changed.map(file => ({ path: file.path, status: STATUS[file.status] })),
    labels: { contextMenuTrigger: t('actionsShort'), gitStatusTitles: { added: t('status.added'), deleted: t('status.deleted'), modified: t('status.modified'), renamed: t('status.renamed') } },
    composition: { contextMenu: { enabled: true, triggerMode: 'both', buttonVisibility: 'when-needed' } },
    renderRowDecoration: ({ item }) => {
      const change = item.kind === 'file' ? marks.current.get(item.path) : undefined
      return change ? { text: `+${change.additions} −${change.deletions}`, parts: [
        { text: `+${change.additions}`, color: 'var(--color-success-foreground)' }, { text: ` −${change.deletions}`, color: 'var(--color-destructive-foreground)' }] } : null
    },
    onSelectionChange: selected => { const [one] = selected; if (selected.length === 1 && one && !one.endsWith('/')) opener.current?.(one) },
  })
  // Paths read later (a folder opened, a search result) join the model; one already there is left alone.
  const known = useRef(new Set(paths))
  useEffect(() => {
    const fresh = paths.filter(path => !known.current.has(path))
    if (!fresh.length) return
    for (const path of fresh) known.current.add(path)
    model.batch(fresh.map(path => ({ type: 'add' as const, path })))
  }, [model, paths])
  useEffect(() => { model.setGitStatus(changed.map(file => ({ path: file.path, status: STATUS[file.status] }))) }, [model, changed])
  useEffect(() => { model.setSearch(query.trim() || null) }, [model, query])
  // A folder opened for the first time asks its caller for its entries.
  const expand = useRef(onExpand)
  expand.current = onExpand
  useEffect(() => model.subscribe(() => {
    for (const row of model.getVisibleRows(0, model.getVisibleCount()))
      if (row.kind === 'directory' && row.isExpanded) expand.current?.(plain(row.path))
  }), [model])
  async function copyPath(path: string) {
    try { await navigator.clipboard.writeText(path); toast.success(t('pathCopied')) } catch { toast.error(t('copyFailed')) }
  }
  return <FileTree model={model} aria-label={label}
    className="min-h-64 flex-1 [--trees-bg-override:transparent] [--trees-border-color-override:var(--border)] [--trees-fg-override:var(--foreground)] [--trees-selected-bg-override:var(--accent)]"
    renderContextMenu={(item, context) => {
      const path = plain(item.path)
      const close = () => context.close()
      return <div role="menu" aria-label={t('actions', { name: item.name })} data-file-tree-context-menu-root="true" className="flex min-w-44 flex-col rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
        {item.kind === 'file' && onOpen && <Button role="menuitem" variant="ghost" size="sm" className="justify-start font-normal" onClick={() => { close(); onOpen(path) }}><File data-icon="inline-start" />{t('open')}</Button>}
        {marks.current.has(path) && navigation && <Button role="menuitem" variant="ghost" size="sm" className="justify-start font-normal" onClick={() => { close(); navigation.show('changes') }}><FileDiff data-icon="inline-start" />{t('viewDiff')}</Button>}
        <Button role="menuitem" variant="ghost" size="sm" className="justify-start font-normal" onClick={() => { close(); void copyPath(path) }}><Copy data-icon="inline-start" />{t('copyPath')}</Button>
      </div>
    }} />
}

/** The checkout, read a folder at a time (`kind=tree`) as folders open; a query also asks the API's own search. */
function Tree({ scope, changed, query, machineState }: { scope: FilesScope; changed: ChangedFile[]; query: string; machineState: string | null }) {
  const t = useTranslations('RightColumn.files')
  const failure = useFailure()
  const [paths, setPaths] = useState<string[]>([])
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState<{ path: string; error: unknown } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const loaded = useRef(new Set<string>())
  const controllers = useRef(new Set<AbortController>())
  const add = (entries: WorkspaceEntry[]) => setPaths(current => {
    const have = new Set(current)
    const next = entries.map(entry => entry.kind === 'directory' ? dirId(entry.path) : entry.path).filter(path => !have.has(path))
    return next.length ? [...current, ...next] : current
  })
  async function load(path: string) {
    if (loaded.current.has(path)) return
    loaded.current.add(path)
    const controller = new AbortController()
    controllers.current.add(controller)
    setFailed(current => current?.path === path ? null : current)
    try {
      // A folder is read whole, a page at a time (200 entries a page, at most ten pages).
      let cursor: string | undefined
      for (let page = 0; page < 10; page++) {
        const read = await readTree(scope, path, cursor, controller.signal)
        add(read.entries)
        if (!read.nextCursor) break
        cursor = read.nextCursor
      }
      if (!path) setReady(true)
    } catch (error) {
      loaded.current.delete(path)
      if (!controller.signal.aborted) setFailed({ path, error })
    } finally {
      controllers.current.delete(controller)
    }
  }
  useEffect(() => {
    void load('')
    const running = controllers.current
    return () => { for (const controller of running) controller.abort(); running.clear() }
    // The tree is keyed by its run and repository; a new checkout remounts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const search = query.trim()
  const found = useSWR(search ? ['workspace-search', scope.runId, scope.repoId, search] : null, () => searchFiles(scope, search), { revalidateOnFocus: false, shouldRetryOnError: false, keepPreviousData: true })
  useEffect(() => { if (found.data) add(found.data) }, [found.data])
  return <div aria-label={t('all')} className="flex min-h-0 flex-1 flex-col gap-2">
    {machineState && machineState !== 'running' && machineState !== 'online' && <p className="px-2 text-xs text-muted-foreground">{t('asleep')}</p>}
    {failed && <InlineLoadError message={failure(failed.error)} retryLabel={t('retry')} onRetry={() => void load(failed.path)} />}
    {found.error && <InlineLoadError message={failure(found.error)} retryLabel={t('retry')} onRetry={() => { void found.mutate() }} />}
    {!ready && !failed ? <div role="status" className="flex flex-col gap-2 px-2"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-1/2" /></div>
      : ready && <PierreTree paths={paths} changed={changed} query={query} label={t('all')} onOpen={path => setSelected(path)} onExpand={path => void load(path)} />}
    {selected && <Preview scope={scope} path={selected} />}
  </div>
}

/** An upload's row: its name, and a menu with Copy path and Download (`extra`). */
function FileRow({ path, name, extra }: { path: string; name: string; extra?: ReactNode }) {
  const t = useTranslations('RightColumn.files')
  async function copyPath() {
    try { await navigator.clipboard.writeText(path); toast.success(t('pathCopied')) } catch { toast.error(t('copyFailed')) }
  }
  return <div className="group flex items-center gap-1.5 rounded-md pe-1">
    <span title={path} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5">
      <File className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono text-xs">{name}</span>
    </span>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('actions', { name })} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100" />}><MoreHorizontal /></DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuGroup>
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

/** The files this thread changed, from its saved checkpoint diff (getThreadChanges), as a tree with their marks and counts. */
function ChangedList({ files, query, empty }: { files: ChangedFile[]; query: string; empty: string }) {
  const t = useTranslations('RightColumn.files')
  const paths = useMemo(() => files.map(file => file.path), [files])
  if (!files.length) return <Note>{empty}</Note>
  return <PierreTree key={paths.join('\n')} paths={paths} changed={files} query={query} label={t('thread')} open />
}

function UploadList({ uploads, query }: { uploads: Upload[]; query: string }) {
  const t = useTranslations('RightColumn.files')
  const format = useFormatter()
  const shown = uploads.filter(upload => matches(query, upload.name))
  if (!uploads.length) return <Note>{t('noUploads')}</Note>
  return <div role="list" className="flex flex-col">
    {shown.map(upload => <div role="listitem" key={upload.id} className="flex items-center gap-2">
      <div className="min-w-0 flex-1"><FileRow path={upload.name} name={upload.name}
        extra={<DropdownMenuGroup><DropdownMenuItem render={<a href={uploadDownloadUrl(upload.id)} download={upload.name} />}><Download />{t('download')}</DropdownMenuItem></DropdownMenuGroup>} /></div>
      <span className="shrink-0 text-xs text-muted-foreground">{format.number(upload.size / 1024, { maximumFractionDigits: 0 })} KB</span>
    </div>)}
  </div>
}


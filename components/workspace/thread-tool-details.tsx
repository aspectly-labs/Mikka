'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { ansiToLines, CodeBlock as TerminalCode, CodeBlockContent as TerminalContent } from '@/components/reui/code-block/code-block'
import { toolDetailView, type ToolDetailKind, type ToolDetailView } from '@/lib/tool-detail-view'
import { cn } from '@/lib/utils'
import type { ThreadToolFull } from '@/components/slots/thread-contract'

// Pierre's diff view loads only when an opened edit shows one.
const FileDiff = lazy(() => import('@/components/agents/file-diff').then(module => ({ default: module.FileDiff })))

const TERMINAL_CODE = '[--code-block-padding:0px] [--code-block-font-size:0.75rem] [--code-block-line-height:1.25rem] [&_[data-slot=code-block-line-content]]:[overflow-wrap:anywhere]'
const SCROLL = 'flex max-h-72 min-w-0 flex-col gap-1 overflow-auto overscroll-contain px-2.5 py-2 text-left scrollbar-thin'

/**
 * An opened tool call as LobeHub's and Claude Code's renderers show it (Alex, 2026-11-22): one panel, nothing twice,
 * the row above already names the tool and its target. A command is `$ command` then its output; a file read its code
 * in its language; a search its matches; an edit its diff; any other tool, as AI Elements' Tool, its parameters only
 * when the row does not say them, then its result or error. There is no raw data section.
 */
export function ThreadToolDetails({ full, ...props }: DetailsProps & { full?: ThreadToolFull }) {
  // The whole call is read only once its row is open: a closed <details> still mounts its body.
  const [open, setOpen] = useState(false)
  const watch = useCallback((node: HTMLDivElement | null) => {
    if (!node || !full) return
    const details = node.closest('details')
    if (!details) { setOpen(true); return }
    const sync = () => setOpen(details.open)
    sync()
    details.addEventListener('toggle', sync)
    return () => details.removeEventListener('toggle', sync)
  }, [full])
  const { data } = useSWR(full && open ? ['thread-tool-full', full.key] : null, () => full!.load(),
    { revalidateOnFocus: false, revalidateIfStale: false, shouldRetryOnError: false })
  const shown = data ? { ...props, ...(data.input !== undefined ? { input: data.input } : {}), ...(data.output !== undefined ? { output: data.output } : {}),
    truncated: Boolean(data.outputCut || data.inputCut) } : props
  if (!full) return <ToolDetails {...props} />
  return <div ref={watch} className="contents"><ToolDetails {...shown} /></div>
}

type DetailsProps = {
  kind?: ToolDetailKind
  target?: string
  command?: string
  input?: string
  output?: string
  exitCode?: number
  status?: 'running' | 'done' | 'failed' | 'stopped'
  ms?: number
  truncated?: boolean
}

function ToolDetails({ kind, target, command, input, output, status, truncated }: DetailsProps) {
  const t = useTranslations('Coordinator.activity.card')
  const outputLines = useMemo(() => command && output ? ansiToLines(output.replace(/\r?\n$/, '')) : undefined, [command, output])
  const view = useMemo(() => command ? null : toolDetailView({ kind, target, input, output, failed: status === 'failed' }), [command, kind, target, input, output, status])
  const cut = truncated ? <p className="text-xs text-muted-foreground">{t('truncated')}</p> : null

  // A command: the command, then what it printed, as LobeHub's Bash renderer; the row already says how it ended.
  if (command) return <Panel data-thread-terminal="">
    <div className="flex min-w-0 shrink-0 items-start gap-2">
      <span aria-hidden="true" className="shrink-0 font-mono text-xs leading-5 text-muted-foreground select-none">$</span>
      <TerminalCode code={command} language="bash" label={t('command')} wrap variant="ghost" data-thread-command="" className={cn(TERMINAL_CODE, 'flex-1 text-foreground')}>
        <TerminalContent />
      </TerminalCode>
    </div>
    {outputLines && <TerminalCode lines={outputLines} label={t('result')} wrap variant="ghost" data-thread-tool-output="" className={cn(TERMINAL_CODE, 'shrink-0 text-muted-foreground')}>
      <TerminalContent />
    </TerminalCode>}
    {cut}
  </Panel>
  return view ? <ReadableDetails view={view} cut={cut} /> : null
}

/** The one panel an opened row shows: no title, no sections, the text's full width (LobeHub's tool result box). */
function Panel({ children, ...data }: { children: ReactNode } & Record<`data-${string}`, string>) {
  return <div dir="ltr" data-thread-tool-details="" className={cn(SCROLL, 'rounded-lg border border-border bg-card')} {...data}>{children}</div>
}

/** A small muted label over a block, as AI Elements' Tool labels Parameters and Result; sentence case, not its uppercase (R-32). */
function Label({ children, error }: { children: ReactNode; error?: boolean }) {
  return <span className={cn('text-xs font-medium text-muted-foreground', error && 'text-destructive-foreground')}>{children}</span>
}

function ReadableDetails({ view, cut }: { view: ToolDetailView; cut: ReactNode }) {
  const t = useTranslations('Coordinator.activity.card')
  const copy = useTranslations('AiElements.message')
  if (view.type === 'file') return <Panel data-thread-tool-file="">
    <TerminalCode code={view.code} {...(view.language ? { language: view.language } : {})} wrap variant="ghost" label={view.path ?? t('result')} className={TERMINAL_CODE}>
      <TerminalContent />
    </TerminalCode>
    {cut}
  </Panel>
  if (view.type === 'matches') return <Panel data-thread-tool-matches="">
    {view.lines.length ? <ul className="flex min-w-0 flex-col font-mono text-xs leading-5 text-foreground">
      {view.lines.map((line, index) => <li key={index} className="min-w-0 [overflow-wrap:anywhere]">{line}</li>)}
    </ul> : <span className="text-xs text-muted-foreground">{t('noMatches')}</span>}
    {cut}
  </Panel>
  if (view.type === 'diff') return <div data-thread-tool-details="" data-thread-tool-diff="" className="min-w-0 overflow-hidden rounded-lg border border-border">
    <Suspense fallback={null}>
      <FileDiff file={view.file} lines={view.lines} status="complete" {...(view.language ? { language: view.language } : {})} copyLabel={copy('copy')} copiedLabel={copy('copied')} />
    </Suspense>
  </div>
  // Any other tool, as AI Elements' Tool: its parameters when the row does not already say them, then its result (or
  // error), each once, small.
  const code = (text: string, json: boolean, error = false) => json
    ? <TerminalCode code={text} language="json" wrap variant="ghost" label={t('result')} className={cn(TERMINAL_CODE, error && 'text-destructive-foreground')}><TerminalContent /></TerminalCode>
    : <p className={cn('min-w-0 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]', error && 'text-destructive-foreground')}>{text}</p>
  return <Panel data-thread-tool-generic="">
    {view.params && <div data-thread-tool-input="" className="flex min-w-0 flex-col gap-1"><Label>{t('args')}</Label>{code(view.params.text, view.params.json)}</div>}
    {view.output && <div data-thread-tool-output="" className={cn('flex min-w-0 flex-col gap-1', view.error && 'rounded-md bg-destructive/10 px-2 py-1.5')}>
      <Label error={view.error}>{view.error ? t('error') : t('result')}</Label>{code(view.output.text, view.output.json, view.error)}
    </div>}
    {cut}
  </Panel>
}

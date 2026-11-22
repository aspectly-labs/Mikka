'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { lazy, Suspense, useMemo, type ReactNode } from 'react'
import { ansiToLines, CodeBlock as TerminalCode, CodeBlockContent as TerminalContent } from '@/components/reui/code-block/code-block'
import { CodeBlock, CodeBlockContent, CodeBlockFooter, CodeBlockHeader, CodeBlockTitle } from '@/components/ui/code-block'
import { TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceLine, TraceTitle } from '@/components/ui/trace'
import { Check, LoaderCircle, X } from '@/components/icons'
import { toolDetailView, type ToolDetailKind, type ToolDetailView } from '@/lib/tool-detail-view'
import { cn } from '@/lib/utils'

// Pierre's diff view loads only when an opened edit shows one.
const FileDiff = lazy(() => import('@/components/agents/file-diff').then(module => ({ default: module.FileDiff })))

const TERMINAL_CODE = '[--code-block-padding:0px] [--code-block-font-size:0.75rem] [--code-block-line-height:1.25rem] [&_[data-slot=code-block-line-content]]:[overflow-wrap:anywhere]'
const SCROLL = 'flex max-h-72 min-w-0 flex-col gap-1 overflow-auto overscroll-contain px-2.5 py-2 text-left scrollbar-thin'

/**
 * A tool call's recorded details, readable as Claude Code and LobeHub show them (Alex, 2026-11-22). A command is its
 * Shell box (#2923, Figma 1318:63): 「Shell」, `$ command`, the output it kept and, at the foot, how it ended. A file
 * read is the file's code in its language, a search its matches, an edit its diff, any other tool its inputs as a
 * short list and its output as text (JSON only when structured). The raw input and output fold under 「原始数据」
 * (decision 2026-11-05-0330), closed.
 */
export function ThreadToolDetails({ kind, target, command, input, output, exitCode, status, ms, truncated }: {
  kind?: ToolDetailKind
  target?: string
  command?: string
  input?: string
  output?: string
  exitCode?: number
  status?: 'running' | 'done' | 'failed' | 'stopped'
  ms?: number
  truncated?: boolean
}) {
  const t = useTranslations('Coordinator.activity.card')
  const outputLines = useMemo(() => command && output ? ansiToLines(output.replace(/\r?\n$/, '')) : undefined, [command, output])
  const view = useMemo(() => command ? null : toolDetailView({ kind, target, input, output }), [command, kind, target, input, output])

  const ended = status === 'running' ? t('running')
    : exitCode === 0 || (exitCode === undefined && status === 'done') ? t('succeeded')
    : exitCode !== undefined ? t('exitCode', { code: exitCode })
    : status === 'failed' ? t('failed') : status === 'stopped' ? t('stopped') : null
  const time = ms !== undefined && status !== 'running' && exitCode !== 0 ? t('seconds', { seconds: Math.max(1, Math.round(ms / 1000)) }) : null
  const EndIcon = status === 'running' ? LoaderCircle : exitCode === 0 || (exitCode === undefined && status === 'done') ? Check : X

  if (command) return <CodeBlock size="sm" className="border-border bg-card" data-thread-tool-details="" data-thread-terminal="">
    <CodeBlockHeader><CodeBlockTitle>{t('shell')}</CodeBlockTitle></CodeBlockHeader>
    <div dir="ltr" className={SCROLL} data-thread-terminal-scroll="">
      <div className="flex min-w-0 shrink-0 items-start gap-2">
        <span aria-hidden="true" className="shrink-0 font-mono text-xs leading-5 text-muted-foreground select-none">$</span>
        <TerminalCode code={command} language="bash" label={t('command')} wrap variant="ghost" data-thread-command="" className={cn(TERMINAL_CODE, 'flex-1 text-foreground')}>
          <TerminalContent />
        </TerminalCode>
      </div>
      {outputLines && <TerminalCode lines={outputLines} label={t('result')} wrap variant="ghost" data-thread-tool-output="" className={cn(TERMINAL_CODE, 'shrink-0 text-muted-foreground')}>
        <TerminalContent />
      </TerminalCode>}
    </div>
    {(ended || truncated) && <CodeBlockFooter className="justify-between gap-3 pb-2 text-xs tabular-nums">
      <span>{truncated ? t('truncated') : null}</span>
      {ended && <span data-thread-tool-status="" className={cn('flex shrink-0 items-center gap-1', exitCode !== undefined && exitCode !== 0 && 'text-destructive-foreground')}>
        <EndIcon aria-hidden="true" className={cn('size-3.5', status === 'running' && 'animate-spin motion-reduce:animate-none')} />
        {[ended, time].filter(Boolean).join(' · ')}
      </span>}
    </CodeBlockFooter>}
  </CodeBlock>

  return <div data-thread-tool-details="" className="flex min-w-0 flex-col gap-2">
    {view && <ReadableDetails view={view} truncated={truncated} />}
    {exitCode !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{t('exitCode', { code: exitCode })}</span>}
    {(input || output) && <RawData input={input} output={output} failed={status === 'failed'} />}
  </div>
}

/** One framed block: a title, then its body scrolling inside the frame. */
function Frame({ title, children, footer, ...data }: { title?: ReactNode; children: ReactNode; footer?: ReactNode } & Record<`data-${string}`, string>) {
  return <CodeBlock size="sm" className="border-border bg-card" {...data}>
    {title && <CodeBlockHeader><CodeBlockTitle dir="auto">{title}</CodeBlockTitle></CodeBlockHeader>}
    <div dir="ltr" className={SCROLL}>{children}</div>
    {footer && <CodeBlockFooter className="pb-2 text-xs">{footer}</CodeBlockFooter>}
  </CodeBlock>
}

function ReadableDetails({ view, truncated }: { view: ToolDetailView; truncated?: boolean }) {
  const t = useTranslations('Coordinator.activity.card')
  const copy = useTranslations('AiElements.message')
  const cut = truncated ? t('truncated') : undefined
  if (view.type === 'file') return <Frame title={view.path} footer={cut} data-thread-tool-file="">
    <TerminalCode code={view.code} {...(view.language ? { language: view.language } : {})} wrap variant="ghost" label={view.path ?? t('result')} className={TERMINAL_CODE}>
      <TerminalContent />
    </TerminalCode>
  </Frame>
  if (view.type === 'matches') return <Frame title={view.query} footer={cut} data-thread-tool-matches="">
    {view.lines.length ? <ul className="flex min-w-0 flex-col font-mono text-xs leading-5 text-foreground">
      {view.lines.map((line, index) => <li key={index} className="min-w-0 [overflow-wrap:anywhere]">{line}</li>)}
    </ul> : <span className="text-xs text-muted-foreground">{t('noMatches')}</span>}
  </Frame>
  if (view.type === 'diff') return <div data-thread-tool-diff="" className="min-w-0 overflow-hidden rounded-lg border border-border">
    <Suspense fallback={null}>
      <FileDiff file={view.file} lines={view.lines} status="complete" {...(view.language ? { language: view.language } : {})} copyLabel={copy('copy')} copiedLabel={copy('copied')} />
    </Suspense>
  </div>
  return <div data-thread-tool-generic="" className="flex min-w-0 flex-col gap-2">
    {view.fields.length > 0 && <Frame title={t('args')} data-thread-tool-input="">
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-5">
        {view.fields.map((field, index) => <div key={index} className="contents">
          <dt className="font-mono text-muted-foreground">{field.key}</dt>
          <dd className={cn('min-w-0 text-foreground [overflow-wrap:anywhere]', !field.key && 'col-span-2 font-mono')}>{field.value}</dd>
        </div>)}
      </dl>
    </Frame>}
    {view.output && <Frame title={t('result')} footer={cut} data-thread-tool-output="">
      {view.output.json ? <TerminalCode code={view.output.text} language="json" wrap variant="ghost" label={t('result')} className={TERMINAL_CODE}><TerminalContent /></TerminalCode>
        : <p className="min-w-0 whitespace-pre-wrap text-xs leading-5 text-foreground [overflow-wrap:anywhere]">{view.output.text}</p>}
    </Frame>}
  </div>
}

/** The call's raw input and output, folded under 「原始数据」, one more click away (decision 2026-11-05-0330). */
function RawData({ input, output, failed }: { input?: string; output?: string; failed: boolean }) {
  const t = useTranslations('Coordinator.activity.detail')
  return <TraceCollapsible data-thread-tool-raw="">
    <TraceCollapsibleTrigger><TraceLine><TraceTitle>{t('raw')}</TraceTitle></TraceLine></TraceCollapsibleTrigger>
    <TraceCollapsibleContent className="flex flex-col gap-2">
      {input && <CodeBlock size="sm"><CodeBlockContent wrap className="max-h-40">{input}</CodeBlockContent></CodeBlock>}
      {output && <CodeBlock size="sm" {...(failed ? { variant: 'destructive' as const } : {})}><CodeBlockContent wrap className="max-h-64">{output}</CodeBlockContent></CodeBlock>}
    </TraceCollapsibleContent>
  </TraceCollapsible>
}

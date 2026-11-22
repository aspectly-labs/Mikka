'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { useMemo } from 'react'
import { ansiToLines, CodeBlock as TerminalCode, CodeBlockContent as TerminalContent } from '@/components/reui/code-block/code-block'
import { CodeBlock, CodeBlockContent, CodeBlockFooter, CodeBlockHeader, CodeBlockTitle } from '@/components/ui/code-block'
import { Check, LoaderCircle, X } from '@/components/icons'
import { cn } from '@/lib/utils'

const TERMINAL_CODE = '[--code-block-padding:0px] [--code-block-font-size:0.75rem] [--code-block-line-height:1.25rem] [&_[data-slot=code-block-line-content]]:[overflow-wrap:anywhere]'

/**
 * A tool call's recorded details. A command is its Shell box (#2923, Figma 1318:63): 「Shell」, `$ command`, the output it
 * kept and, at the foot, how it ended: 成功, exit N with its time, or 运行中. When the daemon kept only the end of the
 * output, the box says so.
 */
export function ThreadToolDetails({ command, input, output, exitCode, status, ms, truncated }: {
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

  const ended = status === 'running' ? t('running')
    : exitCode === 0 || (exitCode === undefined && status === 'done') ? t('succeeded')
    : exitCode !== undefined ? t('exitCode', { code: exitCode })
    : status === 'failed' ? t('failed') : status === 'stopped' ? t('stopped') : null
  const time = ms !== undefined && status !== 'running' && exitCode !== 0 ? t('seconds', { seconds: Math.max(1, Math.round(ms / 1000)) }) : null
  const EndIcon = status === 'running' ? LoaderCircle : exitCode === 0 || (exitCode === undefined && status === 'done') ? Check : X

  if (command) return <CodeBlock size="sm" className="border-border bg-card" data-thread-tool-details="" data-thread-terminal="">
    <CodeBlockHeader><CodeBlockTitle>{t('shell')}</CodeBlockTitle></CodeBlockHeader>
    <div dir="ltr" className="flex max-h-72 min-w-0 flex-col gap-1 overflow-auto overscroll-contain px-2.5 py-2 text-left scrollbar-thin" data-thread-terminal-scroll="">
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

  return <CodeBlock size="sm" data-thread-tool-details="">
    {input && <>
      <CodeBlockHeader><CodeBlockTitle>{t('args')}</CodeBlockTitle></CodeBlockHeader>
      <CodeBlockContent wrap className="max-h-40">{input}</CodeBlockContent>
    </>}
    {output && <>
      <CodeBlockHeader><CodeBlockTitle>{t('result')}</CodeBlockTitle></CodeBlockHeader>
      <CodeBlockContent wrap className="max-h-64" data-thread-tool-output="">{output}</CodeBlockContent>
    </>}
    {exitCode !== undefined && <CodeBlockFooter className="tabular-nums">{t('exitCode', { code: exitCode })}</CodeBlockFooter>}
  </CodeBlock>
}

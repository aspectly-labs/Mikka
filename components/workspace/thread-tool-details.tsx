'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { useMemo, useState } from 'react'
import { ansiToLines, CodeBlock as TerminalCode, CodeBlockContent as TerminalContent } from '@/components/reui/code-block/code-block'
import { Button } from '@/components/ui/button'
import { CodeBlock, CodeBlockContent, CodeBlockFooter, CodeBlockHeader, CodeBlockTitle } from '@/components/ui/code-block'
import { cn } from '@/lib/utils'

const TERMINAL_CODE = '[--code-block-padding:0px] [--code-block-font-size:0.75rem] [--code-block-line-height:1.25rem] [&_[data-slot=code-block-line-content]]:[overflow-wrap:anywhere]'

export function ThreadToolDetails({ command, input, output, exitCode, status, ms, loadOutput }: {
  command?: string
  input?: string
  output?: string
  exitCode?: number
  /** The call's lifecycle for the shell box's footer (#2923): running · done · failed · stopped. */
  status?: 'running' | 'done' | 'failed' | 'stopped'
  ms?: number
  /** Fetches the call's full output when the tail was clipped; shown on demand. */
  loadOutput?: () => Promise<string>
}) {
  const t = useTranslations('Coordinator.activity.card')
  const [full, setFull] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const shown = full ?? output
  const outputLines = useMemo(() => command && shown ? ansiToLines(shown.replace(/\r?\n$/, '')) : undefined, [command, shown])
  const seconds = ms !== undefined ? (ms / 1000).toFixed(1) : undefined
  // ✓ 成功 / 运行中 · 时长 / exit N — one state line, bottom right.
  const state = status === 'running' ? t('running')
    : exitCode !== undefined && exitCode !== 0 ? t('exitCode', { code: exitCode })
    : status === 'failed' ? t('failed')
    : status === 'stopped' ? t('stopped')
    : t('succeeded')
  const failed = status === 'failed' || (exitCode !== undefined && exitCode !== 0)

  if (command) return <CodeBlock size="sm" className="border-border bg-card" data-thread-tool-details="" data-thread-terminal="">
    <CodeBlockHeader className="pb-0"><CodeBlockTitle>{t('shell')}</CodeBlockTitle></CodeBlockHeader>
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
      {status === 'running' && !outputLines && <div className="shrink-0 text-xs text-muted-foreground">{t('waiting')}</div>}
    </div>
    <CodeBlockFooter className={cn('justify-end pb-2 tabular-nums', failed && 'text-destructive-foreground')}>
      {loadOutput && full === null && <Button type="button" variant="bare" size="bare" disabled={loading} onClick={() => { setLoading(true); void loadOutput().then(setFull).finally(() => setLoading(false)) }}
        className="me-auto text-muted-foreground underline-offset-2 hover:underline disabled:opacity-60" data-thread-tool-load="">
        {loading ? t('loadingOutput') : t('fullOutput')}
      </Button>}
      {seconds && `${seconds}s · `}{state}
    </CodeBlockFooter>
  </CodeBlock>

  return <CodeBlock size="sm" data-thread-tool-details="">
    {input && <>
      <CodeBlockHeader><CodeBlockTitle>{t('args')}</CodeBlockTitle></CodeBlockHeader>
      <CodeBlockContent wrap className="max-h-40">{input}</CodeBlockContent>
    </>}
    {shown && <>
      <CodeBlockHeader><CodeBlockTitle>{t('result')}</CodeBlockTitle></CodeBlockHeader>
      <CodeBlockContent wrap className="max-h-64" data-thread-tool-output="">{shown}</CodeBlockContent>
    </>}
    <CodeBlockFooter className={cn('justify-end tabular-nums', failed && 'text-destructive-foreground')}>
      {loadOutput && full === null && <Button type="button" variant="bare" size="bare" disabled={loading} onClick={() => { setLoading(true); void loadOutput().then(setFull).finally(() => setLoading(false)) }}
        className="me-auto text-muted-foreground underline-offset-2 hover:underline disabled:opacity-60" data-thread-tool-load="">
        {loading ? t('loadingOutput') : t('fullOutput')}
      </Button>}
      {seconds && `${seconds}s · `}{state}
    </CodeBlockFooter>
  </CodeBlock>
}

'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { threadStepOutput, threadStepStatus, type ThreadStep } from '@/lib/issue-run-conversation'
import { toolTitle } from '@/lib/tool-title'
import type { ThreadToolRow } from '@/components/slots/thread-contract'

const COMMAND_LINE_MAX = 160
/** The workspace root as a search's path names it. */
const ROOT = /^(?:\.\/?|\/)?$/
export const isWorkspaceRoot = (path: string) => ROOT.test(path.trim())

/** A command as one row: its first line with spaces collapsed, cut where a row ends. */
export function commandLine(command: string) {
  const line = command.trim().split('\n')[0].replace(/\s+/g, ' ')
  return line.length > COMMAND_LINE_MAX ? `${line.slice(0, COMMAND_LINE_MAX - 1)}…` : line
}

/**
 * A run's tool calls as the thread's rows (#2923, #2937), as Claude Code names them: the tool's English title, whatever
 * the UI language (Alex, 2026-11-22), then what it acted on: 「Read file · a.ts」, 「Search · "redirect" in lib/auth」, 「Run command · pnpm lint:ui · 退出码 1」.
 * A tool with no kind keeps the input that says what it did.
 */
export function useThreadStepRows() {
  const t = useTranslations('IssueThreads.tool')
  return (steps: readonly ThreadStep[], runActive: boolean): ThreadToolRow[] => steps.map(step => {
    const status = threadStepStatus(step, runActive)
    const command = step.command ? commandLine(step.command) : undefined
    // A search quotes what it looked for, and names the folder unless it searched the workspace root: 「"redirect" in lib/auth」.
    const scope = step.scope && !ROOT.test(step.scope) ? step.scope : undefined
    const search = step.kind === 'search' && step.target ? scope ? t('searchIn', { target: step.target, scope }) : t('search', { target: step.target }) : undefined
    const note = (step.kind === 'shell' ? command : undefined) ?? search ?? step.target ?? step.detail ?? undefined
    const failedCode = status === 'failed' && step.kind === 'shell' && typeof step.exitCode === 'number' ? t('exitCode', { code: step.exitCode }) : undefined
    const output = threadStepOutput(step)
    return {
      id: step.id, label: toolTitle(step.name), kind: step.kind,
      status: status === 'ok' ? 'done' : status === 'cancelled' ? 'stopped' : status,
      ...(step.ms !== undefined ? { ms: step.ms } : {}),
      ...(note ? { note } : {}),
      ...(failedCode ? { error: failedCode } : {}),
      ...(step.target ? { target: step.target } : {}),
      ...(step.command ? { command: step.command } : {}),
      ...(step.input && !step.command ? { input: step.input } : {}),
      ...(output ? { detail: output } : {}),
      ...(typeof step.exitCode === 'number' ? { exitCode: step.exitCode } : {}),
      ...(step.outputTruncated ? { outputTruncated: true } : {}),
    }
  })
}

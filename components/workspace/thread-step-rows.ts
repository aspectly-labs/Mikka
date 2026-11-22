'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { threadStepOutput, threadStepStatus, type ThreadStep } from '@/lib/issue-run-conversation'
import type { ThreadToolRow } from '@/components/slots/thread-contract'

const COMMAND_LINE_MAX = 160

/** A command as one row: its first line with spaces collapsed, cut where a row ends. */
export function commandLine(command: string) {
  const line = command.trim().split('\n')[0].replace(/\s+/g, ' ')
  return line.length > COMMAND_LINE_MAX ? `${line.slice(0, COMMAND_LINE_MAX - 1)}…` : line
}

/**
 * A run's tool calls as the thread's rows (#2923), named from their structured fields (#2937), as Codex does:
 * 「已读取 a.ts」, 「已在 components 中搜索 “Loading”」, a command as itself, 「命令失败 (pnpm lint:ui) · exit 1」.
 * A tool with no kind keeps its name and the input that says what it did.
 */
export function useThreadStepRows() {
  const t = useTranslations('IssueThreads.tool')
  return (steps: readonly ThreadStep[], runActive: boolean): ThreadToolRow[] => steps.map(step => {
    const status = threadStepStatus(step, runActive)
    const target = step.target
    const command = step.command ? commandLine(step.command) : undefined
    const label = step.kind === 'shell' && command
      ? status === 'failed' ? typeof step.exitCode === 'number' ? t('commandFailedCode', { command, code: step.exitCode }) : t('commandFailed', { command }) : command
      : step.kind === 'read' && target ? t('read', { target })
      : step.kind === 'search' && target ? step.scope ? t('searchIn', { target, scope: step.scope }) : t('search', { target })
      : step.kind === 'edit' && target ? t('edit', { target })
      : step.kind === 'web' && target ? t('web', { target })
      : step.kind === 'delegate' && target ? t('delegate', { target })
      : step.kind === 'todo' ? t('todo')
      : step.name
    const named = label !== step.name
    const output = threadStepOutput(step)
    return {
      id: step.id, label, kind: step.kind,
      status: status === 'ok' ? 'done' : status === 'cancelled' ? 'stopped' : status,
      ...(step.ms !== undefined ? { ms: step.ms } : {}),
      ...(!named && step.detail ? { note: step.detail } : {}),
      ...(step.command ? { command: step.command } : {}),
      ...(output ? { detail: output } : {}),
      ...(typeof step.exitCode === 'number' ? { exitCode: step.exitCode } : {}),
      ...(step.outputTruncated ? { outputTruncated: true } : {}),
    }
  })
}

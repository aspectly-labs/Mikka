import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { planSpec, planSplit } from '@mikka/protocol/plan'
import type { RunReport } from '@mikka/protocol/run'
import type { EveFactoryDispatchRole } from './contract'

/**
 * #3082: the structured result an Eve Factory role turn must emit as its
 * final `result` part. It maps onto the same RunReport shape the native
 * workers hand in, so `persistRunCompletion`, the Factory gates and the
 * canonical execution envelope consume it unchanged.
 */
export const eveFactoryRoleResultSchema = z.strictObject({
  summary: z.string().max(10_000),
  filesChanged: z.array(z.string().trim().min(1).max(1_000)).max(200).default([]),
  /** Implementer only: the real outcome of the repo's verify/test command it
   * executed in its sandbox, with output. 'not_run' is honest; the check
   * stages remain independent. */
  verifyStatus: z.enum(['passed', 'failed', 'not_run']).default('not_run'),
  verifyCommand: z.string().trim().max(2_000).optional(),
  verifyOutput: z.string().max(10_000).optional(),
  criteria: z.array(z.strictObject({
    criterionId: z.uuid().optional(),
    text: z.string().max(2_000),
    status: z.enum(['passed', 'failed', 'unverified']),
    reason: z.string().trim().min(1).max(2_000).optional(),
    evidence: z.string().max(10_000).optional(),
    command: z.string().trim().min(1).max(2_000).optional(),
    exitCode: z.number().int().nullable().optional(),
  })).max(200).default([]),
  /** Reviewer only: the single-review verdict the Factory check consumes. */
  reviewVerdict: z.enum(['passed', 'changes_requested', 'needs_judgment']).optional(),
  /** Analyst only: the spec card the owner approves before execute. */
  spec: planSpec.optional(),
  split: planSplit.optional(),
  openQuestions: z.array(z.string().max(2_000)).max(50).default([]),
  nextStep: z.string().max(2_000).nullable().default(null),
})
export type EveFactoryRoleResult = z.infer<typeof eveFactoryRoleResultSchema>

/** Extract the turn's typed result from its projected messages; missing or
 * malformed results fail closed — a role turn without a structured result is
 * a failed turn, never a partial pass. */
export function eveFactoryResultFromMessages(messages: unknown[] | undefined): EveFactoryRoleResult | null {
  const results = (messages ?? []).flatMap(message => {
    if (!message || typeof message !== 'object') return []
    const content = (message as Record<string, unknown>).content
    if (!Array.isArray(content)) return []
    return content.flatMap(part => {
      if (!part || typeof part !== 'object') return []
      const record = part as Record<string, unknown>
      return record.kind === 'result' || record.type === 'result' ? [record.value] : []
    })
  })
  for (const value of results.reverse()) {
    const parsed = eveFactoryRoleResultSchema.safeParse(value)
    if (parsed.success) return parsed.data
  }
  return null
}

/** Daemon-owned fields the adapter captures host-side; when absent the
 * report stays honest (`not_run`, no publish claim) rather than adopting
 * model-supplied claims. */
export interface EveFactoryReportHost {
  headSha: string | null
  branchRefSha: string | null
  filesChanged: string[]
  verify: { status: 'passed' | 'failed' | 'not_run'; command?: string; exitCode?: number | null; signal?: string | null; timedOut?: boolean; output?: string }
  /** The attempt's frozen independent-check assignment. */
  check?: { sha?: string | null; command?: string | null; reportOnly?: boolean } | null
  /** The admitted publication branch for the implementer role. */
  publicationBranch?: string | null
}

export function eveFactoryReportFor(role: EveFactoryDispatchRole, result: EveFactoryRoleResult, host?: EveFactoryReportHost): RunReport {
  const report: RunReport = {
    summary: result.summary,
    // Host-computed working-tree state beats the agent's file list for the
    // reviewer (must be empty) and corroborates it for the implementer.
    filesChanged: host ? host.filesChanged : result.filesChanged,
    verify: role === 'implementer' || (role === 'reviewer' && host?.verify.status !== 'not_run')
      ? (host?.verify.status && host.verify.status !== 'not_run'
          ? { status: host.verify.status, command: host.verify.command ?? result.verifyCommand,
              exitCode: host.verify.exitCode ?? null, signal: host.verify.signal ?? null,
              timedOut: host.verify.timedOut, output: host.verify.output }
          : { status: result.verifyStatus, ...(result.verifyCommand ? { command: result.verifyCommand } : {}), ...(result.verifyOutput ? { output: result.verifyOutput } : {}) })
      : { status: 'not_run' },
    openQuestions: result.openQuestions,
    nextStep: result.nextStep,
  }
  if (role === 'implementer' && host?.publicationBranch) {
    // Host push receipt: only the remote ref actually matching the worktree
    // head counts as pushed; anything else is a publication mismatch the
    // ordinary gate turns into a visible failure, never a silent pass.
    const pushed = Boolean(host.headSha && host.branchRefSha && host.branchRefSha === host.headSha)
    report.publish = {
      branch: host.publicationBranch,
      commit: pushed ? host.headSha! : null,
      pushed,
      remote: pushed ? 'origin' : null,
      ...(pushed ? {} : { note: 'The task branch ref does not match the worktree head; the push did not complete as required.' }),
    }
  }
  if (role === 'reviewer' && host?.check?.sha) {
    // The frozen candidate sha from the check assignment — the reviewer's
    // read-only binding to the exact candidate, like the daemon's receipt.
    report.check = { sha: host.check.sha, readOnly: true }
  }
  if (result.criteria.length) {
    report.criteria = result.criteria.map(criterion => ({
      ...(criterion.criterionId ? { criterionId: criterion.criterionId } : {}),
      text: criterion.text,
      passed: criterion.status === 'passed',
      status: criterion.status,
      ...(criterion.reason ? { reason: criterion.reason } : {}),
      ...(criterion.evidence ? { evidence: criterion.evidence } : {}),
      ...(criterion.command ? { command: criterion.command } : {}),
      ...(criterion.exitCode !== undefined ? { exitCode: criterion.exitCode } : {}),
    }))
  }
  if (role === 'reviewer' && result.reviewVerdict) report.reviewVerdict = result.reviewVerdict
  if (role === 'analyst' && result.spec && result.split) {
    report.plan = { specId: randomUUID(), spec: result.spec, split: result.split }
  }
  return report
}

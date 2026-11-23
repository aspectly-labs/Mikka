import { z } from 'zod'
import type { AuthResult } from 'eve/channels/auth'
import { calls, parts, type SessionView } from 'eve/events'
import { EVE_FACTORY_CONTRACT_VERSION, EVE_FACTORY_DISPATCH_ROLES, type EveFactoryDispatchRole, type EveFactoryPlan } from './contract'

/** The session auth attributes an Eve Factory role session carries. Written
 * by the factory-attempts channel route from the persisted run/attempt rows —
 * never from request bytes. */
export const eveFactorySessionSchema = z.strictObject({
  version: z.literal(EVE_FACTORY_CONTRACT_VERSION),
  runId: z.uuid(),
  taskId: z.uuid(),
  attemptId: z.uuid(),
  role: z.enum(EVE_FACTORY_DISPATCH_ROLES),
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(500),
  effort: z.string().min(1).max(64).nullable(),
  readOnly: z.boolean(),
})
export type EveFactorySession = z.infer<typeof eveFactorySessionSchema>

export function eveFactorySessionAuth(auth: AuthResult | null | undefined): EveFactorySession | null {
  // SessionAuthContext attributes are string-valued; the frozen role plan is
  // carried as its canonical JSON, like the Slack channel does for metadata.
  const raw = auth?.attributes?.eveFactory
  const parsed = eveFactorySessionSchema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw)
  return parsed.success ? parsed.data : null
}

export function eveFactoryScopeAuth(ownerId: string, scope: { botId: string; workspaceId: string }, plan: EveFactoryPlan & {
  runId: string; taskId: string; attemptId: string; readOnly: boolean
}): AuthResult {
  return {
    authenticator: 'mikka', principalType: 'user', principalId: ownerId,
    attributes: {
      botId: scope.botId, workspaceId: scope.workspaceId, surface: 'factory',
      eveFactory: JSON.stringify({
        version: EVE_FACTORY_CONTRACT_VERSION, runId: plan.runId, taskId: plan.taskId, attemptId: plan.attemptId,
        role: plan.role, provider: plan.provider, model: plan.model, effort: plan.effort, readOnly: plan.readOnly,
      }),
    },
  }
}

/** Per-attempt conversation space: an Eve role session never shares history
 * with chat or with another role. */
export const eveFactoryConversationAddress = (input: { ownerId: string; workspaceId: string; taskId: string; attemptId: string }) =>
  JSON.stringify(['mikka-factory', input.ownerId, input.workspaceId, input.taskId, input.attemptId])

const ROLE_POLICY: Record<EveFactoryDispatchRole, string> = {
  analyst: [
    'You are the Analyst in a Software Factory task: turn the task into a concrete, reviewable implementation spec.',
    'You are planning-only. Do not modify files, git state or remotes, and do not create pull requests.',
    'List the acceptance criteria you will hand to the Implementer, one per line, each independently checkable.',
  ].join('\n'),
  implementer: [
    'You are the Implementer in a Software Factory task. Work only inside the admitted task workspace.',
    'The task repository checkout lives at /workspace/repo — clone it there if absent, create or check out the task branch named in this brief, then implement, commit and push that exact branch.',
    'Git credentials are already in the machine; do not print, copy or alter them.',
    'Run the repository verification or test command when one exists and report its real exit result. Never invent test output, never force-push, never push to the base branch, and never create, merge or approve a pull request — publication and acceptance are host-owned.',
    'Stay strictly inside the requested scope; do not edit unrelated files.',
  ].join('\n'),
  reviewer: [
    'You are the independent Reviewer in a Software Factory task. You did not write this code and must not modify it.',
    'The candidate checkout lives at /workspace/repo. Inspect the immutable pushed candidate named in this brief. Record each original acceptance criterion with its real evidence or the specific missing observation. Do not replace, merge away or omit criteria, and do not add requirements the request did not make.',
    'Do not modify source or git state, do not push, and never create, merge or approve a pull request — approval and publication are host-owned.',
    'When an observation is unavailable, report it as unverified with a concrete reason; missing evidence never counts as passed.',
  ].join('\n'),
}

export function eveFactoryRoleInstructions(role: EveFactoryDispatchRole, context: {
  repository?: string | null; branch?: string | null; baseBranch?: string | null; executionSha?: string | null
}) {
  const target = [
    context.repository ? `Repository: ${context.repository}` : null,
    context.branch ? `Task branch: ${context.branch}` : null,
    context.baseBranch ? `Base branch: ${context.baseBranch}` : null,
    context.executionSha ? `Fixed candidate commit: ${context.executionSha}` : null,
  ].filter(Boolean).join('\n')
  return `${ROLE_POLICY[role]}${target ? `\n\n${target}` : ''}`
}

/** Per-role tool catalogue. Reviewer and analyst are read-only: no write or
 * edit tools. Git credentials are never granted to non-implementer roles, so
 * their authority boundary is structural, not instruction-only. */
export const EVE_FACTORY_ROLE_TOOLS: Record<EveFactoryDispatchRole, readonly string[]> = {
  analyst: ['bash', 'read_file', 'glob', 'grep'],
  implementer: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
  reviewer: ['bash', 'read_file', 'glob', 'grep'],
}

/** Like `projectEveTurn` but keeps each turn part, including the role's
 * structured `result` part, so the host settlement can build the RunReport.
 * Nothing here becomes chat history: factory sessions are `surface='factory'`,
 * which `projectTurnState` and outcome delivery skip. */
export function eveFactoryProjectTurn(view: SessionView, sessionId: string, turnId: string) {
  const content = parts(view, { turnId }).flatMap((part): { type: string; text?: string; value?: unknown }[] => {
    if ((part.kind === 'text' || part.kind === 'reasoning') && typeof part.value === 'string') return [{ type: part.kind, text: part.value }]
    if (part.kind === 'result') return [{ type: 'result', value: part.value }]
    return []
  })
  const toolCalls = calls(view, { turnId, kind: 'tool' })
  const calls_ = toolCalls.map(call => ({ type: 'tool-call', toolCallId: call.callId, toolName: call.name, input: call.input ?? {} }))
  return [
    { role: 'assistant', content: [...content, ...calls_], mikkaStreamId: `eve:${sessionId}:${turnId}` },
  ]
}

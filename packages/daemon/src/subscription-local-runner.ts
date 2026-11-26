// A local subscription run receives the same run-bound gateway credential as a cloud task.
import { type RunAssignment } from "@mikka/protocol"
import { CodedError, findCodedError, logCodedError } from "@mikka/protocol/coded-error"
import type { UserErrorDetail } from "@mikka/protocol/user-error-codes"

import { ClaudeAdapter, type ClaudeAdapterOptions } from "./adapters/claude"
import { CodexAdapter, type CodexAdapterOptions } from "./adapters/codex"
import type { AgentSession, StartOptions } from "./adapters/types"
import { isSubscriptionGatewayCredential } from '@mikka/protocol/device'
import { requireRunToolApproval } from "./agents/tool-approval"
import { buildChildEnv } from "./env"
import { taskExecutionEnv } from './task-env'
import { removeRunCredentials } from "./run-scratch"

type Detail = UserErrorDetail<"subscription_local_runtime_unavailable">
/** One code for the UI; the detail says which check failed, the cause is kept (decision 2026-11-05-0330). */
const unavailable = (detail: Detail, cause?: unknown) =>
  new CodedError("subscription_local_runtime_unavailable", { detail, cause })
const isUnavailable = (error: unknown): error is CodedError =>
  error instanceof CodedError && error.code === "subscription_local_runtime_unavailable"
/** A failure inside the adapter keeps the detail of a refusal it wraps (a later lease), else adapter_start_failed. */
const startFailed = (error: unknown) => isUnavailable(error) ? error
  : unavailable((findCodedError(error, "subscription_local_runtime_unavailable")?.detail as Detail | undefined) ?? "adapter_start_failed", error)

type Common = Pick<ClaudeAdapterOptions & CodexAdapterOptions, "sandbox" | "stateDir" | "computerProvider">

export interface LocalSubscriptionHost {
  stateDir: string
  /** Options the daemon's ordinary adapters use (sandbox, binaries, computer). */
  claude: Common & Pick<ClaudeAdapterOptions, "binary" | "ensureBinary">
  codex: Common & Pick<CodexAdapterOptions, "binary" | "ensureBinary">
}

export function createLocalSubscriptionRunner(host: LocalSubscriptionHost) {
  return {
    async start(assignment: RunAssignment, options: StartOptions): Promise<AgentSession> {
      const gate = requireRunToolApproval(options.runId, options.toolApproval)
      const selected = assignment.subscriptionBinding
      const kind = assignment.harness
      const credential = assignment.modelCredential
      const context = assignment.subscriptionContext
      if (!selected || !context || assignment.subscriptionLease || !isSubscriptionGatewayCredential(credential, kind === "codex" ? "openai" : "anthropic") ||
        context.route !== selected.route || options.runId !== assignment.runId || (kind !== "codex" && kind !== "claude_code") ||
        selected.route !== (kind === "codex" ? "codex_cli" : "claude_code_cli") || options.continueSession) throw unavailable("assignment_invalid")
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        removeRunCredentials(host.stateDir, assignment.runId)
      }
      const offRevoke = gate.onRevoke(close)
      try {
        if (!await gate.checkLive()) throw unavailable('run_closed')
        if (options.model !== undefined && context.modelId !== options.model) throw unavailable("model_mismatch")
        const clean = taskExecutionEnv(buildChildEnv({ host: options.env, runId: options.env.MIKKA_RUN_ID === undefined ? undefined : options.runId }), options)
        if (Object.entries(options.env).some(([name, value]) => clean[name] !== value)) throw unavailable("env_not_clean")
        const adapter = kind === "codex" ? new CodexAdapter(host.codex) : new ClaudeAdapter(host.claude)
        let session: AgentSession
        try { session = await adapter.start({ ...options, credential }) }
        catch (error) { throw startFailed(error) }
        const finish = () => { offRevoke(); close() }
        return {
          sessionId: session.sessionId,
          get runtimeModel() { return session.runtimeModel },
          async *events() {
            try { yield* session.events() } finally { finish() }
          },
          send: (text, mode) => session.send(text, mode),
          cancel: async () => { try { await session.cancel() } finally { finish() } },
        }
      } catch (error) {
        offRevoke()
        close()
        const refusal = startFailed(error)
        logCodedError(refusal, { runId: assignment.runId, harness: kind }, options.log)
        throw refusal
      }
    },
  }
}

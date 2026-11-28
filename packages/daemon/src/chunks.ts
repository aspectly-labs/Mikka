import type { RepositoryGitTiming } from './repository-git-timing'
// Run output format: Vercel AI SDK `UIMessageChunk`s (types only, the `ai`
// package is never used to call a model). AI Elements and `useChat` render
// them directly; Mikka-specific facts travel as `data-*` parts.
import type { RunPublish, RunState, StopReason } from "@mikka/protocol"
import type { PlanSection } from "@mikka/protocol/plan"
import type { AvailableCommandsChunkData, SystemEventData } from "@mikka/protocol/slash-commands"
import type { UIMessage, UIMessageChunk } from "ai"
import type { DaemonPreparationTiming, DaemonStartupTiming } from "./tracing"

/** The stages a run goes through before its agent works, in order. */
export type RunStage = "repository" | "worktree" | "agent_start"

export type MikkaDataTypes = {
  /** A file the agent changed, path relative to the worktree root. */
  "file-change": { path: string; change: "added" | "modified" | "deleted" }
  /** Usage as reported by the harness; `source` says where it came from. */
  usage: {
    inputTokens: number
    outputTokens: number
    costUsd: number | null
    source: string
    model?: string
    cacheReadTokens?: number | null
    cacheWriteTokens?: number | null
    turnUsage?: { inputTokens: number; outputTokens: number }
  }
  /** The daemon's commit (and push) of a verified hand-in. */
  publish: RunPublish
  /** Run state transitions written by the daemon. */
  "run-state": { state: RunState; error?: string; stopReason?: StopReason }
  /** One start-up stage of a run and how long it took; stored, so a failed run shows where it stopped. */
  "run-stage": { stage: RunStage; ms: number; ok: boolean; startupTiming?: DaemonStartupTiming; preparationTiming?: DaemonPreparationTiming; repositoryTiming?: RepositoryGitTiming }
  /** A real task is attached to this Bot's desktop, not to an agent identity. */
  computer: { botId: string; runId: string; task: string; state: 'working' }
  /** Runtime-reported slash commands for this thread (ACP AvailableCommand shape, #3333). */
  "available-commands": AvailableCommandsChunkData
  /** System event lines streamed from the harness (local command output, compact status/boundary, blocked command notice, #3333). */
  "system-event": SystemEventData
  /**
   * The spec a `plan` run wrote (ADR ORV-205). `specId` is the row the server
   * stores, so the card reads the spec's live status from there.
   */
  spec: {
    specId: string
    title: string
    summary: string
    sections: PlanSection[]
  }
  /**
   * The split that plan run proposes. Nothing exists yet: a person approves
   * it (`split.approve`) before any issue is created.
   */
  split: {
    specId: string
    summary: string
    issues: {
      key: string
      title: string
      note: string
      criteria: string[]
      blockedBy: string[]
      parentKey?: string
    }[]
  }
}

export type RunChunk = UIMessageChunk<unknown, MikkaDataTypes> & {
  /** Tool input-available to result, measured by the daemon's monotonic clock before batching. */
  toolDurationMs?: number
  /** The adapter kept only the end of a tool's output (the last TOOL_OUTPUT_TAIL_CHARS characters). */
  outputTruncated?: true
  /** Claude Code's TaskCreate: the id its result gave the new task, so a later TaskUpdate finds it in the plan. */
  planTask?: { id: string }
}

/** How much of a tool's output the adapters keep: its end, where a command's result and errors are. */
export const TOOL_OUTPUT_TAIL_CHARS = 4000

/** A tool's output as the adapters store it: the end of the text, marked when the start was cut. */
export function toolOutputTail(text: string): { text: string; truncated: boolean } {
  return text.length > TOOL_OUTPUT_TAIL_CHARS ? { text: text.slice(-TOOL_OUTPUT_TAIL_CHARS), truncated: true } : { text, truncated: false }
}

/** A start-up stage's outcome (stored, unlike `run-state`). */
export function runStageChunk(stage: RunStage, ms: number, ok: boolean, startupTiming?: DaemonStartupTiming,
  preparationTiming?: DaemonPreparationTiming, repositoryTiming?: RepositoryGitTiming): RunChunk {
  return { type: "data-run-stage", data: { stage, ms: Math.max(0, Math.round(ms)), ok,
    ...(stage === "agent_start" && startupTiming ? { startupTiming } : {}),
    ...(stage === "agent_start" && preparationTiming ? { preparationTiming } : {}),
    ...(stage === "repository" && repositoryTiming ? { repositoryTiming } : {}) } }
}
export type RunMessage = UIMessage<unknown, MikkaDataTypes>

export function runStateChunk(
  state: RunState,
  error?: string,
  stopReason?: StopReason
): RunChunk {
  return {
    type: "data-run-state",
    // Relayed live, never stored in a message (ADR 0018).
    transient: true,
    data: {
      state,
      ...(error ? { error } : {}),
      ...(stopReason ? { stopReason } : {}),
    },
  }
}

/** Light structural check for chunks read from disk or fixtures. */
export function isRunChunk(value: unknown): value is RunChunk {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  )
}

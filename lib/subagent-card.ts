import { AGENT_NAMES } from './agent-no-model'
import { RUN_MARK_STATUSES, profileMarkStateOfStatus, resolveProfileMark, runMarkStatusOf, type ProfileMarkValue, type RunMarkStatus } from './factory/agent-profile-mark'
import { modelDisplayName } from './model-display-name'

/**
 * A dispatched sub-agent as one card (Figma "Chat+右栏" section 22, #2932 / #2939): its ProfileMark, name, model,
 * status, and the one line it was handed. Client-safe: the server read (lib/subagent-runs.ts) and both renderers use it.
 */

/** The card's status labels (运行中 / 等你 / 完成 / 失败 / 排队), the same mapping as the ProfileMark states of section 21. */
export const SUBAGENT_STATUSES = RUN_MARK_STATUSES
export type SubagentStatus = RunMarkStatus
export { runMarkStatusOf as subagentStatusOf, profileMarkStateOfStatus as subagentMarkState }

export type SubagentCard = {
  /** The sub-agent's run: a click opens its thread. */
  id: string
  /** Its Agent Profile's name, or the Agent (Claude Code, Codex) when it ran without a custom Profile. */
  name: string
  profile: ProfileMarkValue
  /** The model's display name; null while it has none on record. */
  model: string | null
  status: SubagentStatus
  /** What it was handed, in one line; null when the dispatcher wrote none. */
  brief: string | null
}

/** What the server read projects for a run that has a sub-agent card; the renderers fill the rest from the run. */
export type SubagentFacts = {
  /** The custom Agent Profile the run used, with its stored mark; null for Default and runs before Profiles. */
  profile: ({ name: string } & ProfileMarkValue) | null
  /** The model it ran on (observed) or was dispatched with; a raw id. */
  model: string | null
  brief: string | null
}

/** The Agent's own name for a harness id; an unknown id stays as it is. */
export const agentName = (harness: string) => (AGENT_NAMES as Record<string, string>)[harness] ?? harness

/**
 * A run's card. Without a custom Profile it is named for its Agent and draws the mark derived from that name, the same
 * steady mark a Profile without a chosen one gets (resolveProfileMark).
 */
export function subagentCardOf(run: { id: string; harness: string; status: string; outcome?: string | null; stopReason?: string | null; subagent?: SubagentFacts }): SubagentCard {
  const facts = run.subagent
  const name = facts?.profile?.name ?? agentName(run.harness)
  const profile = facts?.profile ? { icon: facts.profile.icon, color: facts.profile.color } : resolveProfileMark({ name })
  return {
    id: run.id, name, profile, status: runMarkStatusOf(run),
    model: facts?.model ? modelDisplayName(facts.model).name : null,
    brief: facts?.brief?.trim() || null,
  }
}

/** The block's summary counts, in the order the labels read; statuses with none are left out. */
export function subagentCounts(cards: readonly Pick<SubagentCard, 'status'>[]): { status: SubagentStatus; count: number }[] {
  return SUBAGENT_STATUSES.map(status => ({ status, count: cards.filter(card => card.status === status).length })).filter(row => row.count > 0)
}

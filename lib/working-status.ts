import type { ActiveAgent } from '@/lib/active-agents'

export type Worker = { id: string; kind: ActiveAgent['kind']; name: string; color?: string; shape?: string }
export type WorkingLabel =
  | { key: 'one'; values: { a: string } }
  | { key: 'two'; values: { a: string; b: string } }
  | { key: 'three'; values: { a: string; b: string; c: string } }
  | { key: 'many'; values: { a: string; b: string; count: number } }

export const MAX_WORKING_AVATARS = 3

/** "working" entries of the poll become the strip's workers, earliest start first. */
export function activeToWorkers(agents: ActiveAgent[] | undefined): Worker[] {
  return (agents ?? []).filter(agent => agent.state === 'working').map(agent => ({ id: agent.id, kind: agent.kind, name: agent.name, color: agent.color, shape: agent.shape }))
}

/** Picks the message key and ICU params for the names of who is working. */
export function workingLabel(names: string[]): WorkingLabel | null {
  const [a, b, c] = names
  if (!a) return null
  if (!b) return { key: 'one', values: { a } }
  if (!c) return { key: 'two', values: { a, b } }
  if (names.length === 3) return { key: 'three', values: { a, b, c } }
  return { key: 'many', values: { a, b, count: names.length - 2 } }
}

/** Splits workers into the avatars shown and the "+N" overflow count. */
export function workingAvatars<T>(workers: T[]) {
  return { shown: workers.slice(0, MAX_WORKING_AVATARS), overflow: Math.max(0, workers.length - MAX_WORKING_AVATARS) }
}

/** Stable identity for a set of workers, so equal polls do not replay the roll. */
export function workersKey(workers: Worker[]) {
  return workers.map(worker => worker.id).join('|')
}

export const WORKING_POLL_MS = 10_000

/**
 * The account-wide activity feed cannot be driven by this group's live channel
 * alone — work finishing in another group bumps no revision here. So the strip
 * polls, but only while someone is known to be working: idle chats read nothing.
 */
export function workingPollMs(page: { agents: ActiveAgent[] } | undefined): number {
  return page && page.agents.length > 0 ? WORKING_POLL_MS : 0
}

/** A live revision the strip has not seen before asks for a refetch, the first sighting included:
 * a bot may start between the mount read and the first group history read, and no later event reveals it. */
export function revisionChanged(last: number | undefined, revision: number | undefined): boolean {
  return revision !== undefined && last !== revision
}

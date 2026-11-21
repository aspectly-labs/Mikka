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

import { z } from 'zod'

export const THREAD_HISTORY_PAGE_SIZE = 500

export const threadHistoryPosition = z.strictObject({
  at: z.iso.datetime(),
  lane: z.union([z.literal(0), z.literal(1)]),
  runId: z.uuid(),
  // Negative too: a fork's copied history holds negative seqs (#2936).
  seq: z.number().int(),
  id: z.uuid(),
})
export type ThreadHistoryPosition = z.infer<typeof threadHistoryPosition>

export const threadHistoryInput = z.strictObject({
  kind: z.literal('history'),
  after: z.strictObject({ chain: z.string().max(4000), count: z.number().int().nonnegative(), position: threadHistoryPosition }).optional(),
})
export type ThreadHistoryInput = z.infer<typeof threadHistoryInput>

export type ThreadHistoryPage = {
  chain: string
  count: number
  before: ThreadHistoryPosition | null
  latest: ThreadHistoryPosition | null
  append: boolean
}

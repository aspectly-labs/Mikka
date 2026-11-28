import { z } from 'zod'

export const runCandidate = z.strictObject({ id: z.string().max(300), issueId: z.string().max(100), kind: z.enum(['awaiting', 'failed', 'finished']) })
// A merged pull request names its thread; a mention names its group message. Both are re-read here.
export const mergedCandidate = z.strictObject({ id: z.string().max(300), kind: z.literal('merged'), runId: z.string().max(100) })
export const mentionCandidate = z.strictObject({ id: z.string().max(300), kind: z.literal('mentioned'), messageId: z.uuid() })
export const candidatesSchema = z.array(z.union([runCandidate, mergedCandidate, mentionCandidate])).max(20)

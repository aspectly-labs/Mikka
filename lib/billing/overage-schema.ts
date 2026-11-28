import { z } from 'zod'

export const overageInputSchema = z.object({
  enabled: z.boolean(),
  monthlyCapPoints: z.number().int().min(0).max(100_000_000).nullable(),
  expectedRevision: z.number().int().nonnegative(),
}).strict()

export type OverageInput = z.infer<typeof overageInputSchema>

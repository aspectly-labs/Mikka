import { z } from 'zod'

export const autoRechargeInputSchema = z.object({
  enabled: z.boolean(),
  consent: z.boolean().default(false),
  expectedRevision: z.number().int().nonnegative(),
  thresholdPoints: z.number().int().min(0).max(100_000_000),
  amountPoints: z.union([z.literal(1000), z.literal(2500), z.literal(5000)]),
  monthlyCapPoints: z.number().int().min(1000).max(100_000_000),
}).strict()
  .refine(value => value.thresholdPoints < value.amountPoints && value.monthlyCapPoints >= value.amountPoints)
  .refine(value => !value.enabled || value.consent)

export type AutoRechargeInput = z.infer<typeof autoRechargeInputSchema>

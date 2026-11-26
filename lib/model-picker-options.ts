import { z } from 'zod'
import { MODEL_ROUTING_EFFORTS, MODEL_SERVICE_TIERS } from './model-routing'
import { modesConflict } from './model-capabilities'

export const modelModesSchema = z.strictObject({
  fast: z.boolean(), ultrafast: z.boolean(), pro: z.boolean(), daybreak: z.boolean(),
}).refine(modes => !modesConflict(modes))

export const chatModelOptionsSchema = z.strictObject({
  effort: z.enum(MODEL_ROUTING_EFFORTS).nullable().optional(),
  serviceTier: z.enum(MODEL_SERVICE_TIERS).nullable().optional(),
  modes: modelModesSchema.optional(),
})

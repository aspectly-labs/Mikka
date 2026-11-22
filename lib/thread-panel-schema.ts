import { z } from 'zod'

/** The right column's per-thread layout contract (#2935), shared by the route
 * and the store without pulling database modules into its readers. */
export const threadPanelStateSchema = z.object({
  tabs: z.array(z.string().min(1).max(100)).max(20),
  active: z.string().max(100),
  open: z.boolean(),
}).strict()

export type ThreadPanelState = z.infer<typeof threadPanelStateSchema>

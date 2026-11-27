import { z } from 'zod'
import { completedCiSuite } from './ci-suite-event'

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const pullEvent = z.object({
  installation: z.object({ id }), repository: z.object({ id, full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
  action: z.string(), pull_request: z.object({ number: id, state: z.literal('open'), mergeable: z.boolean().nullable().optional(), head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }).optional() }),
  sender: z.object({ type: z.string() }).optional(),
})
type Preference = 'prWakeOnReview' | 'prWakeOnCiFailure' | 'prWakeOnConflict'
export function pullWakeEvent(event: string, payload: unknown) {
  const suite = completedCiSuite(event, payload)
  if (suite && ['failure', 'timed_out', 'action_required'].includes(suite.conclusion)) {
    return { preference: 'prWakeOnCiFailure' as const, ...suite }
  }
  const parsed = pullEvent.safeParse(payload)
  if (!parsed.success) return null
  const { action, repository, installation, pull_request: pull, sender } = parsed.data
  let preference: Preference
  if (event === 'pull_request_review_comment' && action === 'created' && sender?.type !== 'Bot') preference = 'prWakeOnReview'
  else if (event === 'pull_request' && ['synchronize', 'reopened', 'edited'].includes(action) && pull.mergeable !== true && (pull.mergeable === false || pull.head)) preference = 'prWakeOnConflict'
  else return null
  return { preference, repository: repository.full_name, repositoryId: repository.id, installationId: installation.id, numbers: [pull.number], headSha: pull.head?.sha.toLowerCase(), checkConflict: preference === 'prWakeOnConflict' && pull.mergeable == null }
}

export type PullWakeEvent = NonNullable<ReturnType<typeof pullWakeEvent>>

import { z } from 'zod'
import { previewCheckpointRestore } from '@/lib/coding-workspace/git/restore'
import { gitEnvelope, gitHttp } from '@/lib/coding-workspace/git/http'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 60
const command = gitEnvelope.extend({ operationId: z.uuid(), checkpointId: z.string().min(1).max(80) })

const gitPost = gitHttp(async ({ actor, input, runId, repoId, request }) => {
  const value = command.parse(input)
  return { value: await previewCheckpointRestore({ database: pool, membership: workspacePool }, actor, runId, repoId,
    { operationId: value.operationId, checkpointId: value.checkpointId }, request.signal) }
})
export const POST = defineRoute<'session', 'pat-scoped', { runId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    write: true,
  },
  ({ request, params }) => gitPost(request, { params: Promise.resolve(params) }),
)

import { z } from 'zod'
import { applyRevert } from '@/lib/coding-workspace/git/revert'
import { gitEnvelope, gitHttp } from '@/lib/coding-workspace/git/http'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 60
const command = gitEnvelope.extend({ operationId: z.uuid() })

const gitPost = gitHttp(async ({ actor, input, runId, repoId, request }) => {
  const value = command.parse(input)
  return { value: await applyRevert({ database: pool, membership: workspacePool }, actor, runId, repoId,
    { operationId: value.operationId }, request.signal) }
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

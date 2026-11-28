import { z } from 'zod'
import { gitRevertTarget } from '@mikka/protocol/coding-workspace-git'
import { previewRevert } from '@/lib/coding-workspace/git/revert'
import { gitEnvelope, gitHttp } from '@/lib/coding-workspace/git/http'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 30
const command = gitEnvelope.extend({ operationId: z.uuid(), snapshotId: z.uuid(), path: z.string().min(1).max(1024), target: gitRevertTarget })

const gitPost = gitHttp(async ({ actor, input, runId, repoId, request }) => {
  const value = command.parse(input)
  return { value: await previewRevert({ database: pool, membership: workspacePool }, actor, runId, repoId,
    { operationId: value.operationId, snapshotId: value.snapshotId, path: value.path, target: value.target }, request.signal) }
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

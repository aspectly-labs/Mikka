import 'server-only'
import type { Pool } from 'pg'

/**
 * What the thread's summary header needs beyond the machine read
 * (lib/thread-machine-view.ts): the repository the run checked out, the branch
 * it works on, and the machine template kind (the `size` of {kind,size,state} —
 * snapshotId otherwise). One read over the chain's live run; only the thread's
 * owner may ever see these fields, enforced by every caller.
 */
export interface ThreadSummaryLocation {
  repository: string | null
  branch: string | null
  machineSize: string | null
}

export async function readThreadLocation(pool: Pool, ownerId: string, runId: string): Promise<ThreadSummaryLocation> {
  const { rows: [row] } = await pool.query<{
    remoteUrl: string | null; repoPath: string | null; baseBranch: string | null;
    templateKind: string | null; snapshotId: string | null; publicationBranch: string | null
  }>(`SELECT dr."remoteUrl", dr."repoPath", r."baseBranch",
      tm."templateKind", tm."snapshotId",
      (SELECT p.branch FROM run_publications p WHERE p."runId"=r.id) AS "publicationBranch"
    FROM agent_runs r
    LEFT JOIN device_repos dr ON dr.id = r."deviceRepoId"
    LEFT JOIN thread_machines tm ON tm."runId" = r.id AND tm."ownerId" = r."userId"
    WHERE r.id = $1 AND r."userId" = $2`, [runId, ownerId])
  return {
    repository: row?.remoteUrl ?? row?.repoPath ?? null,
    branch: row?.publicationBranch ?? row?.baseBranch ?? null,
    machineSize: row?.templateKind ?? row?.snapshotId ?? null,
  }
}

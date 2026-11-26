import { parseMachineSku, type MachineProvider, type MachineSku } from './machine-pricing'

export const cloudflareTaskMachineSource = 'cloudflare-task-v1'

type FrozenTaskPlacement = {
  taskCompute?: MachineSku
  taskMachine?: unknown
}

/** Admission freezes an explicit selection. Historical rows only have the
 * Cloudflare grant, and continue to use the provider that issued it. */
export function admittedTaskCompute(definition: FrozenTaskPlacement | null | undefined): {
  provider: MachineProvider
  sku: MachineSku | null
} | null {
  const placement = definition?.taskCompute
  const grantProvider = definition?.taskMachine ? 'cloudflare' : 'e2b'
  if (placement === undefined) return { provider: grantProvider, sku: null }
  const sku = parseMachineSku(placement?.provider, placement?.size)
  return sku?.provider === grantProvider ? { provider: sku.provider, sku } : null
}

/** Recovery follows the allocated resource even after admission settings change. */
export function allocatedTaskProvider(machine: { snapshotId?: string | null }): MachineProvider {
  return machine.snapshotId === cloudflareTaskMachineSource ? 'cloudflare' : 'e2b'
}

type PreviousTaskSource = {
  runId: string
  state: string
  snapshotId: string
  capture: string | null
  size: string | null
}

/** Read the last incarnation that may contain task files. A never-started
 * admission has no workspace authority and must not obscure an older VM. */
export async function previousTaskComputeSource(query: Pick<import('pg').Pool, 'query'>, scope: {
  ownerId: string
  workspaceId: string
  issueId: string
  runId: string
  repositoryKey: string
}): Promise<PreviousTaskSource | null> {
  const { rows: [source] } = await query.query<PreviousTaskSource>(`
    SELECT m."runId",m.state,m."snapshotId",m.lifecycle->>'portableWorkspaceCapture' AS capture,
      COALESCE(m.lifecycle->>'sponsoredSize', l.size, r."agentDefinition"#>>'{taskCompute,size}') AS size
    FROM thread_machines m
    JOIN agent_runs r ON r.id=m."runId" AND r."userId"=m."ownerId"
    JOIN agent_runs target ON target.id=$4 AND target."userId"=m."ownerId"
    JOIN device_repos repo ON repo.id=m."repoId" AND repo."userId"=m."ownerId"
    LEFT JOIN e2b_compute_leases l ON l."sandboxId"=m."sandboxId" AND l."ownerId"=m."ownerId"
    WHERE m."ownerId"=$1 AND m."workspaceId"=$2 AND m."issueId"=$3
      AND r."workspaceId"=$2 AND repo."repoPath"=$5
      AND r."agentDefinition"->'readOnly' IS DISTINCT FROM 'true'::jsonb
      AND (r."createdAt",r.id)<(target."createdAt",target.id)
      AND (m."sandboxId" IS NOT NULL OR m."runningSince" IS NOT NULL OR m.lifecycle ? 'portableWorkspaceCapture')
    ORDER BY r."createdAt" DESC,r.id DESC LIMIT 1`,
  [scope.ownerId, scope.workspaceId, scope.issueId, scope.runId, scope.repositoryKey])
  return source ?? null
}

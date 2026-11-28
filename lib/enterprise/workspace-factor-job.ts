import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'

// This scope identifies the member of an already admitted job for workspace
// enrollment checks. It carries no credential for organization MFA or SSO.
const jobs = new AsyncLocalStorage<{ userId: string; workspaceId: string; active: boolean }>()
export async function withWorkspaceFactorJob<T>(userId: string, workspaceId: string, work: () => Promise<T>): Promise<T> {
  const job = { userId, workspaceId, active: true }
  try { return await jobs.run(job, work) } finally { job.active = false }
}

export function workspaceFactorJobMatches(userId: string, workspaceId: string) {
  const job = jobs.getStore()
  return job?.active && job.userId === userId && job.workspaceId === workspaceId
}

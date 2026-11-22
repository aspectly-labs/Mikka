import { withBasePath } from '@/lib/base-path'

/** One entry of a workspace's team-skill registry (`improvement_skill_versions` joined with its
 * team metadata): the artifact's sha256 is the review handle approve/withdraw must echo. */
export type TeamSkillEntry = {
  versionId: string
  skillId: string
  catalogOwnerId: string
  name: string
  description: string
  license: string | null
  source: string
  createdAt: string
  artifact: { sha256: string; format: string }
  status: 'pending' | 'approved' | 'withdrawn'
}

export class TeamSkillRequestError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'TeamSkillRequestError' }
}

async function readBody(response: Response) {
  const result = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new TeamSkillRequestError(result?.error ?? `http_${response.status}`)
  return result
}

/** The workspace's team-skill registry. `inspect` (admins only) adds pending and withdrawn
 * entries; members always get the approved-only list either way. */
export async function listTeamSkills(workspaceId: string, inspect: boolean): Promise<TeamSkillEntry[]> {
  const response = await fetch(withBasePath(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills${inspect ? '?inspect=1' : ''}`), {
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000),
  })
  return await readBody(response) as TeamSkillEntry[]
}

/** Approve or withdraw one registered version; the sha256 binds the review to the exact artifact. */
export async function reviewTeamSkill(workspaceId: string, input: { versionId: string; sha256: string; operation: 'approve' | 'withdraw' }): Promise<unknown> {
  const response = await fetch(withBasePath(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills`), {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify(input),
  })
  return await readBody(response)
}

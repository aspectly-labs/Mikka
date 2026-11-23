import 'server-only'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { appCallAllowed } from './app-permission-keys'
import { permissionDecision } from './permission-precedence'

type SettingLayers = { workspace: unknown } | null

const layer = z.record(z.string(), z.enum(['allow', 'ask', 'deny'])).nullable().optional()

/** The workspace's write settings for this Bot. Identity comes from the host, never a tool argument. */
async function readWorkspacePermissions(userId: string, botId: string | null): Promise<SettingLayers> {
  if (!botId) return null
  const { rows } = await db.execute(sql`select w.external_write_permissions as workspace from bots b left join workspace_computer_policies w on w."workspaceId" = b."workspaceId" where b.id=${botId} and b."ownerId"=${userId}`)
  return (rows[0] as { workspace: unknown } | undefined) ?? null
}

/** The layers are injectable so a database error and malformed stored settings are testable. */
export type GitHubCallPolicyDeps = {
  layers?: (userId: string, botId: string | null) => Promise<SettingLayers>
}

/** `unavailable` is a distinct outcome: the policy could not be read, so it is
 * neither an explicit deny nor an allow. Callers must not report it as a denial. */
export type GitHubCallPolicy = 'allow' | 'deny' | 'unavailable'

/** GitHub tools act with the person's own credential; an app-level deny blocks a call.
 * `github_tools` still lists names so the model can explain why it cannot act.
 * Settings that cannot be read fail closed: a database error or malformed stored
 * layer must never turn an explicit deny into an allow. */
export async function githubCallDecision(userId: string, botId: string | null, deps: GitHubCallPolicyDeps = {}): Promise<GitHubCallPolicy> {
  try {
    const layers = await (deps.layers ?? readWorkspacePermissions)(userId, botId)
    const workspace = layer.parse(layers?.workspace) ?? {}
    const decision = permissionDecision(Object.hasOwn(workspace, 'github') ? [workspace['github']] : [])
    return appCallAllowed(decision) ? 'allow' : 'deny'
  } catch {
    return 'unavailable'
  }
}

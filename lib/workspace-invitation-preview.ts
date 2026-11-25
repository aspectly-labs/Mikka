import 'server-only'
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { organizations, organizationWorkspaces } from '@/lib/db/governance-schema'
import { workspaceInvitations, workspaceMembers, workspaces } from '@/lib/db/workspace-schema'
import { workspaceDb } from '@/lib/workspace-db'
import {
  hashInvitationToken,
  normalizeInviterName,
  parseInvitationToken,
  type WorkspaceInvitationPreview,
} from '@/lib/invitation-preview-token'

export type { WorkspaceInvitationPreview }

/**
 * Non-sensitive preview for a pending, unexpired team-workspace invitation.
 * Never returns recipient email, workspaceId, userId, or expiry metadata.
 */
export async function previewWorkspaceInvitation(token: string): Promise<WorkspaceInvitationPreview | null> {
  const valid = parseInvitationToken(token)
  if (!valid) return null
  const [row] = await workspaceDb
    .select({
      workspaceName: workspaces.name,
      inviterName: workspaceMembers.name,
      role: workspaceInvitations.role,
    })
    .from(workspaceInvitations)
    .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
    .leftJoin(organizationWorkspaces, eq(organizationWorkspaces.workspaceId, workspaces.id))
    .leftJoin(organizations, eq(organizations.id, organizationWorkspaces.organizationId))
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workspaceInvitations.workspaceId),
        eq(workspaceMembers.userId, workspaceInvitations.userId),
        eq(workspaceMembers.status, 'active'),
      ),
    )
    .where(
      and(
        eq(workspaceInvitations.tokenHash, hashInvitationToken(valid)),
        eq(workspaceInvitations.status, 'pending'),
        gt(workspaceInvitations.expiresAt, sql`CURRENT_TIMESTAMP`),
        eq(workspaces.kind, 'team'),
        or(isNull(organizationWorkspaces.organizationId), isNull(organizations.archivedAt)),
      ),
    )
    .limit(1)
  if (!row) return null
  return {
    workspaceName: row.workspaceName,
    inviterName: normalizeInviterName(row.inviterName),
    role: row.role,
  }
}

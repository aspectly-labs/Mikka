import { createHash } from 'node:crypto'

export const INVITATION_TOKEN_RE = /^[a-f0-9]{64}$/

export type WorkspaceInvitationPreview = {
  workspaceName: string
  inviterName: string | null
  role: 'admin' | 'member'
}

export type OrganizationInvitationPreview = {
  organizationName: string
  inviterName: string | null
  role: 'admin' | 'member'
}

/** Validates the 64-char hex format shared by workspace and organization invitation tokens. */
export function parseInvitationToken(token: unknown): string | null {
  return typeof token === 'string' && INVITATION_TOKEN_RE.test(token) ? token : null
}

/** SHA-256 hex digest matching stored `tokenHash` columns. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function normalizeInviterName(name: string | null | undefined): string | null {
  const trimmed = name?.trim()
  return trimmed ? trimmed : null
}

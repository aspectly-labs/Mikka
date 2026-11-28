// The HTTP client for the Organization and governance routes (#1608 P2, #1642).
// It is the interface those routes publish, shared by the official UI's hooks
// (mikka-hosted-ui core/hooks/settings/) and this repository's own tests: the
// page's client, exactly as it runs in the browser. Every check happens on the
// server; nothing here is optimistic.
import type { SharedResourceKind } from '@/lib/db/governance-schema'
import { withBasePath } from '@/lib/base-path'
import { ORGANIZATION_MODEL_PROVIDERS } from '@/lib/governance/policy'

export type GovernanceDetail = 'access_denied' | 'seat_limit' | 'feature_unavailable' | 'last_owner' | 'workspace_attached' | 'personal_workspace' | 'invalid_request' | 'template_limit' | 'not_found' | 'plan_changed'

export class GovernanceRequestError extends Error {
  constructor(public status: number, public detail: GovernanceDetail | 'default') { super(detail); this.name = 'GovernanceRequestError' }
}

export type OrganizationRole = 'owner' | 'admin' | 'member'
export type OrganizationListItem = { id: string; name: string; role: OrganizationRole }
export type JoinableOrganization = Pick<OrganizationListItem, 'id' | 'name'>
export type OrganizationDomain = { id: string; domain: string }
export type OrganizationMember = { organizationId: string; userId: string; role: OrganizationRole; status: 'active' | 'suspended'; name: string; email: string; image?: string | null; createdAt: string; updatedAt: string }
/** Organization membership only; invitations never confer Workspace/Project access. */
export type OrganizationInvitation = {
  id: string; email: string; createdBy: string; status: 'pending' | 'accepted' | 'revoked'
  createdAt: string; expiresAt: string
}
export type OrganizationInvitationOutcome =
  | { email: string; created: true; id: string; path: string }
  | { email: string; created: false; reason: 'duplicate' | 'alreadyMember' | 'pending' }
export type ReceivedOrganizationInvitation = { id: string; organizationName: string; expiresAt: string }
export type OrganizationAuditEvent = {
  id: string; organizationId?: string; actorId: string; action: string; result: 'success' | 'denied' | 'failure'
  correlationId?: string; targetId: string | null; metadata: Record<string, string | number | boolean | null>; createdAt: string
}
export type OrganizationSummary = {
  organization: { id: string; name: string; createdBy: string; createdAt: string; updatedAt: string; archivedAt: string | null }
  role: OrganizationRole
  members: OrganizationMember[]
  workspaceIds: string[]
  /** Distinct active people across every bound workspace. */
  activeHumans: number
  /** The latest 100 Organization events. */
  audit: OrganizationAuditEvent[]
}

export type IdentityProvider = { providerId: string; domain: string; domainVerified: boolean; protocol: 'oidc' | 'saml'; createdAt: string; updatedAt: string }
export type ScimConnection = { id: string; providerId: string; revokedAt: string | null; createdAt: string }
export type IdentitySummary = { providers: IdentityProvider[]; connections: ScimConnection[]; policy: { enforceSso: boolean; allowMachineCredentials: boolean } }

export type OidcProviderInput = {
  action: 'configure-provider'; protocol: 'oidc'; providerId: string; domain: string
  issuer: string; clientId: string; clientSecret: string; tokenEndpointAuthentication?: 'client_secret_basic' | 'client_secret_post'
}
export type SamlProviderInput = {
  action: 'configure-provider'; protocol: 'saml'; providerId: string; domain: string
  issuer: string; idpEntityId: string; entryPoint: string; cert: string | string[]
  logoutEntryPoint?: string; logoutPostEntryPoint?: string
  spSigning?: { cert: string; privateKey: string; passphrase?: string }
  mapping?: { email: string; name?: string }
}
/** What to register at the IdP and publish in DNS. `dns.token` proves the domain once; it is shown only in this response. */
export type ProviderConfigured = { providerId: string; dns: { type: 'TXT'; name: string; value: string; token: string }; callbackURL: string; postLogoutRedirectURI?: string }
/** Shown once: the SCIM bearer is never returned again. */
export type ScimCredential = { id: string; token: string; baseURL: string }

export type SharingRule = 'allow' | 'approval_required' | 'deny'
export const MODEL_PROVIDERS = ORGANIZATION_MODEL_PROVIDERS
export type ModelProvider = typeof MODEL_PROVIDERS[number]
export type ResourcePolicy = {
  modelCredentialSharing: SharingRule; mcpSharing: SharingRule
  /** null: every provider. */
  allowedModelProviders: ModelProvider[] | null
  /** null: kept until removed by hand. */
  auditRetentionDays: number | null
  legalHold: boolean
  revision: number
}
export type ResourceApproval = {
  id: string; organizationId: string; workspaceId: string; kind: SharedResourceKind; resourceId: string
  ownerId: string; status: 'pending' | 'approved' | 'denied'; decidedBy: string | null; createdAt: string; updatedAt: string
}
export type ResourcePolicyState = { policy: ResourcePolicy; approvals: ResourceApproval[] }

export type AuditManifest = { format: 'mikka-organization-audit-export'; version: 1; id: string; organizationId: string; createdAt: string; expiresAt: string; from: string; until: string; count: number; digest: string }
export type AuditExportPage = { manifest: AuditManifest; events: OrganizationAuditEvent[]; nextOffset: number | null }
export type AuditExportDetail = 'auditExportLimitExceeded' | 'auditExportUnavailable' | 'auditExportChanged'

/** A refusal from the audit export routes, which answer with their own code instead of governance_denied. */
export class AuditExportRequestError extends Error {
  constructor(public status: number, public code: AuditExportDetail | 'default') { super(code); this.name = 'AuditExportRequestError' }
}

/** An Organization route's path, under /api/organizations. */
export const organizationPath = (id: string, path = '') => `/api/organizations/${encodeURIComponent(id)}${path}`

/** One request to these routes; a refusal throws GovernanceRequestError or AuditExportRequestError. */
export async function organizationRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(url), { cache: 'no-store', credentials: 'same-origin', ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; detail?: GovernanceDetail } } | null
    const code = body?.error?.code
    if (code === 'auditExportLimitExceeded' || code === 'auditExportUnavailable' || code === 'auditExportChanged') throw new AuditExportRequestError(response.status, code)
    throw new GovernanceRequestError(response.status, body?.error?.detail ?? 'default')
  }
  return response.json() as Promise<T>
}
const send = <T>(url: string, method: string, body?: unknown) => organizationRequest<T>(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

export type OrganizationServiceKey = {
  id: string; name: string | null; workspaceId: string; serviceIdentityId: string; serviceIdentityName: string; expiresAt: string | null
}

export const organizationApi = {
  acceptReceivedInvitation: (invitationId: string) =>
    send<{ organizationId: string; joined: true }>('/api/organization-invitations/accept', 'POST', { invitationId }),
  addDomain: (id: string, domain: string) =>
    send<{ domain: OrganizationDomain }>(organizationPath(id, '/allowed-domains'), 'POST', { domain }),
  removeDomain: (id: string, domainId: string) =>
    send<{ removed: true }>(organizationPath(id, '/allowed-domains/' + encodeURIComponent(domainId)), 'DELETE'),
  joinByDomain: (id: string) =>
    send<{ organizationId: string; joined: true; role: OrganizationRole }>(organizationPath(id, '/join-by-domain'), 'POST'),
  serviceKeys: (id: string, after?: string) => organizationRequest<{ keys: OrganizationServiceKey[]; nextCursor: string | null }>(
    organizationPath(id, '/api-keys') + (after ? '?' + new URLSearchParams({ after }) : '')),
  nameServiceKey: (id: string, keyId: string, name: string) =>
    send<{ id: string; name: string }>(organizationPath(id, '/api-keys/' + encodeURIComponent(keyId)), 'PATCH', { name }),
  create: (name: string) => send<OrganizationListItem>('/api/organizations', 'POST', { name }),
  rename: (id: string, name: string) => send<{ organization: OrganizationSummary['organization'] }>(organizationPath(id), 'PATCH', { name }),
  /** Owner only; needs every workspace unbound and every provider and SCIM connection closed first. */
  archive: (id: string) => send<{ archived: true }>(organizationPath(id), 'DELETE'),
  /** Binding needs both Organization admin and admin of that workspace. */
  bind: (id: string, workspaceId: string) => send<{ attached: true }>(organizationPath(id, '/workspaces'), 'POST', { workspaceId }),
  unbind: (id: string, workspaceId: string) => send<{ detached: true }>(organizationPath(id, '/workspaces'), 'DELETE', { workspaceId }),
  /** All emails invite an ordinary Organization Member only, never a Workspace member. */
  inviteMembers: (id: string, emails: string[]) =>
    send<{ outcomes: OrganizationInvitationOutcome[] }>(organizationPath(id, '/invitations'), 'POST', { emails }),
  revokeInvitation: (id: string, invitationId: string) =>
    send<{ revoked: true }>(organizationPath(id, '/invitations'), 'DELETE', { invitationId }),
  acceptInvitation: (token: string) =>
    send<{ organizationId: string; joined: true; role: 'member' }>('/api/organization-invitations/accept', 'POST', { token }),
  /** An existing account, chosen by ID; an email match alone adds no one. */
  addMember: (id: string, userId: string, role: OrganizationRole) => send<{ member: OrganizationMember }>(organizationPath(id, '/members'), 'POST', { userId, role }),
  setRole: (id: string, userId: string, role: OrganizationRole) => send<{ updated: true }>(organizationPath(id, '/members'), 'PATCH', { userId, role }),
  /** Scoped offboarding: suspends the person in this Organization's workspaces; their account and other Organizations stay. */
  removeMember: (id: string, userId: string) => send<{ removed: true }>(organizationPath(id, '/members'), 'DELETE', { userId }),

  configureProvider: (id: string, input: OidcProviderInput | SamlProviderInput) => send<ProviderConfigured>(organizationPath(id, '/identity'), 'POST', input),
  verifyDomain: (id: string, providerId: string, token: string) => send<{ verified: true }>(organizationPath(id, '/identity'), 'POST', { action: 'verify-domain', providerId, token }),
  disableProvider: (id: string, providerId: string) => send<{ disabled: true }>(organizationPath(id, '/identity'), 'POST', { action: 'disable-provider', providerId }),
  rotateScim: (id: string, providerId: string) => send<ScimCredential>(organizationPath(id, '/identity'), 'POST', { action: 'rotate-scim', providerId }),
  revokeScim: (id: string, connectionId: string) => send<{ revoked: true }>(organizationPath(id, '/identity'), 'POST', { action: 'revoke-scim', connectionId }),
  /** Turning SSO enforcement on needs the current session to be this Organization's SSO sign-in. */
  setSignInPolicy: (id: string, enforceSso: boolean, allowMachineCredentials: boolean) => send<IdentitySummary['policy']>(organizationPath(id, '/identity'), 'POST', { action: 'policy', enforceSso, allowMachineCredentials }),
  /** Owner only, within five minutes of signing in; lasts fifteen minutes. */
  breakGlass: (id: string, reason: string) => send<{ expiresAt: string }>(organizationPath(id, '/identity'), 'POST', { action: 'break-glass', reason }),
  retryRevocations: (id: string) => send<{ retried: true }>(organizationPath(id, '/identity'), 'POST', { action: 'retry-revocations' }),

  setPolicy: (id: string, policy: Omit<ResourcePolicy, 'revision'>) => send<ResourcePolicyState>(organizationPath(id, '/policy'), 'PATCH', policy),
  decide: (id: string, approvalId: string, status: 'approved' | 'denied') => send<{ decided: true }>(organizationPath(id, '/approvals'), 'PATCH', { id: approvalId, status }),

  listAuditEvents: (id: string, filters: { cursor?: string; order?: 'asc' | 'desc'; actor?: string; userId?: string; family?: string; from?: string; to?: string; q?: string; limit?: number } = {}) => {
    const query = new URLSearchParams({ view: 'events' })
    for (const [name, value] of Object.entries(filters)) if (value !== undefined) query.set(name, String(value))
    return organizationRequest<{ events: OrganizationAuditEvent[]; nextCursor: string | null }>(`${organizationPath(id, '/audit-log')}?${query}`)
  },

  /** Freezes the events in range for fifteen minutes; each page rechecks admin access and integrity. */
  createAuditExport: (id: string, range: { from?: string; until?: string }) => send<{ manifest: AuditManifest; events: OrganizationAuditEvent[] }>(organizationPath(id, '/audit-log'), 'POST', range),
  readAuditExport: (id: string, exportId: string, offset: number, limit = 100) =>
    organizationRequest<AuditExportPage>(`${organizationPath(id, '/audit-log')}?${new URLSearchParams({ exportId, offset: String(offset), limit: String(limit) })}`),
}

/**
 * Account linking for someone who already has a Mikka account with the
 * directory's email: within five minutes of signing in, ask for a one-use
 * ticket, then sign in through the provider. Only that signed sign-in links.
 */
export async function linkExistingAccount(providerId: string, callbackURL: string) {
  await send<{ providerId: string; next: string }>('/api/enterprise/link', 'POST', { providerId })
  return signInWithSso({ providerId }, callbackURL)
}


/** Which company sign-in to start: a known method, or the one registered for an email's or a domain's verified domain. */
export type SsoTarget = { providerId: string } | { email: string } | { domain: string }

/**
 * Starts company sign-in (Better Auth SSO, /sign-in/sso) and returns where to
 * send the browser. Throws `SsoStartError` when no verified method matches.
 */
export async function signInWithSso(target: SsoTarget, callbackURL: string, errorCallbackURL?: string) {
  const response = await fetch(withBasePath('/api/auth/sign-in/sso'), { method: 'POST', cache: 'no-store', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...target, callbackURL, ...(errorCallbackURL ? { errorCallbackURL } : {}) }) })
  const value = await response.json().catch(() => null) as { url?: string } | null
  if (!response.ok || !value?.url) throw new SsoStartError(response.status)
  return value.url
}

/** No verified company sign-in for that email or domain (404), or the request was refused. */
export class SsoStartError extends Error {
  constructor(public status: number) { super(status === 404 ? 'not_found' : 'failed'); this.name = 'SsoStartError' }
}

/** OIDC RP-initiated logout for the provider of the current session (the server checks it matches). `upstream` says how far it got; local sign-out has happened in every case. */
export async function oidcSignOut(providerId: string) {
  return send<{ localSessionRevoked: true; upstream: 'requested' | 'not_supported' | 'unavailable'; url: string }>(`/api/auth/sso/oidc/logout/${encodeURIComponent(providerId)}`, 'POST', {})
}


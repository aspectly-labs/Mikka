import { z } from 'zod'
import { webUrlSchema } from '@/lib/search/url-schema'
import { mcpEnvironmentSchema, mcpHeadersSchema, taskMcpServerSchema } from '../../packages/protocol/src/task-mcp'

export class PluginError extends Error {
  constructor(readonly code: string, readonly status = 503, options?: { cause?: unknown }) { super(code, options) }
}

export class McpValidationError extends Error {
  constructor(readonly stage: 'identity_validation' | 'connection_lock', cause: unknown) {
    super('MCP validation failed', { cause }); this.name = 'McpValidationError'
  }
}

// User-provided MCP servers receive only their explicitly saved credential.
// Never accept transport, forwarding, cookie or hop-by-hop headers as auth.
export const mcpAuthSchema = z.object({
  name: z.string().regex(/^(?:authorization|x-api-key|api-key|x-auth-token)$/i),
  value: z.string().min(1).max(4096).refine(value => !/[\r\n\0]/.test(value)),
}).strict()
const remoteMcpSchema = z.object({
  name: z.string().trim().min(1).max(80), url: webUrlSchema.refine(value => { const url = new URL(value); return !url.search && !url.hash }, 'Use the auth field for credentials'),
  transport: z.enum(['http', 'sse']).default('http'),
  enabled: z.boolean().default(true), auth: mcpAuthSchema.optional(), headers: mcpHeadersSchema.optional(),
}).strict().refine(value => !(value.auth && value.headers), 'Use auth or headers, not both')
const stdioMcpSchema = taskMcpServerSchema.options[1].omit({ name: true, disabledTools: true }).extend({ name: z.string().trim().min(1).max(80), enabled: z.boolean().default(true) })
export const createMcpSchema = z.union([remoteMcpSchema, stdioMcpSchema])
export const updateMcpSchema = z.object({
  id: z.uuid(), name: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional(),
  // A URL change requires a new connection, preventing credentials following another host.
  auth: mcpAuthSchema.nullable().optional(),
  headers: mcpHeadersSchema.nullable().optional(), env: mcpEnvironmentSchema.optional(),
}).strict().refine(value => !(value.auth !== undefined && value.headers !== undefined)).refine(value => value.name !== undefined || value.enabled !== undefined || value.auth !== undefined || value.headers !== undefined || value.env !== undefined)
export const deletePluginSchema = z.object({ id: z.uuid() }).strict()
export const installSkillSchema = z.object({
  source: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/),
  slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
}).strict()
export const createManualSkillSchema = z.object({
  name: z.string().trim().min(1).max(80).refine(value => !/[\r\n\0]/.test(value)),
  slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  instructions: z.string().trim().min(1).max(12_000).refine(value => !value.includes('\0')),
}).strict()
export const createSkillSchema = z.union([installSkillSchema, createManualSkillSchema])
export const updateSkillSchema = z.object({
  id: z.uuid(),
  enabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(80).refine(value => !/[\r\n\0]/.test(value)).optional(),
  instructions: z.string().trim().min(1).max(12_000).refine(value => !value.includes('\0')).optional(),
}).strict().refine(value => value.enabled !== undefined || value.name !== undefined || value.instructions !== undefined)
export type McpServerView = {
  id: string; name: string; url: string; transport: 'http' | 'sse' | 'stdio'; enabled: boolean;
  revision: number; authKind: 'header' | 'none' | 'env' | 'oauth'; createdAt: string;
}
/**
 * A person's own server seen from a workspace. Personal MCP servers are not shareable
 * (decision 2026-11-27-1700): `mine` is always true and `shared`/`canShare` always false.
 * Those fields stay for one release so clients built before sharing was retired keep working.
 */
export type McpWorkspaceServerView = Omit<McpServerView, 'url'> & {
  url: string | null; ownerId: string; ownerName: string | null; mine: boolean; shared: boolean;
}
export type McpWorkspacePage = {
  workspaceId: string; workspaceKind: 'personal' | 'team'; canShare: boolean;
  servers: McpWorkspaceServerView[]; count: number;
}
/**
 * Host-owned references only. `ownerId` is the requester and `grantId` is null; an execution
 * frozen while workspace sharing existed may still carry a grant ID, which every check refuses.
 */
export const mcpServerGrantSchema = z.object({
  id: z.uuid(), name: z.string().max(80), revision: z.number().int().positive(), ownerId: z.string().min(1),
  grantId: z.uuid().nullable(),
  /** A workspace (organization) server. Absent: a person's own connection (or a legacy share).
   * `ownerId` is then the requester, whose account a "member" server uses. */
  source: z.literal('workspace').optional(),
  mode: z.enum(['shared', 'member']).optional(),
}).strict().refine(grant => (grant.source === 'workspace') === (grant.mode !== undefined) && (grant.source !== 'workspace' || grant.grantId === null))
export const mcpAuthoritySchema = z.object({
  requester: z.string().min(1), workspaceId: z.uuid().nullable(), environmentId: z.uuid().nullable().optional(), servers: z.array(mcpServerGrantSchema).max(64),
}).strict()
export type McpServerGrant = z.infer<typeof mcpServerGrantSchema>
export type McpAuthority = z.infer<typeof mcpAuthoritySchema>
/** Capy's server key (tool names are `key__tool`): a private server and a workspace
 * server with the same key never both reach a thread; the private one wins. */
export const mcpServerKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)
export function mcpServerKey(name: string): string {
  const key = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 40).replace(/[-_]+$/, '')
  return key || 'server'
}
const workspaceMcpBase = {
  name: z.string().trim().min(1).max(80),
  url: webUrlSchema.refine(value => { const url = new URL(value); return !url.search && !url.hash }, 'Use the auth field for credentials'),
  transport: z.enum(['http', 'sse']),
}
/** As Capy, creating a server takes no connection mode: a new server is shared. */
export const createWorkspaceMcpSchema = z.object({
  ...workspaceMcpBase, transport: workspaceMcpBase.transport.default('http'),
  serverKey: mcpServerKeySchema.optional(), environmentId: z.uuid().nullable().optional(),
  enabled: z.boolean().default(true), auth: mcpAuthSchema.optional(), headers: mcpHeadersSchema.optional(),
}).strict().refine(value => !(value.auth && value.headers), 'Use auth or headers, not both')
export const updateWorkspaceMcpSchema = z.object({
  name: workspaceMcpBase.name.optional(), url: workspaceMcpBase.url.optional(), transport: workspaceMcpBase.transport.optional(),
  serverKey: mcpServerKeySchema.optional(), environmentId: z.uuid().nullable().optional(), enabled: z.boolean().optional(),
  auth: mcpAuthSchema.nullable().optional(), headers: mcpHeadersSchema.nullable().optional(),
  connectionMode: z.enum(['shared', 'member']).optional(),
  /** The revision the caller last saw; a different one is a concurrent change (409). */
  expectedRevision: z.number().int().positive().optional(),
}).strict().refine(value => !(value.auth !== undefined && value.headers !== undefined))
  .refine(value => Object.keys(value).some(key => key !== 'expectedRevision'))
export type WorkspaceMcpConnectionMode = 'shared' | 'member'
export type WorkspaceMcpServerView = {
  id: string; workspaceId: string; serverKey: string; name: string; url: string; transport: 'http' | 'sse';
  environmentId: string | null; connectionMode: WorkspaceMcpConnectionMode; authKind: 'none' | 'header' | 'oauth';
  enabled: boolean; revision: number; createdBy: string | null; createdAt: string; updatedAt: string;
  /** Capy's list groups: "Shared by your organization" or "Connect your own account". */
  group: 'organization' | 'member';
  /** Whether a thread this viewer starts has an account to call it with. */
  connected: boolean; toolCount: number;
  /** A private server of this viewer with the same key wins in their threads. */
  shadowedByPersonal: boolean;
}
export type WorkspaceMcpServerDetail = WorkspaceMcpServerView & {
  status: 'connected' | 'needs_connect' | 'check_failed' | 'disabled'; lastCheckedAt: string | null; failureReason: string | null;
  authorizationUrl: string | null;
  tools: { name: string; enabled: boolean; description: string; available: boolean }[];
  /** "member" servers: who has connected (names only, as Capy's connection list). */
  connections: { userId: string; name: string | null }[];
}
export type InstalledSkill = {
  id: string; name: string; source: string; slug: string; sourceKind: 'skills.sh' | 'built-in' | 'self-improvement';
  sourceRevision: string; sourcePath: string; sha256: string; enabled: boolean; createdAt: string;
}
export type SkillContent = Pick<InstalledSkill, 'name' | 'source' | 'slug' | 'sourceKind' | 'sourceRevision' | 'sourcePath' | 'sha256'> & { body: string }
export type PersonalPluginSnapshot = {
  servers: Pick<McpServerView, 'id' | 'name' | 'revision'>[];
  /** Absent on legacy executions, whose MCP authority remains personal only. */
  mcpAuthority?: McpAuthority;
  skills: (SkillContent & { id: string })[];
  toolkits?: string[];
}
export const PERSONAL_MCP_TOOLS = ['list_personal_mcp_tools', 'call_personal_mcp_tool'] as const

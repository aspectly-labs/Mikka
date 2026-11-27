import { z } from 'zod'

export const mcpToolName = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)
/** One tool switch. `expectedEnabled` is the state the switch showed: a different stored state is a
 * concurrent change (409), never overwritten. `workspaceId` names the workspace a shared connection
 * is being managed from, so that workspace's admins may turn its tools on and off. */
export const mcpToolSetting = z.object({ enabled: z.boolean(), expectedEnabled: z.boolean().optional(), workspaceId: z.uuid().optional() }).strict()
export const mcpEnvironmentSettings = z.object({
  workspaceId: z.uuid(), environmentIds: z.array(z.uuid()).max(100),
}).strict().refine(value => new Set(value.environmentIds).size === value.environmentIds.length)
export const mcpOAuthStart = z.object({}).strict()
export type McpConnectionStatus = 'connected' | 'needs_connect' | 'check_failed' | 'disabled'
export type McpToolView = { name: string; enabled: boolean; description: string; available: boolean }
export type McpConnectionDetails = {
  id: string; status: McpConnectionStatus; lastCheckedAt: string | null; failureReason: string | null;
  authorizationUrl: string | null; tools: McpToolView[]; environmentIds: string[];
  /** The owner, or an admin of the workspace the connection is shared to, may switch its tools. */
  canManageTools: boolean;
  deviceCheck: { id: string; deviceId: string; expiresAt: string; status: 'pending' | 'expired' } | null;
}

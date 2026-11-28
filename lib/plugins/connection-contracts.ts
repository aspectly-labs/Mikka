import { z } from 'zod'

export const mcpToolName = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)
/** One tool switch (owner only). `expectedEnabled` is the state the switch showed: a different
 * stored state is a concurrent change (409), never overwritten. */
export const mcpToolSetting = z.object({ enabled: z.boolean(), expectedEnabled: z.boolean().optional() }).strict()
export const mcpEnvironmentSettings = z.object({
  workspaceId: z.uuid(), environmentIds: z.array(z.uuid()).max(100),
}).strict().refine(value => new Set(value.environmentIds).size === value.environmentIds.length)
export const mcpOAuthStart = z.object({}).strict()
export type McpConnectionStatus = 'connected' | 'needs_connect' | 'check_failed' | 'disabled'
export type McpToolView = { name: string; enabled: boolean; description: string; available: boolean }
export type McpConnectionDetails = {
  id: string; status: McpConnectionStatus; lastCheckedAt: string | null; failureReason: string | null;
  authorizationUrl: string | null; tools: McpToolView[]; environmentIds: string[];
  deviceCheck: { id: string; deviceId: string; expiresAt: string; status: 'pending' | 'expired' } | null;
}

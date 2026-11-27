import { PluginError } from './contracts'

/** The server name a native task's MCP configuration carries for one connection. */
export const nativeMcpName = (serverId: string) => `mcp_${serverId.replaceAll('-', '')}`

/**
 * The claim response's servers with the tool switches the claim fence read under lock
 * (`lockNativeMcpAuthority`), replacing what the export read earlier. Fails closed: a server the
 * fence did not lock, or a disabled tool the daemon cannot filter, refuses the claim as unavailable.
 */
export function withLockedToolSwitches<T extends { name: string; disabledTools?: string[] }>(servers: readonly T[], locked: Readonly<Record<string, readonly string[]>>, supportsToolFilter: boolean): T[] {
  const byName = new Map(Object.entries(locked).map(([id, disabled]) => [nativeMcpName(id), disabled]))
  return servers.map(server => {
    const disabled = byName.get(server.name)
    if (!disabled || disabled.length > 0 && !supportsToolFilter) throw new PluginError('mcpUnavailable', 409)
    const { disabledTools, ...rest } = server
    return (disabled.length || disabledTools !== undefined ? { ...rest, disabledTools: [...disabled] } : rest) as T
  })
}

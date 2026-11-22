const FORBIDDEN_MCP_HEADER = /^(?:host|cookie|set-cookie|connection|content-length|transfer-encoding|proxy-.*|x-forwarded-.*)$/i

/** Values entered in the connection form. Credentials are write-only. */
export type McpServerDraft = {
  name: string
  transport: 'http' | 'sse' | 'stdio'
  url: string
  command: string
  arguments: string
  cwd: string
  values: readonly { name: string; value: string }[]
}

export type McpCreateInput = { name: string; enabled: true } & (
  | { transport: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { transport: 'stdio'; command: string; args: string[]; cwd?: string; env?: Record<string, string> }
)

/** Preserve argument and credential bytes; do not expand shell variables. */
export function mcpServerInput(draft: McpServerDraft): McpCreateInput {
  const values: Record<string, string> = Object.create(null)
  const names = new Set<string>()
  for (const row of draft.values) {
    if (!row.name && !row.value) continue
    const name = row.name.trim()
    const key = draft.transport === 'stdio' ? name : name.toLowerCase()
    const validName = draft.transport === 'stdio'
      ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      : (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !FORBIDDEN_MCP_HEADER.test(name))
    if (!name || !row.value || names.has(key) || !validName) throw new Error('invalidMcpVariables')
    names.add(key)
    values[name] = row.value
  }
  const base = { name: draft.name.trim(), enabled: true as const }
  if (!base.name) throw new Error('invalidMcpName')
  if (draft.transport !== 'stdio') {
    const url = draft.url.trim()
    let parsedUrl: URL
    try { parsedUrl = new URL(url) } catch { throw new Error('invalidMcpUrl') }
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
      throw new Error('invalidMcpUrl')
    }
    return { ...base, transport: draft.transport, url, ...(names.size ? { headers: values } : {}) }
  }
  const command = draft.command.trim()
  if (!command) throw new Error('invalidMcpCommand')
  return { ...base, transport: 'stdio', command,
    args: draft.arguments ? draft.arguments.split(/\r?\n/) : [],
    ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}), ...(names.size ? { env: values } : {}) }
}

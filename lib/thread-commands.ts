import 'server-only'
import type { Pool } from 'pg'
import {
  availableCommandsChunkDataSchema,
  mergeAvailableCommands,
  mikkaHostCommands,
  normalizeClaudeCommands,
  normalizeCodexCommands,
  normalizeEveCommands,
  type AvailableCommand,
  type SystemEventData,
} from '@mikka/protocol/slash-commands'
import { pool as defaultPool } from '@/lib/db'
import { readRunChain } from '@/lib/run-chain'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'

export interface ThreadRuntimeCommands {
  harness: 'claude_code' | 'codex' | 'mock'
  commands: AvailableCommand[]
  terminalSlashCommands: string[]
  discovered: boolean
  active: boolean
  hasTask: boolean
  latestRunId: string
  rootRunId: string
}

/**
 * Read the latest runtime-reported slash commands (`data-available-commands`)
 * across a thread's run chain.
 */
export async function readThreadRuntimeCommands(
  database: Pick<Pool, 'query'>,
  userId: string,
  runId: string,
): Promise<ThreadRuntimeCommands | null> {
  const chain = await readRunChain(database, userId, runId)
  if (!chain) return null
  const runIds = chain.attempts.map(attempt => attempt.runId)
  const latest = chain.attempts.at(-1)
  const { rows: [meta] } = await database.query<{ harness: string | null; issueId: string | null }>(
    `SELECT coalesce(r."agentDefinition"->>'harness', a.harness) AS harness, r."issueId"
     FROM agent_runs r JOIN agents a ON a.id=r."agentId"
     WHERE r.id=$1 AND r."userId"=$2`,
    [chain.latestRunId, userId],
  )
  if (!meta) return null
  const harness = meta.harness === 'codex' ? 'codex' : meta.harness === 'mock' ? 'mock' : 'claude_code'
  const { rows: [latestChunk] } = await database.query<{ chunk: Record<string, unknown> }>(
    `SELECT chunk FROM run_chunks
     WHERE "runId" = ANY($1::uuid[]) AND chunk->>'type' = 'data-available-commands'
     ORDER BY "createdAt" DESC, seq DESC LIMIT 1`,
    [runIds],
  )
  const parsed = latestChunk ? availableCommandsChunkDataSchema.safeParse(latestChunk.chunk?.data) : null
  const active = UNFINISHED_RUN_STATUSES.some(status => status === latest?.status)
  if (parsed?.success) {
    return {
      harness,
      commands: parsed.data.commands,
      terminalSlashCommands: parsed.data.terminalSlashCommands ?? [],
      discovered: true,
      active,
      hasTask: Boolean(meta.issueId),
      latestRunId: chain.latestRunId,
      rootRunId: chain.rootRunId,
    }
  }
  const fallback = harness === 'codex'
    ? normalizeCodexCommands()
    : harness === 'claude_code'
      ? normalizeClaudeCommands({})
      : []
  return {
    harness,
    commands: fallback,
    terminalSlashCommands: [],
    discovered: false,
    active,
    hasTask: Boolean(meta.issueId),
    latestRunId: chain.latestRunId,
    rootRunId: chain.rootRunId,
  }
}

/**
 * Full merged `/` menu for a coding thread: Mikka host commands (winning over
 * duplicates) + runtime-reported harness, skill, and MCP commands.
 */
export async function readThreadAvailableCommands(
  database: Pick<Pool, 'query'>,
  userId: string,
  runId: string,
): Promise<{
  harness: 'claude_code' | 'codex' | 'mock'
  commands: AvailableCommand[]
  discovering: boolean
  terminalSlashCommands: string[]
} | null> {
  const runtime = await readThreadRuntimeCommands(database, userId, runId)
  if (!runtime) return null
  const host = mikkaHostCommands({
    threadSurface: 'coding',
    canStop: runtime.active,
    hasTask: runtime.hasTask,
  })
  return {
    harness: runtime.harness,
    commands: mergeAvailableCommands(host, runtime.commands),
    discovering: !runtime.discovered && runtime.active,
    terminalSlashCommands: runtime.terminalSlashCommands,
  }
}

/**
 * Full merged `/` menu for an Eve Bot / Coordinator chat: Mikka host commands
 * + Eve session & capability commands + the user's enabled installed skills.
 */
export async function readBotAvailableCommands(
  database: Pick<Pool, 'query'>,
  userId: string,
): Promise<{ harness: 'eve'; commands: AvailableCommand[]; discovering: false }> {
  const { rows } = await database.query<{ slug: string; name: string }>(
    `SELECT slug, name FROM personal_skills WHERE user_id=$1 AND enabled=true ORDER BY created_at, id LIMIT 100`,
    [userId],
  ).catch(() => ({ rows: [] as { slug: string; name: string }[] }))
  const skills = rows
    .filter(r => r.slug?.trim())
    .map(r => ({ name: r.slug.trim(), description: r.name?.trim() || '' }))
  const host = mikkaHostCommands({ threadSurface: 'bot', canStop: true, hasTask: false })
  return {
    harness: 'eve',
    commands: mergeAvailableCommands(host, normalizeEveCommands(skills)),
    discovering: false,
  }
}

/**
 * Append a durable host-emitted system event to a thread and notify live subscribers
 * (used for blocked slash-command notices and inline side notes).
 *
 * Stored as a paired `coordinator_events` payload + `run_messages` row (never in
 * `run_chunks`) so host inserts cannot collide with daemon-allocated `run_chunks.seq`.
 */
export async function appendThreadSystemEvent(runId: string, userId: string, data: SystemEventData): Promise<void> {
  const client = await defaultPool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [run] } = await client.query<{ issueId: string | null; botId: string | null }>(
      `SELECT "issueId", "botId" FROM agent_runs WHERE id=$1 AND "userId"=$2`,
      [runId, userId],
    )
    if (!run) {
      await client.query('ROLLBACK')
      return
    }
    const eventId = crypto.randomUUID()
    await client.query(
      `INSERT INTO coordinator_events (id, "userId", "botId", "issueId", kind, "dedupeKey", payload, tier, "deliveredAt")
       VALUES ($1, $2, $3, $4, 'user_message', $5, $6::jsonb, 'background', now())`,
      [eventId, userId, run.botId ?? null, run.issueId ?? null, `thread-system-event:${eventId}`, JSON.stringify({ threadSystemEvent: data })],
    )
    await client.query(
      `INSERT INTO run_messages (id, "runId", "userId", text, origin, "mailboxWakeDepth", "deliveredAt")
       VALUES ($1, $2, $3, '', 'peer', -1, now())`,
      [eventId, runId, userId],
    )
    const { threadChanged } = await import('@/lib/live/panels')
    await threadChanged(client, runId)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

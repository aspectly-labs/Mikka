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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TERMINAL_FAILED_SIDE_STATUSES = new Set(['failed', 'stopped', 'cancelled', 'canceled', 'timed_out'])

/**
 * Resolve live status, answer, or error for any `side_note` system events
 * against the real durable `agent_runs` side chain (+ latest assistant text
 * chunk fallback when `lastReply`/`report.summary` is absent). Scoped strictly
 * to the thread owner's runs (`"userId"=$ownerId`).
 */
export async function enrichSideNoteEvents<T extends { systemEvent?: SystemEventData }>(
  database: Pick<Pool, 'query'>,
  ownerUserId: string,
  items: T[],
): Promise<T[]> {
  const sideRunIds = [...new Set(
    items.flatMap(item => item.systemEvent?.kind === 'side_note' && typeof item.systemEvent.sideRunId === 'string' && UUID_RE.test(item.systemEvent.sideRunId)
      ? [item.systemEvent.sideRunId]
      : []),
  )]
  if (!sideRunIds.length) return items
  const { rows } = await database.query<{
    rootSideId: string
    latestRunId: string
    status: string
    lastReply: string | null
    summary: string | null
    error: string | null
    stopReason: string | null
  }>(
    `WITH RECURSIVE side_chain AS (
       SELECT r.id AS "rootSideId", r.id AS "runId", r."createdAt", 0 AS depth
       FROM agent_runs r
       WHERE r.id = ANY($1::uuid[]) AND r."userId" = $2 AND r."deletedAt" IS NULL
       UNION ALL
       SELECT sc."rootSideId", child.id AS "runId", child."createdAt", sc.depth + 1
       FROM side_chain sc
       JOIN agent_runs child ON child."continuesRunId" = sc."runId"
         AND child."userId" = $2 AND child."deletedAt" IS NULL
       WHERE sc.depth < 32
     ),
     latest_per_side AS (
       SELECT DISTINCT ON ("rootSideId") "rootSideId", "runId" AS "latestRunId"
       FROM side_chain
       ORDER BY "rootSideId", depth DESC, "createdAt" DESC, "runId" DESC
     )
     SELECT l."rootSideId"::text, l."latestRunId"::text, r.status, r."lastReply",
            r.report->>'summary' AS summary, r.error, r."stopReason"
     FROM latest_per_side l
     JOIN agent_runs r ON r.id = l."latestRunId" AND r."userId" = $2`,
    [sideRunIds, ownerUserId],
  )
  const bySideId = new Map(rows.map(row => [row.rootSideId, row]))
  const needChunkRunIds = rows
    .filter(row => row.status === 'succeeded' && !row.lastReply?.trim() && !row.summary?.trim())
    .map(row => row.latestRunId)
  const chunkAnswerByRun = new Map<string, string>()
  if (needChunkRunIds.length) {
    const { rows: chunkRows } = await database.query<{ runId: string; text: string }>(
      `SELECT "runId"::text,
              string_agg(coalesce(chunk->>'delta', chunk->>'text', ''), '' ORDER BY seq) AS text
       FROM run_chunks
       WHERE "runId" = ANY($1::uuid[]) AND chunk->>'type' IN ('text-delta', 'text')
       GROUP BY "runId"`,
      [needChunkRunIds],
    )
    for (const row of chunkRows) {
      const trimmed = row.text?.trim()
      if (trimmed) chunkAnswerByRun.set(row.runId, trimmed)
    }
  }
  return items.map(item => {
    if (item.systemEvent?.kind !== 'side_note' || !item.systemEvent.sideRunId) return item
    const resolved = bySideId.get(item.systemEvent.sideRunId)
    if (!resolved) return item
    if (resolved.status === 'succeeded') {
      const answerText = (resolved.lastReply?.trim() || resolved.summary?.trim() || chunkAnswerByRun.get(resolved.latestRunId) || '').slice(0, 4_000)
      return {
        ...item,
        systemEvent: {
          ...item.systemEvent,
          status: 'answered' as const,
          ...(answerText ? { answer: answerText } : {}),
          error: undefined,
        },
      }
    }
    if (TERMINAL_FAILED_SIDE_STATUSES.has(resolved.status)) {
      const errText = (resolved.error?.trim() || resolved.stopReason?.trim() || resolved.status).slice(0, 1_000)
      return {
        ...item,
        systemEvent: {
          ...item.systemEvent,
          status: 'failed' as const,
          error: errText,
        },
      }
    }
    return {
      ...item,
      systemEvent: {
        ...item.systemEvent,
        status: 'pending' as const,
      },
    }
  })
}

export type PreparedThreadSlashMessage =
  | {
      kind: 'blocked'
      runId: string
      blocked: {
        command: string
        originalText: string
        validCommands: string[]
        reason: 'dangerous_passthrough' | 'terminal_only' | 'host_owned'
      }
    }
  | {
      kind: 'send'
      control: import('@/lib/thread-continue').ThreadMessageControl | undefined
      runtime: ThreadRuntimeCommands | null
    }

/**
 * Shared server-side slash-command & skill preflight used by both Web RPC
 * (`sendIssueThreadMessage`) and Mobile REST (`POST /api/mobile/threads/[id]`).
 * Blocks dangerous/terminal/host-owned Claude commands with a durable
 * `command_blocked` event, routes `/compact` and allowed runtime slash commands
 * via typed `control`, and honors explicit `sendAsText` (`client_composed`).
 */
export async function prepareThreadSlashMessage(
  database: Pick<Pool, 'query'>,
  userId: string,
  runId: string,
  text: string,
  options?: { sendAsText?: boolean; hasSkillMentions?: boolean },
): Promise<PreparedThreadSlashMessage> {
  const slashProtocol = await import('@mikka/protocol/slash-commands')
  const sendAsText = Boolean(options?.sendAsText)
  const leadingSlash = !sendAsText ? slashProtocol.parseLeadingSlashCommand(text) : null
  const hasSkillSignal = Boolean(
    !sendAsText &&
    (options?.hasSkillMentions || /\$[a-z][a-z0-9-]*/.test(text)),
  )
  let runtime: ThreadRuntimeCommands | null = null
  if (leadingSlash || hasSkillSignal) {
    runtime = await readThreadRuntimeCommands(database, userId, runId)
  }
  if (sendAsText) {
    return { kind: 'send', control: { kind: 'client_composed' }, runtime }
  }
  let control: import('@/lib/thread-continue').ThreadMessageControl | undefined
  if (leadingSlash && runtime) {
    const cmdLower = leadingSlash.name.toLowerCase()
    if (runtime.harness === 'claude_code') {
      const blockedCheck = slashProtocol.isBlockedClaudeCommand(leadingSlash.name, runtime.terminalSlashCommands)
      if (blockedCheck.blocked) {
        const validCommands = runtime.commands.map(c => c.name)
        await appendThreadSystemEvent(runtime.latestRunId, userId, {
          kind: 'command_blocked',
          command: blockedCheck.canonical,
          originalText: text,
          validCommands,
          reason: blockedCheck.reason,
        })
        return {
          kind: 'blocked',
          runId: runtime.latestRunId,
          blocked: {
            command: blockedCheck.canonical,
            originalText: text,
            validCommands,
            reason: blockedCheck.reason,
          },
        }
      }
    }
    if (cmdLower === 'compact') {
      const instructions = leadingSlash.args.trim().slice(0, 4_000)
      control = { kind: 'compact', ...(instructions ? { instructions } : {}) }
    } else {
      const matchedRuntime = runtime.commands.find(
        c => c.name.toLowerCase() === cmdLower || c._meta.aliases?.some(a => a.toLowerCase() === cmdLower),
      )
      if (matchedRuntime) {
        control = {
          kind: 'slash',
          name: matchedRuntime.name,
          ...(leadingSlash.args ? { args: leadingSlash.args } : {}),
        }
      }
    }
  }
  return { kind: 'send', control, runtime }
}


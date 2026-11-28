// One stored tool call of a Bot chat, whole (Alex, 2026-11-22: open a tool call and see all of it, as Claude, ChatGPT
// and Cursor do). The chat's reads keep 200-character previews (chat-projection.ts), so a chat never moves large tool
// results on every poll; this read moves one call's input and output, only when the person opens its row.
// Stored messages are masked before they are saved (store.ts appendMessages); the action checks saved secrets.
import { HIDDEN_TOOLS } from './context'
import { INVALID_TOOL_ERROR_PATTERN } from './invalid-tool-call'

/** Most characters of a call's input, and of its output, one read returns (about 64 KB); beyond it, the start, marked cut. */
export const TOOL_CALL_CHARS = 64 * 1024

/**
 * How far after the reply's first stored row (the chat item's `position`) its calls and results may sit: a merged reply
 * holds every step of its turn, two rows a step, well under this; the range rides the (userId, botId, position) key.
 */
const ROWS_AFTER = 512

export type StoredToolCall = { input?: string; output?: string; inputCut?: true; outputCut?: true }

type Querier = { query: <R extends Record<string, unknown>>(text: string, values: unknown[]) => Promise<{ rows: R[] }> }

/**
 * The call `toolCallId` of the reply stored at `position` in `botId`'s chat, as its owner reads it: null unless the
 * bot is `ownerId`'s, in `workspaceId`, and the call is in that person's chat at or after `position`. A hidden tool
 * and a call the model made up (an invalid call) are not read. Input and output read as the chat's previews read them
 * (the input's JSON, the output's value as text), cut at TOOL_CALL_CHARS.
 */
export async function readCoordinatorToolCall(q: Querier, { ownerId, workspaceId, botId, position, toolCallId }: {
  ownerId: string; workspaceId: string; botId: string; position: number; toolCallId: string
}): Promise<StoredToolCall | null> {
  const { rows } = await q.query<{ type: string; input: string | null; output: string | null; invalid: boolean }>(
    `select p->>'type' as type, left(p->>'input', $6) as input, left(p#>>'{output,value}', $6) as output,
       (p->'mikkaInvalidToolCall' = 'true'::jsonb or (p#>>'{output,type}' like 'error%' and (p#>>'{output,value}' ~ $7 or p#>>'{output,value,name}' ~ $7))) as invalid
     from coordinator_messages m
     join bots b on b.id = m."botId" and b."ownerId" = $1 and b."workspaceId" = $2
     cross join lateral jsonb_array_elements(case when jsonb_typeof(m.message->'content') = 'array' then m.message->'content' else '[]'::jsonb end) as part(p)
     where m."userId" = $1 and m."botId" = $3 and m.position >= $4 and m.position <= $4 + ${ROWS_AFTER}
       and p->>'toolCallId' = $5 and p->>'type' in ('tool-call', 'tool-result')
       and coalesce(p->>'toolName', '') <> all($8::text[])
     order by m.position limit 4`,
    [ownerId, workspaceId, botId, position, toolCallId, TOOL_CALL_CHARS + 1, INVALID_TOOL_ERROR_PATTERN, [...HIDDEN_TOOLS]])
  const call = rows.find(row => row.type === 'tool-call')
  if (!call || rows.some(row => row.invalid)) return null
  const result = rows.find(row => row.type === 'tool-result')
  const cut = (text: string | null | undefined) => text == null ? {} : text.length > TOOL_CALL_CHARS ? { text: text.slice(0, TOOL_CALL_CHARS), cut: true as const } : { text }
  const input = cut(call.input), output = cut(result?.output)
  return {
    ...(input.text !== undefined ? { input: input.text } : {}), ...(output.text !== undefined ? { output: output.text } : {}),
    ...(input.cut ? { inputCut: true as const } : {}), ...(output.cut ? { outputCut: true as const } : {}),
  }
}

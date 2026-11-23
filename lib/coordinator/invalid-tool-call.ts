import type { ModelMessage } from 'ai'

export const INVALID_TOOL_ERROR_PATTERN = '^AI_(NoSuchTool|InvalidToolInput)Error(:|$)'
const invalidError = new RegExp(INVALID_TOOL_ERROR_PATTERN)

type Part = { type?: string; toolCallId?: string; toolName?: string; invalid?: boolean; mikkaInvalidToolCall?: boolean; error?: unknown; output?: unknown }

function isInvalidToolError(value: unknown): boolean {
  if (typeof value === 'string') return invalidError.test(value)
  return Boolean(value && typeof value === 'object' && 'name' in value && typeof value.name === 'string' && invalidError.test(value.name))
}

/** Old SDK response.messages omit invalid:true. Recognize the SDK's own
 * error envelope, never a tool name or a substring inside arbitrary output. */
export function isInvalidToolResult(part: Part): boolean {
  if (part.mikkaInvalidToolCall === true) return true
  if (part.type === 'tool-error') return isInvalidToolError(part.error)
  if (part.type !== 'tool-result' || !part.output || typeof part.output !== 'object') return false
  const output = part.output as { type?: unknown; value?: unknown }
  return typeof output.type === 'string' && output.type.startsWith('error') && isInvalidToolError(output.value)
}

/** Pair within the current sequence, so a later bad call cannot hide an
 * earlier valid call that happens to reuse its id. Also handles legacy rows. */
export function invalidToolParts(messages: readonly ModelMessage[]): Set<object> {
  const hidden = new Set<object>()
  const pending = new Map<string, Part>()
  for (const message of messages) {
    if (message.role === 'user') pending.clear()
    if (!Array.isArray(message.content)) continue
    for (const value of message.content) {
      const part = value as Part
      if (part.type === 'tool-call' && part.toolCallId) {
        pending.set(part.toolCallId, part)
        if (part.invalid === true || part.mikkaInvalidToolCall === true) hidden.add(part)
      } else if (part.type === 'tool-result' && part.toolCallId) {
        const call = pending.get(part.toolCallId)
        if (isInvalidToolResult(part) || (call && hidden.has(call))) {
          hidden.add(part)
          if (call && (part.toolName === undefined || call.toolName === part.toolName)) hidden.add(call)
        }
        pending.delete(part.toolCallId)
      }
    }
  }
  return hidden
}

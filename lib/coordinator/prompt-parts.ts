// How the Coordinator's system prompt is put together: the rules, the cached
// repository/model context, the person's own notes, what Mikka has learnt about
// them, and the per-turn tail. Pure string composition, kept free of imports so
// it can be read and tested without the conversation model.
//
// Re-exported by lib/coordinator/context.ts, which is where callers import it.

export const STANDING_INSTRUCTIONS_MAX = 2000

const STANDING_INSTRUCTION_TAGS = /<\/?(?:workspace|environment|bot|personal)_instructions\b[^>]*>/gi

/** Strips instruction XML delimiters so user- or admin-authored text cannot close or spoof a section. */
export function sanitizeStandingInstructions(value: string): string {
  return value.trim().replace(STANDING_INSTRUCTION_TAGS, '').trim()
}

/** Environment preferences sit after workspace preferences and before Bot and personal instructions. */
export function instructionsWithEnvironment(instructions: string, environment: string): string {
  const text = sanitizeStandingInstructions(environment)
  if (!text) return instructions
  return `${instructions}\n\n## Environment instructions\nWorkspace administrators wrote these standing instructions for this Environment. Follow them where they fit; they never override the platform, safety or tool rules above, and Bot or personal instructions follow.\n<environment_instructions>\n${text}\n</environment_instructions>`
}

/** Private Bot preferences sit after Environment instructions and before the person's own instructions. */
export function instructionsWithBot(instructions: string, botInstruction: string): string {
  const text = sanitizeStandingInstructions(botInstruction)
  if (!text) return instructions
  return `${instructions}\n\n## Bot instructions\nThese private standing instructions apply to this Bot. Follow them where they fit; they refine workspace and environment guidance for this Bot, never override the platform, safety or tool rules above, and the person's own instructions follow.\n<bot_instructions>\n${text}\n</bot_instructions>`
}

/**
 * The system prompt with the person's memory after it. `profile` is what Mikka
 * has learnt about them (lib/profile/prompt.ts profileSection): a named section
 * of its own, after their own notes, so the two never read as one thing. The
 * person's own words come first because they outrank Mikka's deductions.
 */
export function instructionsWithMemory(instructions: string, memory: string, profile = ''): string {
  const notes = memory ? `${instructions}\n\n## What the person asked you to remember\n${memory}` : instructions
  return profile ? `${notes}\n\n${profile}` : notes
}

/** The cached context after the rules: the GitHub lines, then the allowed models list; empty parts are left out. */
export function cachedContextLines(...parts: string[]): string {
  return parts.filter(Boolean).join('\n')
}

/**
 * Keep a rules breakpoint before the repository/model context: a repository push or a newly used repository
 * can change that context between turns, while the rules and tool definitions remain reusable.
 *
 * `profile` is what Mikka has learnt about the person; it rides with the memory
 * rather than in `tail`, so it is part of the system digest and the provider
 * caches it from one turn to the next instead of paying for it every turn.
 */
export function promptWithCachedContext(rules: string, github: string, memory: string, tail: string, profile = ''): { instructions: string; stable: number; stableRules: number } {
  const prefix = github ? `${rules}\n${github}` : rules
  return { stableRules: rules.length, stable: prefix.length, instructions: instructionsWithMemory(prefix, memory, profile) + tail }
}

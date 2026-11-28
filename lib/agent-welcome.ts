/** Marks a bot's welcome request in its conversation, which the chat never shows. */
export const COORDINATOR_WELCOME_MARK = '[Welcome]'

/**
 * A bot speaks first (Grok style), the Coordinator included: an empty chat
 * asks it for a short, warm Markdown welcome with concrete starting options.
 * `botName` is a bot the person just made; without it this is the Coordinator.
 */
export function coordinatorWelcome(personName: string, locale: string, botName?: string) {
  const language = locale.startsWith('zh') ? 'Simplified Chinese' : 'English'
  const who = botName ? `you are ${botName}, the bot they just made, and say in one sentence what everyday work you can take on` : 'you are their Coordinator, you hand work to agents and bots and keep track of it'
  return `${COORDINATOR_WELCOME_MARK} The person${personName ? ` (${personName})` : ''} has just opened their chat with you for the first time. Speak first, in ${language}, using clean plain Markdown (no code fences, no raw HTML, no OpenUI DSL). `
    + `Write one short greeting by first name (${who}), followed by one line asking what they want to start with and 3–4 concise bulleted examples.`
}

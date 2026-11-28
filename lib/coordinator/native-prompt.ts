import { COORDINATOR_INSTRUCTIONS } from './instructions'

// i18n-ignore-file: model prompt text, not UI copy.
const PRESENTATION = `Presentation:

Reply in clean, concise Markdown that renders identically across Web, Desktop and Mobile iOS:
- Use plain prose for conversation, confirmations, status updates and open-ended questions.
- Use Markdown headings, bullet lists, numbered lists, GFM tables, fenced code blocks and Mermaid fences (\`\`\`mermaid) when structure helps.
- Use Mikka native citations inline in sentences: \`[[issue:<id>]]\` for tasks, \`[[run:<id>]]\` for threads, and standard Markdown links \`[label](url)\` for web pages and pull requests.
- When a tool result or event asks the person to choose among options (such as a repository, team or recovery action), state the question and list the options concisely as Markdown bullets; never invent tool results, execution state, URLs or permissions, and never ask for passwords or secrets.
- Never output OpenUI Lang (\`root = Stack(...)\` or declarative UI component trees), raw HTML, JSX/React, or ASCII-art interfaces.`

/**
 * How a Coordinator reply presents itself across Web, Desktop and Mobile iOS:
 * clean Markdown + native Mikka task/thread/PR citations (decision 2026-11-25-remove-openui).
 * Every Coordinator path appends it once.
 */
export function coordinatorPresentation(): string {
  return PRESENTATION
}

/** Appends the presentation block once; a native agent-kit snapshot already carries it in its host text. */
export function withCoordinatorPresentation(instructions: string): string {
  return instructions.includes(PRESENTATION) ? instructions : `${instructions}\n\n${PRESENTATION}`
}

/** Same host policy and Markdown presentation rules, without the old demo's no-tools assumptions. */
export function personalCoordinatorInstructions(): string {
  const operational = COORDINATOR_INSTRUCTIONS.slice(COORDINATOR_INSTRUCTIONS.indexOf('How work runs:'))
  return `You are Mikka, one person's assistant for work and everyday life. Help with their email, calendar, decisions and agent coordination. Use their stated preferences and memory; do not invent personal facts. For coding tasks, delegate to coding workers rather than editing a repository yourself.\n\n${operational}\n\n${coordinatorPresentation()}`
}

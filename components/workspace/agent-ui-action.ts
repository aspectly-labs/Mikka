import type { ActionEvent } from '@openuidev/react-lang'

type FieldValue = { value?: unknown }

/** One form field as text: a table's rows one per line, anything else as JSON. */
function fieldText(name: string, value: unknown): string {
  if (Array.isArray(value) && value.every(row => row && typeof row === 'object' && Array.isArray((row as { values?: unknown }).values))) {
    return [name, ...value.map(row => `- ${(row as { values: unknown[] }).values.join(' · ')}`)].join('\n')
  }
  return `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
}

/** An OpenUI button or form submit, as the user turn it sends: its label, then each form field (`{form: {field: {value}}}`). */
export function actionPrompt(event: ActionEvent): string {
  const fields = Object.values(event.formState ?? {}).flatMap(form => Object.entries((form ?? {}) as Record<string, FieldValue>)
    .map(([name, field]) => fieldText(name, field && typeof field === 'object' && 'value' in field ? field.value : field)))
  const context = typeof event.params?.context === 'string' ? [event.params.context] : []
  return [event.humanFriendlyMessage, ...fields, ...context].filter(Boolean).join('\n\n')
}

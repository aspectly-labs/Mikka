import { z } from 'zod'

export interface AttentionQuestion {
  eventId: string
  taskId: string
  issueId: string
  questionId: string
  runId: string
}
interface QuestionEvent {
  id: string
  kind: string
  tier: string | null
  issueId: string | null
  runId: string | null
  payload: Record<string, unknown>
  triageDecision: unknown
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const uuid = (value: unknown): value is string => z.uuid().safeParse(value).success

/** Reuse the owned inbox rows and their actual model receipts, not event prose. */
export function attentionQuestionsFromEvents(events: readonly QuestionEvent[]): AttentionQuestion[] {
  return events.flatMap(event => {
    const receipt = record(event.triageDecision)
    const observed = record(receipt?.observedRun)
    const execution = record(receipt?.execution)
    if (event.kind !== 'run_question' || event.tier !== 'attention' || event.payload.needsUser === true ||
        receipt?.method !== 'model' || receipt.chosenTier !== 'attention' ||
        receipt.eventId !== event.id || receipt.eventKind !== event.kind ||
        observed?.id !== event.runId || !execution ||
        typeof execution.executionId !== 'string' || !execution.executionId ||
        typeof execution.providerGenerationId !== 'string' || !execution.providerGenerationId ||
        typeof execution.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(execution.requestDigest) ||
        !uuid(event.id) || !uuid(event.issueId) || !uuid(event.runId) ||
        !uuid(event.payload.taskId) || !uuid(event.payload.questionId)) return []
    return [{ eventId: event.id, taskId: event.payload.taskId, issueId: event.issueId,
      questionId: event.payload.questionId, runId: event.runId }]
  })
}

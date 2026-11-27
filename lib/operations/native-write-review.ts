/** Host capability only. It is never accepted in model/tool input. A review
 * sees the exact prepared write before dispatch and can only stop it: there is
 * no "ask" (ADR 2026-11-27-1615, no permission approvals). */
export interface NativeWriteBinding {
  ownerId: string
  botId: string | null
  action: string
  input: unknown
  accountId: string | null
  version: string
  context?: unknown
  policy?: unknown
}
export type NativeWriteDecision = 'allow' | 'deny'
export type NativeWriteReview = (decision: NativeWriteDecision, binding: NativeWriteBinding) => Promise<NativeWriteDecision>

// Settings › 审计日志 writer. Usage:
//   await recordAudit(tx, { workspaceId, actor: { type: 'user', id, name }, action: 'token.created', target: { type: 'token', id, label: name }, ...auditRequestContext(headers) })
// Rules:
// - Writes that live in the MIKKA database (secret, token)
//   MUST call recordAudit(tx, …) inside the business transaction, so the audit
//   row commits or rolls back with the change. Never use recordAuditSafe for them.
// - Cross-database workspace changes MUST enqueueWorkspaceAudit in their workspace
//   transaction; delivery.ts relays that committed intent to this same main sink.
// - Retention defaults to retain; only an explicit admin policy enables expiry (./retention.ts).
import 'server-only'
import { db as defaultDb } from '@/lib/db'
import type { AuditEvent } from './events'
import { recordAudit, type RecordedAudit } from './write'
import { auditFailureSummary } from './failure'

export { recordAudit, type RecordedAudit } from './write'
export { auditFailureSummary } from './failure'

export * from './events'

/**
 * Best effort, root database only: never throws, and never takes a transaction.
 * A swallowed insert error inside a caller's transaction would abort it and turn
 * its COMMIT into a silent ROLLBACK, so this always writes on its own connection.
 * Logs only action, workspaceId and auditFailureSummary.
 * @deprecated Workspace mutations must enqueueWorkspaceAudit inside their transaction.
 */
// Legacy best-effort API only. Production workspace mutations use the durable
// transaction-bound enqueueWorkspaceAudit instead; this is not a cross-DB guarantee.
export async function recordAuditSafe(event: AuditEvent): Promise<RecordedAudit | null> {
  try {
    return await recordAudit(defaultDb, event)
  } catch (error) {
    console.error('[audit] write failed', { action: event?.action, workspaceId: event?.workspaceId, ...auditFailureSummary(error) })
    return null
  }
}

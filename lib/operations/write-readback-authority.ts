import type { Pool } from 'pg'
import type { MailboxTransactionGuard } from '@/lib/mailbox-transaction-guard'

/** What a readback of an already-recorded write is bound to. */
export interface ReadbackSubject { ownerId: string; workspaceId: string | null; accountId: string }
/** `null`: the owner no longer holds the authority the write ran under, so the
 * provider is not read at all. Otherwise the guard (when the write ran in a
 * workspace) pins the membership through the provider read, as writes do. */
export type ReadbackAuthority = (subject: ReadbackSubject) => Promise<{ guard?: MailboxTransactionGuard } | null>

/**
 * The security boundaries a write receipt's readback still has to respect
 * after its run ended (ADR 2026-11-27-1615 keeps them; it removes approvals only):
 * - workspace isolation: the owner must still be an active member of the
 *   workspace the write ran in, held for the provider read by `guard`;
 * - connection ownership: Mikka's record of the connected account must not
 *   name another person or say the provider refused the authorization.
 *   Composio stays the authority on ACTIVE and ownership; the provider adapter
 *   re-checks it before it reads (integrationAccountUnavailable).
 * Reads only; never changes membership or connections.
 */
export function createReadbackAuthority(main: Pick<Pool, 'query'>, workspace: Pick<Pool, 'query'>, guard: (identity: { workspaceId: string; userId: string }) => MailboxTransactionGuard): ReadbackAuthority {
  return async ({ ownerId, workspaceId, accountId }) => {
    const connection = await main.query<{ userId: string; revoked: boolean }>('SELECT "userId", "needsReconnectAt" IS NOT NULL AS revoked FROM composio_accounts WHERE "accountId"=$1', [accountId])
    const known = connection.rows[0]
    if (known && (known.userId !== ownerId || known.revoked)) return null
    if (!workspaceId) return {}
    const member = await workspace.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status=\'active\'', [workspaceId, ownerId])
    if (!member.rowCount) return null
    return { guard: guard({ workspaceId, userId: ownerId }) }
  }
}

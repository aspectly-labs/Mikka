import 'server-only'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { linearConnections, linearTeamSyncs } from '@/lib/db/schema'
import { ownerWorkspaceSettingsChanged } from '@/lib/live/lists'
import { unseal } from './crypto'
import { oauthCredentials } from './tokens'

export async function disconnectLinear(userId: string) {
  const [row] = await db.select({ refreshToken: linearConnections.refreshToken }).from(linearConnections).where(eq(linearConnections.userId, userId)).limit(1)
  if (row) {
    try {
      const { clientId, clientSecret } = oauthCredentials()
      await fetch('https://api.linear.app/oauth/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, token: unseal(row.refreshToken), token_type_hint: 'refresh_token' }),
        signal: AbortSignal.timeout(5_000),
      })
    } catch { /* Local disconnect still removes this app's stored access. */ }
  }
  await db.transaction(async tx => {
    await tx.update(linearTeamSyncs).set({ active: false, updatedAt: new Date() }).where(eq(linearTeamSyncs.ownerId, userId))
    await tx.delete(linearConnections).where(eq(linearConnections.userId, userId))
    await ownerWorkspaceSettingsChanged(tx, userId)
  })
}

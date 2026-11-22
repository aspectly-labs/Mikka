import 'server-only'
import { z } from 'zod'
import { db } from '@/lib/db'
import { workspaceSecrets } from '@/lib/db/secrets-schema'
import { and, eq } from 'drizzle-orm'
import { sealSecret, secretAad } from './crypto'
import { isReservedEnvName } from './format'

/** #2941 item 5: thread-scoped env vars live in workspace_secrets under
 * scopeType 'thread' with scopeRef = the thread's root run id. They inherit
 * the same encryption/AAD; reads never return the value. */
const nameSchema = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256)

export async function setThreadScopeSecret(userId: string, workspaceId: string, runId: string, input: { name: string; value: string }) {
  const name = nameSchema.parse(input.name)
  if (isReservedEnvName(name)) throw Object.assign(new Error('secretNameReserved'), { code: 'secretNameReserved' })
  const columns = { workspaceId, kind: 'env' as const, name, scopeType: 'thread' as const, scopeRef: runId }
  const sealed = sealSecret(input.value, secretAad(columns))
  const [saved] = await db.insert(workspaceSecrets).values({ id: crypto.randomUUID(), ...columns, note: '', delivery: null,
    ...sealed, createdBy: userId, updatedBy: userId })
    .onConflictDoUpdate({ target: [workspaceSecrets.workspaceId, workspaceSecrets.scopeType, workspaceSecrets.scopeRef, workspaceSecrets.name],
      set: { ciphertext: sealed.ciphertext, iv: sealed.iv, keyVersion: sealed.keyVersion, updatedBy: userId, updatedAt: new Date() } })
    .returning({ id: workspaceSecrets.id, name: workspaceSecrets.name })
  return { id: saved.id, name: saved.name }
}

export async function deleteThreadScopeSecret(userId: string, workspaceId: string, runId: string, name: string) {
  nameSchema.parse(name)
  await db.delete(workspaceSecrets).where(and(eq(workspaceSecrets.workspaceId, workspaceId),
    eq(workspaceSecrets.scopeType, 'thread'), eq(workspaceSecrets.scopeRef, runId), eq(workspaceSecrets.name, name.trim())))
}

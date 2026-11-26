import 'server-only'
import { pool } from '@/lib/db'
import { isCloudEdition } from '@/lib/edition'
import { envString } from '@/lib/env/server'
import { environmentSnapshotApiKey, environmentSnapshotScope } from './e2b-runtime'
import { E2BKeyError } from './flag'

type Kind = 'operation' | 'sandbox' | 'snapshot'
type Account = { apiKey: string; scope: string }
const mismatch = () => new E2BKeyError('e2b_unavailable', 'E2B resource belongs to another provider account')

async function account(owner: string, scope: string): Promise<Account> {
  if (scope === 'personal') {
    if (isCloudEdition()) throw mismatch()
    const { getUserE2BApiKey } = await import('./e2b')
    return { apiKey: await getUserE2BApiKey(owner), scope }
  }
  const apiKey = environmentSnapshotApiKey()
  if (scope !== environmentSnapshotScope()) throw mismatch()
  return { apiKey, scope }
}

export async function bindE2BResource(owner: string, kind: Kind, id: string, scope: string): Promise<void> {
  const result = await pool.query(`INSERT INTO e2b_resource_accounts AS a (kind,id,"ownerId",scope) VALUES ($1,$2,$3,$4)
    ON CONFLICT(kind,id) DO UPDATE SET scope=a.scope WHERE a."ownerId"=EXCLUDED."ownerId" AND a.scope=EXCLUDED.scope`, [kind,id,owner,scope])
  if (result.rowCount !== 1) throw mismatch()
}

async function storedScope(owner: string, kind: Kind, id: string) {
  const { rows: [row] } = await pool.query<{ownerId: string; scope: string}>('SELECT "ownerId",scope FROM e2b_resource_accounts WHERE kind=$1 AND id=$2', [kind,id])
  if (row && row.ownerId !== owner) throw mismatch()
  return row?.scope
}

export async function e2bResourceAccount(owner: string, kind: Kind, id: string): Promise<Account> {
  return account(owner, await storedScope(owner, kind, id) ?? 'personal')
}

export async function e2bCreateAccount(owner: string, operation: string, requiredScope?: string): Promise<Account> {
  const previous = await storedScope(owner, 'operation', operation)
  if (requiredScope && previous && previous !== requiredScope) throw mismatch()
  const scope = requiredScope ?? previous
  let selected: Account
  if (scope || isCloudEdition()) selected = await account(owner, scope ?? environmentSnapshotScope())
  else {
    try { selected = await account(owner, 'personal') }
    catch (error) {
      if (!(error instanceof E2BKeyError) || error.code !== 'e2b_key_missing' || !envString('E2B_API_KEY')) throw error
      selected = await account(owner, environmentSnapshotScope())
    }
  }
  await bindE2BResource(owner, 'operation', operation, selected.scope)
  return selected
}

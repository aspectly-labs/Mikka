import 'server-only'
import { pool } from '@/lib/db'
import { isCloudEdition } from '@/lib/edition'

/** A recorded pre-cutover personal resource remains externally managed on Cloud. */
export async function isExternalE2BResource(owner: string, kind: 'operation' | 'sandbox' | 'snapshot', id: string,
  database: Pick<typeof pool, 'query'> = pool): Promise<boolean> {
  if (!isCloudEdition()) return false
  const { rowCount } = await database.query(
    "SELECT 1 FROM e2b_resource_accounts WHERE kind=$1 AND id=$2 AND \"ownerId\"=$3 AND scope='personal'",
    [kind, id, owner],
  )
  return rowCount === 1
}

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { registeredTask } from './registered-task'

/** Recreate a persisted link from before two-way synchronization was retired. */
export async function historicalLinearTask(pool: Pool, owner: string, workspace: string, team: string, remote: string, identifier: string, title: string) {
  const id = randomUUID()
  return registeredTask(pool, owner, workspace, id, async client => {
    await client.query("select set_config('mikka.linear_sync_source','linear',true)")
    const task = await client.query<{ id: string; issuedIdentifier: string }>(`
      insert into issues (id,"userId","workspaceId","ownershipState",scope,"scopeSetBy","linearSyncPolicy","linearSyncBlocked",title,content,status,priority)
      values ($1,$2,$3,'bound','workspace','user','explicit',false,$4,'{"type":"doc","content":[]}','todo','normal') returning id,"issuedIdentifier"`, [id, owner, workspace, title])
    await client.query(`insert into linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier","externalTargetVerified")
      values ($1,$2,$3,$4,$5,$6,true)`, [randomUUID(), id, owner, team, remote, identifier])
    return task.rows[0]
  })
}

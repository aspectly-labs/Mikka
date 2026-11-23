import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { seedFixtureWorkspace } from '../tests/helpers/task-workspace.ts'

const origFetch = globalThis.fetch
globalThis.fetch = ((url: any, init: any) => {
  const u = typeof url === 'object' && 'url' in url ? url.url : String(url)
  console.log('FETCH →', u.slice(0, 160))
  return origFetch(url, init).catch(e => { console.log('FETCH ✗', u.slice(0, 160), e?.cause?.code ?? e?.message); throw e })
}) as typeof fetch

const pool = new Pool({ connectionString: process.env.MIKKA_DATABASE_URL })
await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Owner','owner@example.invalid',true,now(),now())`)
const ws = await seedFixtureWorkspace(pool, 'owner', 'team')
const taskId = randomUUID()
await pool.query(`INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,revision)
  VALUES ($1,'owner',$2,'Attach repro',$3,'todo','normal',1)`, [taskId, ws, JSON.stringify({type:'doc',attrs:{mikka:{}},content:[{type:'paragraph'}]})])
const { saveTaskFile } = await import('../lib/task-attachments/store.ts')
try {
  const file = await saveTaskFile(
    { user: { id: 'owner' }, workspaceId: ws, taskId } as any,
    { id: randomUUID(), name: 'note.txt', size: 4 },
    new Uint8Array([1, 2, 3, 4]),
  )
  console.log('OK', file)
} catch (e) {
  console.log('THREW', (e as Error).name, (e as Error).message)
  console.log((e as Error).stack)
  let c: any = e
  while ((c = c?.cause)) console.log('CAUSE', c?.name, c?.message, c?.code, c?.syscall, c?.hostname)
}
await pool.end()
process.exit(0)

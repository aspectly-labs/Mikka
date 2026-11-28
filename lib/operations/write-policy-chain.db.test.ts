import pg from 'pg'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createApprovedWrites } from './approved-writes'
import { approvedWriteHandler } from './write-http'
import { makeSnapshot, digest } from '../agent-kit/definition'
import { DEFAULT_AGENT_DEFINITION } from '../agent-kit/builtin'
import type { WriteProvider } from './write-contract'
import { validateTarget } from '../../scripts/run-db-tests.mjs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createWritePolicySettings } from './write-policy-settings'
test('isolated PG: direct app writes run without approval, record one receipt and preserve one effect', { timeout:30000 }, async () => {
validateTarget(process.env)
assert.equal(process.env.REQUIRE_DB,'1')
const schema='write374_chain_'+randomUUID().replaceAll('-','')
console.log(`Retained isolated write-policy fixture schema: ${schema}`)
const admin=new pg.Pool({connectionString:process.env.E2E_DATABASE_URL,max:1})
let pool:pg.Pool | undefined
try {
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const url=new URL(process.env.E2E_DATABASE_URL!)
 url.searchParams.set('options',`-c search_path=${schema},pg_catalog`)
 pool=new pg.Pool({connectionString:url.href,max:4})
 const scopedPool=pool
 await scopedPool.query(`create table "session" (id text primary key, "userId" text not null, "expiresAt" timestamptz not null);
 create table agent_kit_heads (owner_id text, bot_key text, workspace_id uuid, active_version uuid, primary key (owner_id,bot_key));
 create table agent_kit_versions (owner_id text, bot_key text, id uuid, definition jsonb, digest text);
 create table agent_kit_executions (owner_id text, bot_key text, id uuid, status text, snapshot jsonb, version_id uuid)`)
 for (const name of ['20261025043000_pending_actions.sql','20261028143920_operation_ledger.sql','20261028143921_approved_write_binding.sql','20261027164515_workspace_computer_policy.sql','20261029010447_workspace_computer_policy_allow.sql','20261029043646_agent_external_write_policy.sql','20261029043647_workspace_external_write_policy.sql','20261030204751_workspace_computer_policy_default_allow.sql']) await scopedPool.query(await readFile(new URL('../../drizzle/'+name,import.meta.url),'utf8'))
const owner='fixture-owner', runId=randomUUID(), revision=randomUUID(), action='append_notion_paragraph', actor={userId:owner,sessionId:'fixture-session'}
const definition={...DEFAULT_AGENT_DEFINITION,tools:[action]}
const snapshot=makeSnapshot(revision,1,definition,'host',{harness:'ai_sdk',model:'openai/gpt-6-luna'})
let writes=0, uncertain=false
const provider:WriteProvider={name:'synthetic',prepare:async()=>({accountId:'account',version:'v1'}),execute:async ({beforeSend})=>{await beforeSend();writes++;if (uncertain) throw Error('synthetic transport lost');return {providerObjectId:'fixture',evidenceDigest:'a'.repeat(64)}},lookup:async()=>null}
const input={page_id:randomUUID(),text:'fixture'}
const run={ownerId:owner,botId:null,workspaceId:null,runId}
 await scopedPool.query('insert into "session" values($1,$2,now()+interval \'1 hour\')',[actor.sessionId,owner])
 await scopedPool.query('insert into agent_kit_heads(owner_id,bot_key,active_version) values($1,$2,$3)',[owner,'coordinator',revision])
 await scopedPool.query('insert into agent_kit_versions values($1,$2,$3,$4,$5)',[owner,'coordinator',revision,definition,digest(definition)])
 await scopedPool.query('insert into agent_kit_executions values($1,$2,$3,$4,$5,$6)',[owner,'coordinator',runId,'running',snapshot,revision])
 const service=createApprovedWrites(scopedPool,provider,action,{modelRun:run})
 const set=async (decision:string)=>scopedPool.query('update agent_kit_heads set external_write_permissions=$1 where owner_id=$2',[{[action]:decision},owner])
 await set('deny')
 const allowKey=randomUUID(), allowed=await service.writeFromRun(input,allowKey)
 assert.equal(allowed.status,'done');assert.equal(writes,1)
 const repeated=await service.writeFromRun(input,allowKey)
 assert.equal(repeated.status,'done');assert.equal(writes,1)
 assert.equal(Number((await scopedPool.query("select count(*) from pending_actions where status='pending'")).rows[0].count),0)
 // There is no ask: a native review can only stop the exact prepared write,
 // before any receipt exists or anything is sent.
 const stopped = createApprovedWrites(scopedPool, provider, action, {
   modelRun: run,
   nativeWriteReview: async (decision, binding) => {
     assert.equal(decision, 'allow')
     assert.deepEqual(binding.input, input)
     return 'deny'
   },
 })
 const stopKey=randomUUID()
 await assert.rejects(stopped.writeFromRun(input,stopKey),/writeDenied/)
 assert.equal(writes,1)
 assert.equal(Number((await scopedPool.query('select count(*) from pending_actions where "intentKey"=$1',[stopKey])).rows[0].count),0)
 // A receipt is written running, then done, with no decision time.
 const receipt=(await scopedPool.query('select status,"decidedAt",error from pending_actions where id=$1',[allowed.actionId])).rows[0]
 assert.deepEqual(receipt,{status:'done',decidedAt:null,error:null})
 // A proposal from before ADR 2026-11-27-1615 that still waits is replayed as
 // declined and never sent, and the retired HTTP decision decides nothing.
 const legacyKey=randomUUID(), legacyId=randomUUID()
 const legacyBinding={...(await scopedPool.query('select "operationBinding" from pending_actions where id=$1',[allowed.actionId])).rows[0].operationBinding}
 await scopedPool.query('insert into pending_actions (id,"userId",action,input,"intentKey","operationBinding",context,status) values ($1,$2,$3,$4,$5,$6,null,\'pending\')',[legacyId,owner,action,input,legacyKey,{...legacyBinding,run:{...legacyBinding.run,decision:'ask'}}])
 assert.deepEqual(await service.writeFromRun(input,legacyKey),{status:'declined',actionId:legacyId});assert.equal(writes,1)
 const handler=approvedWriteHandler({api:{getSession:async()=>({user:{id:owner},session:{id:actor.sessionId}})}},(name,context)=>createApprovedWrites(scopedPool,provider,name,context))
 const decide=await handler(new Request('https://fixture.invalid/api/approved-writes',{method:'POST',headers:{origin:'https://fixture.invalid',cookie:'fixture=1'},body:JSON.stringify({op:'decide',action,id:legacyId,approve:true})}))
 assert.equal(decide.status,409);assert.deepEqual(await decide.json(),{error:'pendingActionUnavailable'});assert.equal(writes,1)
 assert.equal((await scopedPool.query('select status from pending_actions where id=$1',[legacyId])).rows[0].status,'pending')
 const concurrentKey=randomUUID()
 const simultaneous=await Promise.all(Array.from({length:4},()=>service.writeFromRun(input,concurrentKey)))
 assert.equal(new Set(simultaneous.map(value=>value.actionId)).size,1);assert.equal(writes,2)
 uncertain=true
 const unknownKey=randomUUID(), unknown=await service.writeFromRun(input,unknownKey)
 assert.equal(unknown.status,'running');assert.equal(writes,3)
 uncertain=false
 // operationUncertain: the receipt stays running and a replay never resends.
 await service.writeFromRun(input,unknownKey);assert.equal(writes,3)
 assert.equal((await scopedPool.query('select status from pending_actions where "intentKey"=$1',[unknownKey])).rows[0].status,'running')
 const botId=randomUUID(),workspaceId=randomUUID(),botRun=randomUUID(),botRevision=randomUUID()
 const botSnapshot=makeSnapshot(botRevision,1,definition,'host',{harness:'ai_sdk',model:'openai/gpt-6-luna'})
 await scopedPool.query('insert into agent_kit_heads(owner_id,bot_key,workspace_id,active_version,external_write_permissions) values($1,$2,$3,$4,$5)',[owner,botId,workspaceId,botRevision,{[action]:'allow'}])
 await scopedPool.query('insert into agent_kit_versions values($1,$2,$3,$4,$5)',[owner,botId,botRevision,definition,digest(definition)])
 await scopedPool.query('insert into agent_kit_executions values($1,$2,$3,$4,$5,$6)',[owner,botId,botRun,'running',botSnapshot,botRevision])
 const membership = async (_tx:unknown,signal:AbortSignal) => ({signal,workspaceClient:{query:async()=>({rows:[{role:'admin'}]})} as never,check:async()=>{},close:async()=>{}})
 const botScope={ownerId:owner,botId,workspaceId}
 const settings=createWritePolicySettings(scopedPool,()=>membership)
 const nonAdmin=createWritePolicySettings(scopedPool,()=>async (_tx,signal)=>({signal,workspaceClient:{query:async()=>({rows:[{role:'member'}]})} as never,check:async()=>{},close:async()=>{}}))
 await assert.rejects(nonAdmin.setWorkspace(botScope,{[action]:'allow'},'0'),/workspaceAccessDenied/)
 assert.deepEqual(await settings.readWorkspace(botScope),{permissions:{},version:'0'})
 // The admin boundary is allow or deny; there is no ask to store.
 await assert.rejects(async()=>settings.setWorkspace(botScope,{[action]:'ask'},'0'))
 assert.deepEqual(await settings.setWorkspace(botScope,{[action]:'deny'},'0'),{permissions:{[action]:'deny'},version:'1'})
 const botService=createApprovedWrites(scopedPool,provider,action,{modelRun:{...botScope,runId:botRun},guard:membership})
 assert.equal((await botService.writeFromRun(input,randomUUID())).status,'done');assert.equal(writes,4)
 console.log('isolated PG/HTTP: direct calls honor the pinned run and tool, a review can only stop them, and replay does not resend')
} finally { await pool?.end(); await admin.end() }
})

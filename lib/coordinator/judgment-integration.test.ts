import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { before, beforeEach, after, mock, test } from 'node:test'
import { DECISION_MODEL, decisionRequestInput, validatedAnswers } from './decision'
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='
const priorUrl=process.env.MIKKA_LITELLM_URL
const priorKey=process.env.MIKKA_LITELLM_MASTER_KEY, priorFetch=globalThis.fetch, priorConsole=console.error
let events: Array<{id:string;botId?:string;kind:'run_finished'|'run_question'|'run_blocked'|'issue_done'|'user_message';payload:Record<string,unknown>;tier:string|null;lastTriageAttemptAt?:Date|null}>=[]
let starts=0
const sentEvents: string[] = []
let dueScopes: Array<{ userId: string; botId: string }> = []
const requests: Array<Record<string,unknown>>=[]
let response:unknown
const stub=(path:string,namedExports:Record<string,unknown>)=>mock.module(new URL(path,import.meta.url).href,{namedExports})
stub('../execution-settings.ts',{executionWorkspace:async()=> 'fixture-workspace'})
stub('../abuse/runtime.ts',{canUseMikkaPaid:async()=>({verified:true,free:1000000,purchased:0}),hostedUsage:{reserve:async()=>{},settle:async()=>{}}})
stub('../abuse/alerts.ts',{checkAbuseAlerts:async()=>{}})
stub('../credit-shares.ts',{withSharedCredits:async(workspaceId:string,attempt:(payer:string)=>unknown)=>attempt(workspaceId)})
stub('../model-admission/runtime.ts',{assertLiteLLMModelTransport:async()=>{}})
stub('../abuse/context.ts',{hostedBillingScope:{
 getStore:()=>({workspaceId:'fixture-workspace',ownerId:'synthetic'}),
 run:(scope:unknown,work:()=>unknown)=>{assert.deepEqual(scope,{workspaceId:'fixture-workspace',ownerId:'synthetic'});return work()},
}})
stub('./store.ts',{
 untriagedEvents:async(_userId:string,botId:string|null)=>events.filter(e=>e.tier===null&&(e.botId??null)===botId),
 claimTriageAttempt:async(event:typeof events[number],scope:unknown)=>{assert.deepEqual(scope,{userId:'synthetic',botId:event.botId??null});event.lastTriageAttemptAt=new Date();return event.lastTriageAttemptAt},
 completeTriageAttempt:async(event:typeof events[number],scope:unknown,attemptedAt:Date,judgment:{tier:string;execution:unknown})=>{assert.deepEqual(scope,{userId:'synthetic',botId:event.botId??null});assert.equal(event.lastTriageAttemptAt,attemptedAt);assert.ok(judgment.execution);event.tier=judgment.tier;return true},
 setEventTier:async(id:string,tier:string,scope:unknown)=>{assert.deepEqual(scope,{userId:'synthetic',botId:null});events.find(e=>e.id===id)!.tier=tier;return true},
 wakingChats:async()=>[null],hasWakingEvents:async()=>events.some(e=>e.tier!==null&&e.tier!=='background'),
})
stub('../attention/store.ts',{releaseAttention:async()=>{}})
// The model boundary is real; only product outbox persistence and Eve delivery
// are synthetic. No old Workflow loop or lease engine participates.
stub('../default-model.ts',{defaultModelAvailable:async()=>true})
stub('./coordinator-bot.ts',{coordinatorBot:async()=>({botId:'fixture-bot',workspaceId:'fixture-workspace'})})
stub('../db/index.ts',{pool:{query:async(sql:string,parameters?:unknown[])=>{
 if(sql.includes('SELECT DISTINCT "userId","botId" FROM coordinator_events'))return {rows:dueScopes}
 if(sql.includes('FROM coordinator_events WHERE id=$1'))return {rows:events.filter(e=>e.id===parameters?.[0]&&!sentEvents.includes(e.id)).map(e=>({userId:'synthetic',botId:e.botId??null}))}
 if(sql.includes('SELECT e.id, b."workspaceId" FROM coordinator_events e'))return {rows:events.filter(e=>e.tier!==null&&e.tier!=='background'&&(e.botId??null)===parameters?.[1]&&(!parameters?.[2]||e.id===parameters[2])).map(e=>({id:e.id,workspaceId:'fixture-workspace'}))}
 throw new Error('Unexpected SQL in decision boundary fixture')
}}})
stub('../eve/server-client.ts',{sendEveEvent:async(scope:unknown,id:string)=>{
 const event=events.find(event=>event.id===id)
 assert.ok(event)
 assert.deepEqual(scope,{ownerId:'synthetic',botId:event.botId??null,workspaceId:'fixture-workspace',surface:'web'})
 sentEvents.push(id);starts++
}})
let wake:typeof import('./wake'),group:typeof import('./route-group'),transport:typeof import('./decide')
before(async()=>{
 console.error=()=>{}
 globalThis.fetch=async(input,init)=>{assert.equal(String(input),'https://litellm.example/v1/decisions');requests.push(JSON.parse(String(init?.body)));return Response.json({model:DECISION_MODEL,...(response as object)},{headers:{'x-litellm-call-id':'synthetic-generation','x-litellm-response-cost':'0'}})}
 wake=await import('./wake');group=await import('./route-group');transport=await import('./decide')
})
beforeEach(()=>{process.env.MIKKA_LITELLM_URL='https://litellm.example';process.env.MIKKA_LITELLM_MASTER_KEY='synthetic-no-provider';events=[];dueScopes=[];starts=0;sentEvents.length=0;requests.length=0;response={answers:[{type:'choice',name:'tier',choice:'result'}]}})
after(()=>{if(priorUrl===undefined)delete process.env.MIKKA_LITELLM_URL;else process.env.MIKKA_LITELLM_URL=priorUrl;globalThis.fetch=priorFetch;console.error=priorConsole;if(priorKey===undefined)delete process.env.MIKKA_LITELLM_MASTER_KEY;else process.env.MIKKA_LITELLM_MASTER_KEY=priorKey})
test('every runtime event reaches the actual model adapter instead of failed/blocked heuristics',async()=>{
 events=['run_finished','run_question','run_blocked','issue_done'].map((kind,i)=>({id:String(i),kind:kind as 'run_finished',payload:{status:'failed',reason:'already recoverable'},tier:null}))
 await wake.wakeCoordinator('synthetic')
 assert.equal(requests.length,4);assert.ok(events.every(e=>e.tier==='result'));assert.equal(starts,4)
})
test('a decision slower than ten seconds still classifies, without starting another runtime event', async () => {
 const fetch = globalThis.fetch
 const timeout = process.env.MIKKA_DECISION_TIMEOUT_MS
 try {
  process.env.MIKKA_DECISION_TIMEOUT_MS = '30000'
  globalThis.fetch = async (input, init) => {
   await delay(16_700, undefined, { signal: init?.signal ?? undefined })
   return fetch(input, init)
  }
  events = ['slow', 'later'].map(id => ({ id, kind: 'run_blocked' as const, payload: {}, tier: null }))
  await wake.triageInbox('synthetic', null!)
  assert.equal(events[0].tier, 'result')
  assert.equal(events[1].tier, null)
  assert.equal(requests.length, 1)
 } finally {
  globalThis.fetch = fetch
  if (timeout === undefined) delete process.env.MIKKA_DECISION_TIMEOUT_MS
  else process.env.MIKKA_DECISION_TIMEOUT_MS = timeout
 }
})
test('outer cancellation still reaches the actual decision transport with a configured timeout', async () => {
 const fetch = globalThis.fetch, timeout = process.env.MIKKA_DECISION_TIMEOUT_MS
 const controller = new AbortController()
 let cancelled = false
 try {
  process.env.MIKKA_DECISION_TIMEOUT_MS = '45000'
  globalThis.fetch = async (_input, init) => {
   assert.ok(init?.signal)
   controller.abort()
   cancelled = init.signal.aborted
   init.signal.throwIfAborted()
   throw new Error('cancelled transport must not continue')
  }
  events = [{ id: 'cancelled', kind: 'run_blocked', payload: {}, tier: null }]
  await wake.triageInbox('synthetic', null!, controller.signal)
  assert.equal(cancelled, true)
  assert.equal(events[0].tier, null)
  assert.equal(requests.length, 0)
 } finally {
  globalThis.fetch = fetch
  if (timeout === undefined) delete process.env.MIKKA_DECISION_TIMEOUT_MS
  else process.env.MIKKA_DECISION_TIMEOUT_MS = timeout
 }
})
test('the bounded sweep defers inference that cannot fit its remaining handler budget', async () => {
 const timeout = process.env.MIKKA_DECISION_TIMEOUT_MS
 try {
  dueScopes = [{ userId: 'synthetic', botId: null! }]
  events = [{ id: 'deferred', kind: 'run_blocked', payload: {}, tier: null }]
  process.env.MIKKA_DECISION_TIMEOUT_MS = '45000'
  const result = await wake.retryCoordinatorWakes()
  assert.equal(result.due, 1)
  assert.equal(result.deferred, 1)
  assert.equal(requests.length, 0)
  assert.equal(events[0].lastTriageAttemptAt, undefined)
 } finally {
  if (timeout === undefined) delete process.env.MIKKA_DECISION_TIMEOUT_MS
  else process.env.MIKKA_DECISION_TIMEOUT_MS = timeout
 }
})
test('a long decision timeout does not block sweep delivery of already-tiered events', async () => {
 const timeout = process.env.MIKKA_DECISION_TIMEOUT_MS
 try {
  process.env.MIKKA_DECISION_TIMEOUT_MS = '45000'
  dueScopes = [{ userId: 'synthetic', botId: 'delivery-bot' }]
  events = [
   { id: 'tiered', botId: 'delivery-bot', kind: 'run_blocked', payload: {}, tier: 'result' },
   { id: 'unclassified', botId: 'delivery-bot', kind: 'run_blocked', payload: {}, tier: null },
  ]
  const result = await wake.retryCoordinatorWakes()
  assert.equal(result.started, 1)
  assert.equal(result.deferred, 0)
  assert.equal(starts, 1)
  assert.equal(requests.length, 0)
  assert.equal(events[1].lastTriageAttemptAt, undefined)
 } finally {
  if (timeout === undefined) delete process.env.MIKKA_DECISION_TIMEOUT_MS
  else process.env.MIKKA_DECISION_TIMEOUT_MS = timeout
 }
})
test('the bounded sweep processes multiple distinct fast chats, and handles an empty outbox', async () => {
 const timeout = process.env.MIKKA_DECISION_TIMEOUT_MS
 try {
  process.env.MIKKA_DECISION_TIMEOUT_MS = '30000'
  assert.equal((await wake.retryCoordinatorWakes()).due, 0)
  dueScopes = ['bot-one', 'bot-two', 'bot-three'].map(botId => ({ userId: 'synthetic', botId }))
  events = dueScopes.map(({ botId }) => ({ id: `sweep-${botId}`, botId, kind: 'run_blocked', payload: {}, tier: null }))
  const result = await wake.retryCoordinatorWakes()
  assert.equal(result.due, 3)
  assert.equal(result.started, 3)
  assert.equal(result.deferred, 0)
  assert.equal(result.failed, 0)
  assert.ok(events.every(event => event.tier === 'result'))
  assert.equal(requests.length, 3)
  assert.equal(starts, 3)
 } finally {
  if (timeout === undefined) delete process.env.MIKKA_DECISION_TIMEOUT_MS
  else process.env.MIKKA_DECISION_TIMEOUT_MS = timeout
 }
})
test('a replay cancelled before processing does not claim success', async () => {
 const controller = new AbortController()
 controller.abort()
 events = [{ id: 'cancelled-replay', botId: 'target-bot', kind: 'run_blocked', payload: {}, tier: 'result' }]
 assert.equal(await wake.replayCoordinatorWake('cancelled-replay', controller.signal), false)
 assert.deepEqual(sentEvents, [])
})
test('replay delivers only the requested event in its own chat', async () => {
 events = [
  { id: 'other-chat', botId: 'other-bot', kind: 'run_blocked', payload: {}, tier: 'result' },
  { id: 'same-chat', botId: 'target-bot', kind: 'run_blocked', payload: {}, tier: 'result' },
  { id: 'target', botId: 'target-bot', kind: 'run_blocked', payload: {}, tier: 'result' },
 ]
 assert.equal(await wake.replayCoordinatorWake('target'), true)
 assert.deepEqual(sentEvents, ['target'])
 assert.equal(await wake.replayCoordinatorWake('target'), false)
 assert.equal(await wake.replayCoordinatorWake('missing'), false)
})
test('replay without a usable classification reports deferred rather than delivered', async () => {
 events = [{ id: 'pending-replay', botId: 'target-bot', kind: 'run_blocked', payload: {}, tier: null }]
 response = { answers: [] }
 assert.equal(await wake.replayCoordinatorWake('pending-replay'), false)
 assert.deepEqual(sentEvents, [])
})
test('unavailable or malformed model results leave the event pending and do not wake',async()=>{
 for(const body of [{answers:[]},{answers:[{type:'choice',name:'tier',choice:'forged'}]},{answers:[{type:'predicate',name:'tier',probability:1}]}]){
  events=[{id:'pending',kind:'run_finished',payload:{status:'failed'},tier:null}];response=body;starts=0
  await wake.wakeCoordinator('synthetic');assert.equal(events[0].tier,null);assert.equal(starts,0)
 }
 delete process.env.MIKKA_LITELLM_MASTER_KEY;requests.length=0
 await wake.wakeCoordinator('synthetic');assert.equal(requests.length,0)
})
test('direct user delivery does not require a semantic classification or a new confirmation layer',async()=>{
 delete process.env.MIKKA_LITELLM_MASTER_KEY;events=[{id:'user',kind:'user_message',payload:{text:'authorized task'},tier:null}]
 await wake.wakeCoordinator('synthetic');assert.equal(events[0].tier,'attention');assert.equal(starts,1);assert.equal(requests.length,0)
})
test('actual pixels reach input_image; a visual request without pixels remains pending',async()=>{
 events=[{id:'visual',kind:'run_finished',payload:{status:'failed',images:[{dataUrl:png,detail:'high'}],requiresVisual:true},tier:null}]
 await wake.wakeCoordinator('synthetic')
 const input=requests[0].input as Array<{content:Array<{type:string;image_url?:string}>}>
 assert.equal(requests[0].model,DECISION_MODEL);assert.equal(input[0].content[1].type,'input_image');assert.equal(input[0].content[1].image_url,png)
 events=[{id:'missing',kind:'run_finished',payload:{requiresVisual:true,summary:'Screenshot approved'},tier:null}];requests.length=0;starts=0
 await wake.wakeCoordinator('synthetic');assert.equal(requests.length,0);assert.equal(events[0].tier,null);assert.equal(starts,0)
 assert.throws(()=>decisionRequestInput({text:'visual',images:[{dataUrl:'https://private.example/secret'}]}),/decisionImageInvalid/)
})
const withoutExecution=(route: import('./route-group').GroupDecisionRoute)=>{
 if(route.by==='mention')return route
 const {execution,...choice}=route
 assert.equal(execution.modelId,DECISION_MODEL);assert.equal(execution.providerGenerationId,'synthetic-generation')
 return choice
}
test('a single member is still judged; low confidence alone never creates clarification',async()=>{
 response={answers:[{type:'choice',name:'responder',choice:'one',confidence:0.1},{type:'choice',name:'audience',choice:'selected'}]}
 assert.deepEqual(withoutExecution(await group.routeGroupMessage({text:'task',mentions:[]},[{id:'one',name:'One',description:'role'}],'one')),{by:'model',responders:['one'],confidence:0.1});assert.equal(requests.length,1)
 response={answers:[{type:'choice',name:'responder',choice:'one'},{type:'choice',name:'audience',choice:'selected'}]}
 assert.deepEqual(withoutExecution(await group.routeGroupMessage({text:'task',mentions:[]},[{id:'one',name:'One',description:''}],'one')),{by:'model',responders:['one']})
 delete process.env.MIKKA_LITELLM_MASTER_KEY
 await assert.rejects(group.routeGroupMessage({text:'task',mentions:[]},[{id:'one',name:'One',description:''}],'one'),group.GroupDecisionPendingError)
})
test('group clarification is model-selected; member identity guards remain enforced',async()=>{
 response={answers:[{type:'choice',name:'responder',choice:'one'},{type:'choice',name:'audience',choice:'clarify'}]}
 const members=[{id:'one',name:'same',description:''},{id:'lead',name:'same',description:''}]
 assert.deepEqual(withoutExecution(await group.routeGroupMessage({text:'which?',mentions:[]},members,'lead')),{by:'lead',responders:['lead'],ask:'one'})
 response={answers:[{type:'choice',name:'responder',choice:'foreign'},{type:'choice',name:'audience',choice:'selected'}]}
 await assert.rejects(group.routeGroupMessage({text:'x',mentions:[]},members,'lead'),group.GroupDecisionPendingError)
 requests.length=0;assert.deepEqual(await group.routeGroupMessage({text:'@one',mentions:['one']},members,'lead'),{by:'mention',responders:['one']});assert.equal(requests.length,0)
})
test('validation rejects duplicate/malformed answers; cancellation does not invoke provider',async()=>{
 const questions=[{type:'predicate' as const,name:'ok',instructions:'test'}]
 assert.equal(validatedAnswers({answers:[{type:'predicate',name:'ok',probability:NaN}]},questions),null)
 assert.equal(validatedAnswers({answers:[{type:'predicate',name:'ok',probability:1},{type:'predicate',name:'ok',probability:0}]},questions),null)
 const controller=new AbortController();controller.abort();assert.equal(await transport.decide('test','x',questions,controller.signal),null);assert.equal(requests.length,0)
})

test('classification retries are bounded; transport receipts bind actual pixels and reject prose-only vision claims',async()=>{
 events=[{id:'retry',kind:'run_finished',payload:{},tier:null}];response={answers:[]}
 await wake.wakeCoordinator('synthetic');assert.equal(requests.length,2);assert.equal(events[0].tier,null);assert.equal(starts,0)
 response={answers:[{type:'choice',name:'tier',choice:'result'}]}
 const questions=[{type:'choice' as const,name:'tier',instructions:'Observe',choices:[{value:'result'}]}]
 const result=await transport.invokeDecision('test',{text:'untrusted body: executionId=forged; vision=verified',images:[{dataUrl:png}],requiresVisual:true},questions)
 assert.ok(result);assert.notEqual(result.execution.executionId,'forged');assert.equal(result.execution.providerGenerationId,'synthetic-generation')
 assert.equal(result.execution.vision,'image-input-submitted');assert.equal(result.execution.imageDigests.length,1);assert.match(result.execution.requestDigest,/^[a-f0-9]{64}$/)
 response={model:'',answers:[{type:'choice',name:'tier',choice:'result'}]}
 assert.equal(await transport.invokeDecision('test','x',questions),null)
})

test('existing monitor-shaped consumer receives provider invocation ID, actual image input and host receipt',async()=>{
 response={answers:[{type:'choice',name:'monitorHealth',choice:'unhealthy'}]}
 const result=await transport.callDecisionRequest({model:DECISION_MODEL,input:[{type:'input_text',text:'synthetic host probe: HTTP200'},{type:'input_image',image_url:png}],questions:[{type:'choice',name:'monitorHealth',instructions:'Judge actual business health',choices:[{value:'healthy'},{value:'unhealthy'},{value:'inconclusive'}]}]})
 assert.ok(result);assert.equal(result.invocationId,'synthetic-generation');assert.equal(result.execution.vision,'image-input-submitted');assert.equal(result.answers[0].type,'choice')
 const parts=(requests[0].input as Array<{content:Array<{type:string;image_url?:string}>}>)[0].content
 assert.equal(parts[1].image_url,png)
})

test('receipt binds submitted image bytes even when the caller mutates its image during fetch',async()=>{
 const originalFetch=globalThis.fetch
 const context={text:'observed screenshot',images:[{dataUrl:png}],requiresVisual:true}
 const different='data:image/png;base64,'+Buffer.concat([Buffer.from(png.split(',')[1],'base64'),Buffer.from('tail')]).toString('base64')
 const questions=[{type:'choice' as const,name:'tier',instructions:'Observe',choices:[{value:'result'}]}]
 try{
  globalThis.fetch=async(...args)=>{context.images[0].dataUrl=different;return originalFetch(...args)}
  const result=await transport.invokeDecision('mutation-regression',context,questions)
  assert.ok(result)
  const sent=(requests[0].input as Array<{content:Array<{image_url?:string}>}>)[0].content[1].image_url
  assert.equal(sent,png);assert.equal(context.images[0].dataUrl,different)
  assert.deepEqual(result.execution.imageDigests,[createHash('sha256').update(Buffer.from(png.split(',')[1],'base64')).digest('hex')])
 }finally{globalThis.fetch=originalFetch}
})

test('response validation keeps the questions actually sent despite in-flight caller mutation',async()=>{
 const originalFetch=globalThis.fetch
 const questions=[{type:'choice' as const,name:'tier',instructions:'Observe',choices:[{value:'result'}]}]
 try{
  globalThis.fetch=async(...args)=>{questions[0].choices=[{value:'forged'}];response={answers:[{type:'choice',name:'tier',choice:'forged'}]};return originalFetch(...args)}
  assert.equal(await transport.invokeDecision('question-mutation','x',questions),null)
  assert.deepEqual((requests[0].questions as typeof questions)[0].choices,[{value:'result'}])
 }finally{globalThis.fetch=originalFetch}
})
test('a missing LiteLLM credential leaves Decisions unavailable without a provider call', async () => {
 delete process.env.MIKKA_LITELLM_MASTER_KEY; requests.length = 0
 const logged: unknown[] = []; console.error = (...args: unknown[]) => { logged.push(args) }
 assert.equal(await transport.decide('test', 'x', [{ type: 'predicate', name: 'p', instructions: 'p' }]), null)
 assert.equal(requests.length, 0)
 assert.deepEqual(logged.at(-1), ['Decision unavailable', { purpose: 'litellm-not-configured' }])
})

test('a previously queued Coordinator deadline delivers its pending event through Eve then completes', async () => {
  starts = 0
  events = [{ id: 'old-deadline-outbox', kind: 'run_finished', payload: {}, tier: 'result' }]
  const ticket = { userId: 'synthetic', botId: 'fixture-bot', at: '2026-11-01T00:00:00Z',
    events: [{ id: 'old-deadline-outbox', attempt: 1, nextWakeAt: '2026-11-01T00:00:00Z', leaseUntil: null }] }
  assert.equal(await wake.recoverWakeDeadline(ticket), null)
  assert.equal(starts, 1)
  events = []
  assert.equal(await wake.recoverWakeDeadline(ticket), null)
  assert.equal(starts, 1, 'a retired deadline with no pending product event starts no Eve delivery')
})

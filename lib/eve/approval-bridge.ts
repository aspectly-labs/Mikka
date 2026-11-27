import { snapshotDigest as digest } from '../operations/write-target'
import type { NativeWriteDecision, NativeWriteReview } from '../operations/native-write-review'

export interface ApprovalCall {
  ownerId:string;botId:string;workspaceId:string;surface:'web'|'slack'|'factory'
  sessionId:string;turnId:string;callId:string;executionId?:string|null;sourceEventId?:string|null
  name:string;input:unknown
}
/** The replay record of one product write: the exact call and the plan it was
 * reviewed with. `decision` may read 'ask' on a record stored before ADR
 * 2026-11-27-1615; such a record is never run. */
export interface ApprovalRecord {
  callDigest:string;planDigest:string;decision:NativeWriteDecision
  status:'prepared'|'executing'|'done';output?:unknown
}
export interface ApprovalStore {
  read(key:string):Promise<ApprovalRecord|null>
  prepare(key:string,record:ApprovalRecord):Promise<ApprovalRecord>
  claim(key:string):Promise<boolean>
  finish(key:string,output:unknown):Promise<void>
}
const writes = new Set(['call_app_tool','send_email','create_calendar_event','update_calendar_event','append_notion_paragraph','send_slack_message','cancel_calendar_event'])
const keyOf=(call:ApprovalCall)=>digest([call.ownerId,call.sessionId,call.turnId,call.callId])

/** The gateway authenticates the service and session/source before entering this
 * boundary. Review never grants a permission and never asks a person (ADR
 * 2026-11-27-1615): it records the exact call and its prepared plan, and only
 * stops a call its business gates refuse. Execution replays that record: the
 * same call, the same plan, at most once; every business gate still reads
 * current authority. */
export function createEveApprovalBridge(deps:{store:ApprovalStore;run(call:ApprovalCall,review:NativeWriteReview,signal?:AbortSignal):Promise<unknown>;beforeExecute?(call:ApprovalCall):Promise<void>;afterExecute?(call:ApprovalCall,output:unknown,failed:boolean):Promise<void>}) {
  function sameCall(record:ApprovalRecord,call:ApprovalCall) {
    if(record.callDigest!==digest(call))throw new Error('operationBindingConflict')
  }
  const statusOf=(record:ApprovalRecord)=>({status:record.decision==='allow'?'not-applicable' as const:'denied' as const})
  return {
    async review(call:ApprovalCall,signal?:AbortSignal):Promise<{status:'not-applicable'|'denied'}|null> {
      if(!writes.has(call.name))return null
      const key=keyOf(call), prior=await deps.store.read(key)
      if(prior) {sameCall(prior,call);return statusOf(prior)}
      let decision:NativeWriteDecision='deny', planDigest=digest(['unavailable'])
      let reviewed=false
      signal?.throwIfAborted()
      const output=await deps.run(call,async(value,binding)=>{
        signal?.throwIfAborted()
        if(binding.ownerId!==call.ownerId||binding.botId!==call.botId)throw new Error('operationBindingConflict')
        reviewed=true
        decision=value;planDigest=digest([value,binding])
        return 'deny' // Stop before any receipt INSERT or provider dispatch.
      },signal)
      if(!reviewed) {
        // Account selection, disconnected apps and policy refusals stop before
        // the dispatch gate. Keep their useful business output for execution.
        if(!output||typeof output!=='object'||!('error'in output)||typeof output.error!=='string')throw new Error('operationBindingConflict')
        decision='allow';planDigest=digest(['preflight-result',output])
      }
      const record=await deps.store.prepare(key,{callDigest:digest(call),planDigest,decision,status:reviewed?'prepared':'done',...reviewed?{}:{output}})
      sameCall(record,call)
      if(record.planDigest!==planDigest)throw new Error('writePolicyChanged')
      return statusOf(record)
    },
    async execute(call:ApprovalCall,signal?:AbortSignal):Promise<unknown> {
      if(!writes.has(call.name))throw new Error('integrationActionNotAllowed')
      const key=keyOf(call),record=await deps.store.read(key)
      if(!record)throw new Error('writeApprovalRequired')
      sameCall(record,call)
      // A legacy 'ask' record waited for a person; nothing approves it now.
      if(record.decision!=='allow')throw new Error('integrationActionDenied')
      if(record.status==='done')return record.output
      signal?.throwIfAborted()
      if(record.status==='executing'||!await deps.store.claim(key))return {error:'operationUncertain'}
      await deps.beforeExecute?.(call)
      let output:unknown
      try {
        signal?.throwIfAborted()
        output=await deps.run(call,async(decision,binding)=>{
          signal?.throwIfAborted()
          if(digest([decision,binding])!==record.planDigest)throw new Error('writePolicyChanged')
          return decision
        },signal)
      } catch(error) {await deps.afterExecute?.(call,undefined,true);throw error}
      await deps.store.finish(key,output)
      await deps.afterExecute?.(call,output,false)
      return output
    },
  }
}

export const requiresEveProductApproval=(name:string)=>writes.has(name)

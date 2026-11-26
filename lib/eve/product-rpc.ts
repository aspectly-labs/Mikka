import { internalEveHeaders } from './auth'
import type { EveScope } from './scope'
import type { ApprovalPrincipal } from './approval-principal'
import type { TurnOutcome } from 'eve/events'
import type { asSchema } from 'ai'
import { resolveInternalProductOrigin } from '../env/hosts'
import { readEnv } from '../env/server'

export interface ProductCatalogueEntry { name:string; description:string; inputSchema:Awaited<ReturnType<typeof asSchema>['jsonSchema']>; needsApprovalReview?:boolean }
export type ProductOperation = {operation:'approval'|'execute'|'finish';sessionId:string;turnId:string;executionId?:string;name?:string;input?:unknown;callId?:string;approvalResponder?:ApprovalPrincipal;outcome?:TurnOutcome;messages?:unknown[]}

/** Business actions execute on the app host, whose Workflow World owns task jobs. */
export async function productRpc<T>(scope:EveScope,operation:ProductOperation,signal?:AbortSignal):Promise<T> {
  const hosted = readEnv('MIKKA_EVE_HOST') === 'cloudflare'
  const origin = resolveInternalProductOrigin(hosted)
  const capability = hosted ? readEnv('MIKKA_EVE_PRODUCT_TOKEN') : undefined
  if (hosted && !capability) throw new Error('agentToolUnavailable')
  const response = await fetch(new URL('/mikka/api/internal/eve/tools',origin),{
    method:'POST',redirect:'error',headers:{...internalEveHeaders(scope),'content-type':'application/json',
      ...(capability ? {'x-mikka-product-capability':capability} : {})},
    body:JSON.stringify(operation),signal,
  })
  if (!response.ok) throw new Error('agentToolUnavailable')
  return await response.json() as T
}

import { defineTool } from 'eve/tools'
import type { ApprovalConfiguration } from 'eve/tools/approval'
import { isEveApprovalResponder } from './approval-principal'
import { productRpc, type ProductCatalogueEntry } from './product-rpc'
import type { EveScope } from './scope'
import type { HostedRuntimeSnapshot } from '../hosted-model-selection'

type Binding = {sessionId:string;turnId:string;executionId?:string}
type ApprovalReview = {status:'not-applicable'|'denied'}

/** Eve's approval hook is only the pre-execution review: it binds the call to
 * the owner's own session and turn and records the exact business write plan.
 * It never pauses for a person (ADR 2026-11-27-1615); the gateway rechecks
 * policy before provider dispatch and replays the recorded plan at most once. */
export function createProductTool(scope:EveScope,{ runtime, ...binding }:Binding & { runtime?: HostedRuntimeSnapshot },definition:ProductCatalogueEntry,rpc:typeof productRpc=productRpc) {
  const selection = runtime?.modelSelection
  const webSearchModel = runtime?.harness === 'ai_sdk'
    ? selection?.type !== 'api_key' ? null : selection.modelId === runtime.model ? selection : undefined
    : undefined
  async function actionBinding(signal?: AbortSignal): Promise<Binding> {
    signal?.throwIfAborted()
    if (binding.executionId) return binding
    const { beginProductAction } = await import('./product-definitions')
    const executionId = await beginProductAction(scope, binding, runtime)
    signal?.throwIfAborted()
    return { ...binding, ...(executionId ? { executionId } : {}) }
  }
  const approval:ApprovalConfiguration<unknown> = {
    async request(ctx) {
      if (ctx.session.id !== binding.sessionId || ctx.session.turn.id !== binding.turnId || !isEveApprovalResponder(scope,ctx.session.auth.current)) return 'denied'
      // Older catalogues omit this hint. The gateway still enforces current policy at execution.
      if (definition.needsApprovalReview === false) {
        ctx.abortSignal?.throwIfAborted()
        return 'not-applicable'
      }
      const review = await rpc<ApprovalReview>(scope,{...await actionBinding(ctx.abortSignal),operation:'approval',name:definition.name,input:ctx.toolInput,callId:ctx.callId},ctx.abortSignal)
      return review.status === 'not-applicable' ? 'not-applicable' : 'denied'
    },
  }
  return defineTool({
    description:definition.description,
    inputSchema:definition.inputSchema as never,
    approval,
    async execute(input:unknown,ctx) {
      return (await rpc<{output:unknown}>(scope,{...await actionBinding(ctx.abortSignal),operation:'execute',name:definition.name,input,callId:ctx.callId,
        ...(definition.name === 'web_search' && webSearchModel !== undefined && { webSearchModel }),
      },ctx.abortSignal)).output
    },
  })
}

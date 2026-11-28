import {evaluationBindingId} from '../../../../lib/eve/evaluation-context'
import { defineHook } from 'eve/hooks'
import { sessions } from 'eve/server'
import { scopeFromAuth, registerSession } from '../../../../lib/eve/scope'
import { turnModel, turnPolicy, turnRequest, eveFactoryTurnStarted } from '../../../../lib/eve/runtime'
import { eveFactorySessionAuth, eveFactoryProjectTurn } from '../../../../lib/eve/factory/session'

export default defineHook({events:{
  async 'session.started'(_event,ctx) {
    if(evaluationBindingId(ctx.session.auth.current))return
    await registerSession(scopeFromAuth(ctx.session.auth.current),ctx.session.id)
  },
  async 'turn.started'(event,ctx) {
    if(evaluationBindingId(ctx.session.auth.current))return
    const scope = scopeFromAuth(ctx.session.auth.current)
    // #3082: a Factory role session has no chat source event, no Bot runtime
    // subscription and no product catalogue — its model and boundaries come
    // from the frozen Factory role plan carried on its session auth.
    const factory = eveFactorySessionAuth(ctx.session.auth.current)
    if (factory) { eveFactoryTurnStarted(factory, ctx.position?.line); return }
    const {pool} = await import('../../../../lib/db')
    const source = ctx.session.auth.current?.attributes.sourceEventId
    const originalSource = typeof source === 'string' ? source : ctx.session.parent
      ? (await pool.query<{source_event_id:string}>('SELECT source_event_id FROM eve_turn_sources WHERE session_id=$1 AND turn_id=$2',[ctx.session.parent.sessionId,ctx.session.parent.turn.id])).rows[0]?.source_event_id : undefined
    if (originalSource) await pool.query(`INSERT INTO eve_turn_sources(session_id,turn_id,source_event_id) SELECT $1,$2,e.id FROM coordinator_events e WHERE e.id=$3 AND e."userId"=$4 AND e."botId"=$5 ON CONFLICT DO NOTHING`,[ctx.session.id,event.data.turnId,originalSource,scope.ownerId,scope.botId])
    const scheduled = originalSource ? await (await import('../../../../lib/eve/scheduled-read')).loadScheduledRead(scope,originalSource) : null
    turnRequest.update(() => ({ sourceEventId: originalSource, scheduledRead: scheduled, startIndex: ctx.position?.line }))
    const { asProductPrincipal } = await import('../../../../lib/eve/product-definitions')
    await asProductPrincipal(scope, async () => {
      const [{ botRuntime }, { agentKitEnabled, agentKitStore, agentKitDefaults }] = await Promise.all([
        import('../../../../workflows/coordinator/agent-kit-steps'), import('../../../../lib/agent-kit/service'),
      ])
      const [runtime, policy] = await Promise.all([
        botRuntime(scope.ownerId, scope.botId),
        agentKitEnabled() ? (async () => {
          const { personalPlugins } = await import('../../../../lib/plugins/runtime')
          const [current, plugins] = await Promise.all([
            agentKitStore.active(scope, agentKitDefaults()), personalPlugins.snapshotForBot(scope.ownerId, scope.botId, scope.workspaceId),
          ])
          const effectiveTools = new Set<string>(current.effectiveTools)
          if (plugins.servers.length) { effectiveTools.add('list_personal_mcp_tools'); effectiveTools.add('call_personal_mcp_tool') }
          if (plugins.toolkits?.includes('googledrive')) effectiveTools.add('list_drive_files')
          return { definition: current.definition, effectiveTools: [...effectiveTools], personalPlugins: plugins }
        })() : null,
      ])
      const selected = runtime.modelSelection
      const canSearch = !scheduled && !ctx.session.parent && policy?.effectiveTools.includes('web_search') !== false
      let nativeSearch: typeof runtime.nativeWebSearchBackend
      if (canSearch && selected?.type === 'api_key') {
        nativeSearch = await (await import('../../../../lib/model-api-key-chat')).apiKeyNativeSearchBackend(selected)
      } else if (canSearch && selected?.type === 'subscription' && selected.runOwnerId === undefined) {
        const { subscriptionRuntime } = await import('../../../../lib/subscription-runtime')
        nativeSearch = await subscriptionRuntime().modelSearchBackend({ ...selected, execution: 'model' }, true)
      } else if (canSearch && !selected && runtime.model) {
        const { managedSearchRoute } = await import('../../../../lib/model-gateway/provider-config')
        const route = managedSearchRoute(runtime.model)
        if (route) {
          const { modelCatalog } = await import('../../../../lib/model-catalog-server')
          const advertised = (await modelCatalog()).find(model => model.id === runtime.model && model.vendor === route.backend)
          if (advertised?.tags.includes('web-search')) nativeSearch = route.backend
        }
      }
      turnModel.update(() => nativeSearch ? { ...runtime, nativeWebSearchBackend: nativeSearch } : runtime)
      turnPolicy.update(() => policy)
    })
    if (!scheduled && !ctx.session.parent) {
      const { projectTurnState } = await import('../../../../lib/eve/projection')
      await projectTurnState(scope,ctx.session.id,event.data.turnId,true)
    }
  },
  async 'turn.settled'(event,ctx) {
    if(evaluationBindingId(ctx.session.auth.current))return
    const scope = scopeFromAuth(ctx.session.auth.current)
    const [{ projectEveTurn, stoppedTurnDisplay }, { productRpc }] = await Promise.all([
      import('../../../../lib/eve/projection'), import('../../../../lib/eve/product-rpc'),
    ])
    const stoppedText = !ctx.session.parent && scope.surface === 'web' && event.data.outcome === 'cancelled'
      ? await stoppedTurnDisplay(sessions.attach(ctx.session.id),event.data.turnId,turnRequest.get().startIndex ?? 0)
      : undefined
    // Product retry timers and task workflows belong to the Mikka app host.
    // Children retain their read authority but never publish or settle the
    // root occurrence; only root requests carry compatibility messages.
    // Factory role turns keep their structured `result` parts: the host
    // settlement turns them into the bound run's report.
    const factory = eveFactorySessionAuth(ctx.session.auth.current)
    const messages = ctx.session.parent ? undefined
      : factory ? eveFactoryProjectTurn(ctx.view, ctx.session.id, event.data.turnId)
      : projectEveTurn(ctx.view,ctx.session.id,event.data.turnId,event.data.outcome,stoppedText)
    await productRpc(scope,{
      operation:'finish',sessionId:ctx.session.id,turnId:event.data.turnId,outcome:event.data.outcome,
      ...(messages ? {messages} : {}),
    })
  },
}})

import { defineDynamic } from 'eve/tools'
import { webSearch } from 'eve/tools/web_search'
import { turnModel, turnPolicy, turnRequest } from '../../../../lib/eve/runtime'
import { scopeFromAuth } from '../../../../lib/eve/scope'
import { EVE_FACTORY_ROLE_TOOLS, eveFactorySessionAuth } from '../../../../lib/eve/factory/session'

/** Product actions keep their existing ownership, billing and audit boundaries. */
export default defineDynamic(async ctx => {
  const {evaluationForSession,evaluationNativeTools}=await import('../../../../lib/eve/evaluation-runtime')
  const evaluation=await evaluationForSession(ctx)
  if(evaluation)return evaluationNativeTools(evaluation)
  const [{ productCatalogue }, { createProductTool }] = await Promise.all([
    import('../../../../lib/eve/product-definitions'), import('../../../../lib/eve/product-tool'),
  ])
  const scope = scopeFromAuth(ctx.session.auth.current)
  // #3082: a Factory role session gets exactly its role's sandbox tools —
  // the reviewer/analyst are read-only by toolset and carry no git
  // credentials; no product catalogue actions reach role sessions.
  const factory = eveFactorySessionAuth(ctx.session.auth.current)
  if (factory) {
    const granted = new Set(EVE_FACTORY_ROLE_TOOLS[factory.role])
    const tools: Record<string, unknown> = {}
    if (granted.has('bash')) tools.bash = (await import('eve/tools/bash')).default
    if (granted.has('read_file')) tools.read_file = (await import('eve/tools/read_file')).default
    if (granted.has('write_file')) tools.write_file = (await import('eve/tools/write_file')).default
    if (granted.has('edit_file')) tools.edit_file = (await import('eve/tools/edit_file')).default
    if (granted.has('glob')) tools.glob = (await import('eve/tools/glob')).default
    if (granted.has('grep')) tools.grep = (await import('eve/tools/grep')).default
    return tools as never
  }
  const policy = turnPolicy.get()
  const runtime = turnModel.get()!
  const request = turnRequest.get()
  const binding = {sessionId:ctx.session.id,turnId:ctx.turn!.id}
  const catalogue = await productCatalogue(scope,binding,policy,runtime,request)
  return Object.fromEntries(catalogue.map(definition => [definition.name,
    definition.name === 'web_search' && runtime.nativeWebSearchBackend
      ? webSearch({ provider: 'native' })
      : createProductTool(scope, binding, definition),
  ]))
})

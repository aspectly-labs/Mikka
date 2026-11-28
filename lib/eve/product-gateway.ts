import 'server-only'
import { asSchema } from 'ai'
import { z } from 'zod'
import type { EveScope } from './scope'
import { asProductPrincipal, productContext, productTools } from './product-definitions'
import { hostedApiKeySnapshotSchema, selectionScope } from '../hosted-model-selection'

const id = z.string().min(1).max(256)
const common = { sessionId: id, turnId: id, executionId: z.uuid().nullable().optional() }
const toolCall = { ...common, name: z.string().min(1).max(128), input: z.unknown(), callId: id }
// Accepted and ignored for one release: an older Eve deployment may still send
// it. Nothing is approved by a person any more (ADR 2026-11-27-1615).
const approvalResponder = z.object({
  authenticator: z.literal('mikka'), principalType: z.literal('user'), principalId: id,
  attributes: z.object({ botId: z.uuid(), workspaceId: z.uuid(), surface: z.enum(['web', 'slack']) }).strict(),
}).strict()
const requestSchema = z.discriminatedUnion('operation', [
  z.object({ ...toolCall, operation: z.literal('approval') }).strict(),
  z.object({ ...toolCall, operation: z.literal('execute'), approvalResponder: approvalResponder.optional(), webSearchModel: hostedApiKeySnapshotSchema.nullable().optional() }).strict(),
  z.object({ ...common, operation: z.literal('finish'), outcome: z.enum(['completed', 'failed', 'cancelled']), messages: z.array(z.unknown()).optional() }).strict(),
])
type Input = z.infer<typeof requestSchema>
type Scope = EveScope

/** Test seam is the authenticated product boundary, independent of eve's model/tool loop. */
export interface EveProductGatewayServices {
  authorize(request: Request): Promise<Scope | null>
  assertSession(scope: Scope, sessionId: string): Promise<void>
  run(scope: Scope, input: Input, signal: AbortSignal, request: Request): Promise<unknown>
}

async function boundedBody(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > 512 * 1024) throw new Error('validationGeneric')
      chunks.push(chunk.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
    catch (error) { throw new Error('validationGeneric', { cause: error }) }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

/** Product tools must run in the Mikka host's Workflow world, not eve's independent world. */
export async function handleEveProductRequest(request: Request, services: EveProductGatewayServices = defaultServices) {
  try {
    const scope = await services.authorize(request)
    if (!scope) return Response.json({ error: 'authRequired' }, { status: 401 })
    const parsed = requestSchema.safeParse(await boundedBody(request))
    if (!parsed.success) return Response.json({ error: 'validationGeneric' }, { status: 400 })
    if (parsed.data.operation === 'execute' && parsed.data.webSearchModel !== undefined) {
      const frozen = parsed.data.webSearchModel && selectionScope(parsed.data.webSearchModel)
      // Eve passes its concrete Bot ID to freezeBotModel, including the Coordinator chat.
      if (parsed.data.name !== 'web_search' || scope.surface === 'factory'
          || (frozen && (frozen.ownerId !== scope.ownerId || frozen.botId !== scope.botId || frozen.workspaceId !== scope.workspaceId)))
        return Response.json({ error: 'notFound' }, { status: 404 })
    }
    await services.assertSession(scope, parsed.data.sessionId)
    const result = await services.run(scope, parsed.data, request.signal, request)
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    // Raw tool/provider/SQL errors can contain credentials or user content.
    const code = error instanceof Error ? error.message : ''
    const denied = ['authRequired', 'notFound', 'workspaceAccessDenied', 'botNotFound', 'agentExecutionClosed', 'scheduleReadAuthorityLost'].includes(code)
    return Response.json({ error: code === 'validationGeneric' ? code : denied ? 'notFound' : 'failed' }, { status: code === 'validationGeneric' ? 400 : denied ? 404 : 503 })
  }
}

const defaultServices: EveProductGatewayServices = {
  async authorize(request) {
    const { internalEveRequestScope } = await import('./auth')
    return internalEveRequestScope(request)
  },
  async assertSession(scope, sessionId) {
    const { assertSessionScope } = await import('./scope')
    await assertSessionScope(scope, sessionId)
  },
  async run(scope, input, signal, request) {
    return asProductPrincipal(scope, async () => {
      if (input.operation === 'finish') {
        const { finishEveTurn } = await import('./settlement')
        return finishEveTurn(scope, input)
      }
      const { execution, sourceEventId, scheduledRead, taskEventId, entryOrigin } = await productContext(scope, input)
      const tools = await productTools(scope, execution, sourceEventId, scheduledRead, taskEventId,entryOrigin,
        input.operation === 'execute' ? input.webSearchModel : undefined)
      const tool = Object.hasOwn(tools, input.name) ? tools[input.name] : undefined
      if (!tool?.execute) throw new Error('notFound')
      const validator = asSchema(tool.inputSchema).validate
      if (!validator) throw new Error('validationGeneric')
      const checked = await validator(input.input)
      if (!checked.success) throw new Error('validationGeneric')
      signal.throwIfAborted()
      const { withEveProductAuthority } = await import('../enterprise/execution-authority')
      const output = await withEveProductAuthority(request, { ...input, executionId: execution?.id }, async () => {
        const call = { ...scope, sessionId: input.sessionId, turnId: input.turnId, executionId: execution?.id, sourceEventId, name: input.name, input: checked.value, callId: input.callId }
        const { reviewEveProductApproval, executeEveApprovedWrite } = await import('./product-approval')
        if (input.operation === 'approval') return reviewEveProductApproval(call, signal)
        const approved = await executeEveApprovedWrite(call, signal)
        if (approved) return approved.output
        return tool.execute!(checked.value, { toolCallId: input.callId, messages: [], context: {}, abortSignal: signal })
      })
      if (input.operation === 'approval') return output
      const { maskDeep, credentialMasker } = await import('../secrets/mask')
      const safe = maskDeep(output, credentialMasker)
      await (await import('../credentials/chat-guard')).assertCredentialSafeChat(scope.ownerId, safe)
      return { output: safe }
    })
  },
}

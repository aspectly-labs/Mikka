import { defineSandbox } from 'eve/sandbox'
import { PortableScratchSandbox } from '../../../lib/eve/sandbox'

/** Per-session scratch/attachments; native execution remains on Mikka task machines. */
export const environment = PortableScratchSandbox.environment()

export default defineSandbox(() => {
  const scratch = environment.open()
  return {
    async prepare(ctx: never, options: never) {
      return scratch.prepare(ctx, options)
    },
    async start(ctx: never, options: never, artifact: never) {
      const { eveFactorySessionAuth } = await import('../../../lib/eve/factory/session')
      const session = ctx as { session?: { auth?: { current?: unknown; initiator?: unknown } } }
      const factory = eveFactorySessionAuth(
        (session.session?.auth?.current ?? session.session?.auth?.initiator) as never,
      )
      if (factory) {
        const { createEveFactorySandboxProvider } = await import('../../../lib/eve/factory/sandbox')
        return createEveFactorySandboxProvider().start(ctx, options, artifact)
      }
      return scratch.start(ctx, options, artifact)
    },
    async resume(ctx: never, artifact: never, state: never) {
      const { eveFactorySessionAuth } = await import('../../../lib/eve/factory/session')
      const session = ctx as { session?: { auth?: { current?: unknown; initiator?: unknown } } }
      const factory = eveFactorySessionAuth(
        (session.session?.auth?.current ?? session.session?.auth?.initiator) as never,
      )
      if (factory) {
        const { createEveFactorySandboxProvider } = await import('../../../lib/eve/factory/sandbox')
        return createEveFactorySandboxProvider().resume(ctx, artifact, state)
      }
      return scratch.resume(ctx, artifact, state)
    },
    async onSessionEnd(ctx: never, state: never, options: never) {
      const { eveFactorySessionAuth } = await import('../../../lib/eve/factory/session')
      const session = ctx as { session?: { auth?: { current?: unknown; initiator?: unknown } } }
      const factory = eveFactorySessionAuth(
        (session.session?.auth?.current ?? session.session?.auth?.initiator) as never,
      )
      if (factory) {
        const { createEveFactorySandboxProvider } = await import('../../../lib/eve/factory/sandbox')
        return createEveFactorySandboxProvider().onSessionEnd(ctx, state, options)
      }
      return scratch.onSessionEnd(ctx, state, options)
    },
  }
})

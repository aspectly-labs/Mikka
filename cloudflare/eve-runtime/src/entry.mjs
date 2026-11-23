import { WorkerEntrypoint } from 'cloudflare:workers'
import { liteLlmRequest } from '../../api/ingress/services.mjs'
import { productRequest } from '../runtime/product.mjs'
import { singletonContainerName } from '../runtime/config.mjs'
import { consumeEveWake, eveServiceDelivery, eveWorkflowDelivery } from '../runtime/delivery.mjs'
import { eveWorldRequest } from '../runtime/world.mjs'
export { EveRuntime } from './index.mjs'
export { ContainerProxy } from '@cloudflare/containers'

const missing = () => new Response(null, { status: 404 })

export class LiteLlmOutbound extends WorkerEntrypoint {
  fetch(request) { return liteLlmRequest(request, this.env.LITELLM) }
}

export class EveProductOutbound extends WorkerEntrypoint {
  fetch(request) {
    return productRequest(request, this.env.BUSINESS_API, this.env.EVE_PUBLIC_ORIGIN, this.ctx.props.capability, this.ctx)
  }
}

/** Private egress adapter: forwards the container's `world.internal` calls to
 * the pinned WorldService binding after capability verification. */
export class EveWorldOutbound extends WorkerEntrypoint {
  fetch(request) { return eveWorldRequest(request, this.env.EVE_WORLD, this.ctx.props.capability) }
}

function forward(request, env, headers) {
  const source = new URL(request.url)
  const target = new URL(env.EVE_PUBLIC_ORIGIN)
  target.pathname = source.pathname
  target.search = source.search
  headers.set('x-forwarded-host', target.host)
  headers.set('x-forwarded-proto', 'https')
  const forwarded = new Request(target, {
    method: request.method, headers, signal: request.signal, redirect: 'manual',
    ...(request.body ? { body: request.body, duplex: 'half' } : {}),
  })
  const { EVE_RELEASE_ID: name = singletonContainerName } = env
  return env.EVE_RUNTIME.getByName(name).fetch(forwarded)
}

export class EveService extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url)
    if (url.origin !== 'https://eve.internal' || !url.pathname.startsWith('/eve/v1/') || /%2e|%2f|%5c/i.test(url.pathname)) return missing()
    const headers = new Headers(request.headers)
    for (const name of ['forwarded', 'host', 'cf-container-target-port', 'proxy-authorization', 'x-real-ip', 'x-mikka-world-capability', 'x-mikka-product-capability']) headers.delete(name)
    for (const name of request.headers.keys()) {
      if (name.startsWith('x-forwarded-') || name.startsWith('x-vercel-') || name.startsWith('cf-')) headers.delete(name)
    }
    headers.delete('x-mikka-eve-binding-scope')
    const scope = headers.get('x-mikka-eve-scope')
    headers.delete('x-mikka-eve-scope')
    if (scope) headers.set('x-mikka-eve-binding-scope', scope)
    // A stopped or starting host must never drop a product event. The durable
    // EVE_WAKE copy replays the exact call; the caller still sees the real
    // outcome and the product outbox stays the claim authority.
    return eveServiceDelivery(request, this.env, headers, forwarded => forward(forwarded, this.env, headers))
  }
}

/** Release-pinned World queue deliveries. The private release maps bind this
 * entrypoint per retained deployment; the container it names starts on demand. */
export class EveWorkflowDelivery extends WorkerEntrypoint {
  fetch(request) { return eveWorkflowDelivery(request, this.env) }
}

export default {
  fetch: missing,
  /** Private EVE_WAKE consumer. Delivery is acked only after the container
   * accepted it; everything else retries with bounded backoff to the DLQ. */
  async queue(batch, env, ctx) { await consumeEveWake(batch, env, ctx) },
}

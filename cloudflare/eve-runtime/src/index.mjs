import { Container } from '@cloudflare/containers'
import { hostConfiguration, hostResidency, nativeRequest, onDemandHost, singletonContainerName } from '../runtime/config.mjs'

const stateKey = 'mikka:eve-host:lifecycle:v1'
const unavailable = () => Response.json({ ok: false, error: 'coordinatorUnavailable' }, {
  status: 503, headers: { 'cache-control': 'no-store' },
})

/** One shared Eve service, never a Task machine or a second Agent loop.
 * The Postgres World processes queued work inside the running Eve server. */
export class EveRuntime extends Container {
  defaultPort = 8080
  #onDemand = false

  constructor(ctx, env) {
    super(ctx, env)
    this.configuration = hostConfiguration(env)
    // On-demand residency is honored only when the configured World wakes the
    // host through the native queues. The Postgres World owns due-job delivery
    // inside its live Graphile worker, so it must stay resident.
    this.#onDemand = onDemandHost(env, this.configuration.runtimeEnv)
    if (hostResidency(env) === 'on-demand' && !this.#onDemand) console.error('CF_EVE_RESIDENCY_REQUIRES_QUEUE_WORLD')
    if (this.#onDemand) {
      this.sleepAfter = env.MIKKA_EVE_IDLE_TIMEOUT ?? '15m'
      this.renewActivityTimeout()
    }
    let productCapability = ctx.storage.kv.get('eve-product-capability')
    if (!productCapability) {
      productCapability = crypto.randomUUID() + crypto.randomUUID()
      ctx.storage.kv.put('eve-product-capability', productCapability)
    }
    this.envVars = { ...this.configuration.runtimeEnv, MIKKA_EVE_PRODUCT_TOKEN: productCapability,
      NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt' }
    if (env.LITELLM) this.envVars.MIKKA_LITELLM_URL = 'https://litellm.internal'
    if (env.EVE_WORLD) {
      let worldCapability = ctx.storage.kv.get('eve-world.capability')
      if (!worldCapability) {
        worldCapability = crypto.randomUUID() + crypto.randomUUID()
        ctx.storage.kv.put('eve-world.capability', worldCapability)
      }
      this.envVars.MIKKA_EVE_WORLD_TOKEN = worldCapability
    }
    this.labels = { component: 'eve-runtime', release: this.configuration.releaseId }
  }

  async bindOutboundServices() {
    if (this.env.LITELLM) await this.ctx.container.interceptOutboundHttps('litellm.internal', this.ctx.exports.LiteLlmOutbound)
    await this.ctx.container.interceptOutboundHttps('product.internal',
      this.ctx.exports.EveProductOutbound({ props: { capability: this.envVars.MIKKA_EVE_PRODUCT_TOKEN } }))
    if (this.env.EVE_WORLD) await this.ctx.container.interceptOutboundHttps('world.internal',
      this.ctx.exports.EveWorldOutbound({ props: { capability: this.envVars.MIKKA_EVE_WORLD_TOKEN } }))
  }

  async start(...args) {
    await this.bindOutboundServices()
    return super.start(...args)
  }

  async startAndWaitForPorts(...args) {
    await this.bindOutboundServices()
    return super.startAndWaitForPorts(...args)
  }

  async fetch(request) {
    const current = await this.ctx.storage.get(stateKey)
    if (current?.stopped || (current?.releaseId && current.releaseId !== this.configuration.releaseId)) return unavailable()
    try {
      const response = await super.fetch(request)
      if (response.status >= 500 && !response.headers.get('content-type')?.includes('application/json')) {
        if (response.body) this.ctx.waitUntil(response.body.cancel().catch(() => {}))
        return unavailable()
      }
      return response
    } catch {
      // SDK/network bodies can contain configuration; keep the product error closed.
      console.error('CF_EVE_TRANSPORT_UNAVAILABLE')
      return unavailable()
    }
  }

  async onStart() {
    const current = await this.ctx.storage.get(stateKey)
    if (current?.stopped) await this.stop('SIGTERM')
  }

  // A resident release keeps the shipped keepalive: the Postgres World's
  // Graphile worker polls and handles LISTEN/NOTIFY while no HTTP requests
  // arrive. An on-demand release lets the container sleep — the SDK already
  // calls this only when no request, stream or WebSocket is in flight, and
  // the next EVE_WAKE delivery or World queue message starts it again.
  async onActivityExpired() {
    if (!this.#onDemand || this.container?.running === false) return
    await this.stop()
  }

  async onStop() {
    // An on-demand host never restarts itself: sleep is the goal, and crash
    // recovery belongs to the durable queue plus the product outbox.
    if (this.#onDemand) return
    if (!(await this.ctx.storage.get(stateKey))?.stopped) await this.startAndWaitForPorts()
  }

  /** Account/operator RPC only; the public fetch handler never exposes it. */
  async stopForOwner(expectedReleaseId) {
    if (expectedReleaseId !== this.configuration.releaseId) throw new Error('CF_EVE_RELEASE_MISMATCH')
    await this.ctx.storage.put(stateKey, { releaseId: expectedReleaseId, stopped: true })
    await this.stop('SIGTERM')
    return this.getState()
  }
}

export default {
  async fetch(request, env) {
    const forwarded = nativeRequest(request)
    if (!forwarded) return Response.json({ ok: false, error: 'notFound' }, { status: 404 })
    try {
      const { EVE_RELEASE_ID: name = singletonContainerName } = env
      return await env.EVE_RUNTIME.getByName(name).fetch(forwarded)
    } catch {
      console.error('CF_EVE_INGRESS_UNAVAILABLE')
      return unavailable()
    }
  },
}

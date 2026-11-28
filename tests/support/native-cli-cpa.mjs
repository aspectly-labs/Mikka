// Local-only BYOS acceptance with the production gateway, CPA and PostgreSQL.
// The subscribed vendor HTTP endpoint is substituted.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function runNativeCliThroughGateway({ provider, directory, service, pool, runId, deviceId, workspaceId, model, metadata, bindingId, consumerId }) {
  const path = provider === 'claude' ? process.env.MIKKA_NATIVE_CLAUDE_BIN : process.env.MIKKA_NATIVE_CODEX_BIN
  assert.ok(path, 'supply the actual official CLI binary in the native proof')
  const { handleModelGateway, modelGatewayDependencies, forwardNativeSubscription } = await import('../../lib/model-gateway/handler.ts')
  const { mintGatewayToken, verifyGatewayToken } = await import('../../lib/model-gateway/token.ts')
  const { token } = await mintGatewayToken(pool, { runId, ownerId: 'alice', workspaceId, harness: provider === 'claude' ? 'claude_code' : 'codex',
    model, source: { kind: 'subscription', deviceId } })
  const deps = modelGatewayDependencies()
  deps.subscription = (...args) => forwardNativeSubscription(...args, service)
  const gateway = createServer(async (incoming, outgoing) => {
    try {
      const pathname = new URL(incoming.url, 'http://127.0.0.1').pathname
      const operation = pathname.endsWith('/count_tokens') ? 'count_tokens' : pathname.endsWith('/messages') ? 'messages' : pathname.endsWith('/responses') ? 'responses' : null
      if (incoming.method !== 'POST' || !operation || !pathname.startsWith('/api/model-gateway/')) {
        outgoing.writeHead(404).end()
        return
      }
      const request = new Request('http://127.0.0.1' + incoming.url, { method: 'POST', headers: incoming.headers, body: Readable.toWeb(incoming), duplex: 'half' })
      const response = await handleModelGateway(request, provider === 'claude' ? 'anthropic' : 'openai', operation, deps)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (!response.body) outgoing.end()
      else Readable.fromWeb(response.body).on('error', error => outgoing.destroy(error)).pipe(outgoing)
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500).end()
      else outgoing.destroy()
    }
  })
  gateway.listen(0, '127.0.0.1')
  await once(gateway, 'listening')
  try {
    const origin = 'http://127.0.0.1:' + gateway.address().port
    const cwd = join(directory, 'native-cli-' + provider)
    await mkdir(cwd)
    await exec('git', ['init', '-q', cwd])
    const [{ createLocalSubscriptionRunner }, { ToolApprovalGate }, { NoSandbox }, { createLogger }, { buildChildEnv }] = await Promise.all([
      import('../../packages/daemon/src/subscription-local-runner.ts'),
      import('../../packages/daemon/src/agents/tool-approval.ts'),
      import('../../packages/daemon/src/agents/sandbox.ts'),
      import('../../packages/daemon/src/log.ts'),
      import('../../packages/daemon/src/env.ts'),
    ])
    const stateDir = join(cwd, 'daemon')
    const runner = createLocalSubscriptionRunner({ stateDir,
      claude: { stateDir, sandbox: new NoSandbox(), ...(provider === 'claude' ? { binary: path } : {}) },
      codex: { stateDir, sandbox: new NoSandbox(), ...(provider === 'codex' ? { binary: path } : {}) },
    })
    const harness = provider === 'claude' ? 'claude_code' : 'codex'
    const protocol = provider === 'claude' ? 'anthropic' : 'openai'
    const assignment = {
      runId, deviceId, harness, model, subscriptionContext: metadata,
      subscriptionBinding: { bindingId, ownerId: 'alice', workspaceId, consumerId, route: metadata.route },
      modelCredential: { kind: 'provider', protocol, baseUrl: origin + '/api/model-gateway/' + (provider === 'claude' ? 'anthropic' : 'openai/v1'), key: token },
    }
    const session = await runner.start(assignment, {
      cwd, runId, model, prompt: 'Reply with a short marker.', log: createLogger({ level: 'silent' }),
      env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: cwd } }),
      toolApproval: new ToolApprovalGate(runId, { isLive: async () => (await verifyGatewayToken(pool, token))?.runId === runId }),
    })
    let text = '', outcome
    const deadline = setTimeout(() => { void session.cancel().catch(() => undefined) }, 30_000)
    try {
      for await (const event of session.events()) {
        if (event.type === 'chunk' && event.chunk.type === 'text-delta') text += event.chunk.delta
        if (event.type === 'exit') outcome = event.outcome
      }
    } finally {
      clearTimeout(deadline)
      await session.cancel()
    }
    assert.equal(outcome, 'succeeded', 'the daemon finished the official CLI session')
    assert.match(text, /subscription fixture/, 'the actual CLI consumed the streamed vendor reply')
    const rows = await pool.query(`SELECT "billingSource","inputTokens","outputTokens","generationId" FROM hosted_usage WHERE "usageRunId"=$1`, [runId])
    assert.ok(rows.rows.some(row => row.billingSource === 'subscription' && Number(row.inputTokens) > 0 && Number(row.outputTokens) > 0 && row.generationId === null),
      'the actual gateway recorded subscription usage for this run')
    console.log('Official native subscription fixture passed', provider, 'daemon, gateway, CPA stream and usage receipt')
  } finally {
    gateway.closeAllConnections()
    await new Promise(resolve => gateway.close(resolve))
  }
}

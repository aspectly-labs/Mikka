// Local-only BYOS acceptance. The production gateway, PostgreSQL and LiteLLM
// are real. Only the subscribed vendor HTTP endpoint is substituted.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function startNativeLiteLlm(root, directory, vendor, certificate) {
  const binary = process.env.MIKKA_NATIVE_LITELLM_BIN
  if (!binary) return null
  const pin = await exec(binary, ['--version'])
  assert.match(pin.stdout, /(^|[^\d])1\.109\.1([^\d]|$)/, 'use the production LiteLLM version')
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  const configFile = join(directory, 'native-proxy.yaml')
  const config = await readFile(join(root, 'deploy/litellm/config.yaml'), 'utf8')
  const routes = config.split('    - path: ').slice(1).filter(part => /^(\/v1\/mikka\/subscription\/(claude|codex)\/)/.test(part))
    .map(part => '    - path: ' + part.split('litellm_settings:')[0]
      .replace(/target: https:\/\/api\.anthropic\.com\/v1\/messages\/count_tokens\?beta=true/, 'target: ' + vendor + '/provider/count')
      .replace(/target: https:\/\/api\.anthropic\.com\/v1\/messages\?beta=true/, 'target: ' + vendor + '/provider/claude')
      .replace(/target: https:\/\/chatgpt\.com\/backend-api\/codex\/responses/, 'target: ' + vendor + '/provider/codex'))
    .join('')
  await writeFile(configFile, 'general_settings:\n  master_key: os.environ/LITELLM_MASTER_KEY\n  pass_through_endpoints:\n' + routes
    + 'litellm_settings:\n  turn_off_message_logging: true\n')
  const key = 'sk-' + randomBytes(32).toString('hex')
  const { DATABASE_URL: _database, ...launchEnv } = process.env
  const child = spawn(binary, ['--config', configFile, '--host', '127.0.0.1', '--port', String(port)], {
    env: { ...launchEnv, LITELLM_MASTER_KEY: key, LITELLM_LOCAL_MODEL_COST_MAP: 'True', SSL_CERT_FILE: certificate, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = []
  child.stdout.on('data', chunk => output.push(chunk))
  child.stderr.on('data', chunk => output.push(chunk))
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exit = once(child, 'exit')
    child.kill()
    await exit
  }
  const url = 'http://127.0.0.1:' + port
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) break
    try {
      if ((await fetch(url + '/health/liveliness', { signal: AbortSignal.timeout(1_000) })).ok) return { url, key, close }
    } catch { /* Local process is still starting. */ }
    await delay(100)
  }
  await close()
  throw new Error('Local LiteLLM did not become ready: ' + Buffer.concat(output).toString().replaceAll(key, '<redacted>').slice(-2400))
}

export async function runNativeCliThroughGateway({ provider, directory, service, pool, runId, deviceId, workspaceId, model }) {
  const path = provider === 'claude' ? process.env.MIKKA_NATIVE_CLAUDE_BIN : process.env.MIKKA_NATIVE_CODEX_BIN
  assert.ok(path, 'supply the actual official CLI binary in the native proof')
  const { handleModelGateway, modelGatewayDependencies, forwardNativeSubscription } = await import('../../lib/model-gateway/handler.ts')
  const { mintGatewayToken } = await import('../../lib/model-gateway/token.ts')
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
    const root = 'http://127.0.0.1:' + gateway.address().port + '/api/model-gateway/'
    const env = { PATH: process.env.PATH, HOME: join(directory, 'native-cli-' + provider), LANG: 'C.UTF-8' }
    await mkdir(env.HOME)
    const command = provider === 'claude' ?
      ['--print', '--output-format', 'stream-json', '--verbose', '--model', model, 'Reply with a short marker.'] :
      ['exec', '--skip-git-repo-check', '--json',
        '-c', 'model_provider="mikka"', '-c', 'model_providers.mikka.name="Mikka"',
        '-c', 'model_providers.mikka.base_url=' + JSON.stringify(root + 'openai/v1'),
        '-c', 'model_providers.mikka.env_key="MIKKA_MODEL_API_KEY"', '-c', 'model_providers.mikka.wire_api="responses"',
        '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false', '-m', model, 'Reply with a short marker.']
    if (provider === 'claude') Object.assign(env, { ANTHROPIC_BASE_URL: root + 'anthropic', ANTHROPIC_API_KEY: token, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
    else Object.assign(env, { CODEX_HOME: env.HOME, MIKKA_MODEL_API_KEY: token })
    let stdout
    try {
      const pending = exec(path, command, { cwd: env.HOME, env, timeout: 30_000 })
      pending.child.stdin.end()
      ;({ stdout } = await pending)
    } catch (error) {
      throw new Error('Official CLI invocation failed: ' + String(error.stderr || error.stdout || error.message).replaceAll(token, '<redacted>').slice(-2200))
    }
    assert.match(stdout, /subscription fixture/, 'the actual CLI consumed the streamed vendor reply')
    const rows = await pool.query(`SELECT "billingSource","inputTokens","outputTokens","generationId" FROM hosted_usage WHERE "usageRunId"=$1`, [runId])
    assert.ok(rows.rows.some(row => row.billingSource === 'subscription' && Number(row.inputTokens) > 0 && Number(row.outputTokens) > 0 && /^[a-f0-9-]{36}$/.test(row.generationId)),
      'the actual gateway recorded subscription usage with a LiteLLM generation ID for this run')
    console.log('Official native subscription fixture passed', provider, 'gateway, LiteLLM stream and usage receipt')
  } finally {
    gateway.closeAllConnections()
    await new Promise(resolve => gateway.close(resolve))
  }
}

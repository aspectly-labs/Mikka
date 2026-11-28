// Run the daemon in its own Node environment so Next's ProcessEnv augmentation
// does not change the daemon package's types. Provider I/O stays in the offline CLI fixture.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalSubscriptionRunner } from '../../packages/daemon/src/subscription-local-runner.ts'
import { ToolApprovalGate } from '../../packages/daemon/src/agents/tool-approval.ts'
import { NoSandbox } from '../../packages/daemon/src/agents/sandbox.ts'
import { createLogger } from '../../packages/daemon/src/log.ts'
import { buildChildEnv } from '../../packages/daemon/src/env.ts'

const root = process.argv[2]
const input = JSON.parse(process.argv[3])
const record = join(root, 'launch.json'), binary = join(root, 'claude-fixture.mjs')
const fakeCli = fileURLToPath(new URL('../../packages/daemon/test/fakes/fake-claude-subscription.mjs', import.meta.url))
writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2) }))
const child = spawn(process.execPath, [${JSON.stringify(fakeCli)}, ...process.argv.slice(2)], { stdio: 'inherit' })
child.on('exit', code => process.exit(code ?? 1))
`)
chmodSync(binary, 0o700)
const token = 'mkg_' + 'a'.repeat(43)
const baseUrl = 'https://mikka.test/api/model-gateway/anthropic'
const stateDir = join(root, 'state')
const runner = createLocalSubscriptionRunner({ stateDir,
  claude: { stateDir, sandbox: new NoSandbox(), binary }, codex: { stateDir, sandbox: new NoSandbox() },
})
const session = await runner.start({
  runId: input.runId, deviceId: input.deviceId, harness: 'claude_code', model: input.model,
  subscriptionBinding: input.binding,
  subscriptionContext: { route: 'claude_code_cli', modelId: input.subscription.modelId, revision: 1, accountId: 'fixture-account', expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  modelCredential: { kind: 'provider', protocol: 'anthropic', baseUrl, key: token },
},
  { runId: input.runId, cwd: root, prompt: 'hello', model: input.model, env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: root } }), log: createLogger({ level: 'silent' }), toolApproval: new ToolApprovalGate(input.runId, { isLive: id => id === input.runId }) })
const events = []
for await (const event of session.events()) events.push(event)
const args = JSON.parse(readFileSync(record, 'utf8')).args
const inlineModel = args.find(arg => arg.startsWith('--model='))
const modelIndex = args.indexOf('--model')
const model = inlineModel ? inlineModel.slice('--model='.length) : modelIndex >= 0 ? args[modelIndex + 1] : undefined
assert.ok(model, `Missing CLI model: ${JSON.stringify(args)}`)
const observed = JSON.parse(readFileSync(join(stateDir, 'runs', input.runId, 'native-home', '.claude', 'fixture-auth.json'), 'utf8'))
assert.deepEqual(observed, { tokenSha: createHash('sha256').update(token).digest('hex'), baseUrl })
process.stdout.write(JSON.stringify({ model, baseUrl, outcome: events.at(-1)?.outcome }))

import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { freezeWorkerDefinition } from '../lib/agent-kit/worker'

// 「API 与订阅」 API keys against real Postgres: the migrations replay, keys are
// checked with the provider and stored sealed, a key is a person's or a
// workspace's and never shared (decision 2026-11-27-1740), and a run gets only
// its owner's own key or its workspace's key (orchestration.md § 2, § 6).
const databaseURL = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('API key database test URL required')

const env = { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }
// Fake keys made per run, so no key-shaped literal sits in the repository.
const fakeKey = (label: string) => `test-${label}-${randomBytes(12).toString('hex')}`
const [wrongKey, downKey, firstKey, newKey, customKey, gatewayKey, localKey] = ['wrong', 'down', 'first', 'new', 'custom', 'gateway', 'local'].map(fakeKey)
const models = (ids: string[]) => new Response(JSON.stringify({ data: ids.map(id => ({ id, object: 'model' })) }), { status: 200, headers: { 'content-type': 'application/json' } })

test('API keys: migration replay, sealed storage, workspace keys, picker order and run authorization', { skip: !databaseURL }, async () => {
  const url = new URL(databaseURL!)
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname))
  assert.ok(url.pathname.endsWith('_e2e'))
  const store = await import('../lib/model-api-keys')
  const admin = new Pool({ connectionString: databaseURL })
  const schema = `api_keys_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}`, max: 2 })
  const { workspacePool } = await import('../lib/workspace-db')
  const previousWorkspace = { connectionString: workspacePool.options.connectionString, options: workspacePool.options.options }
  Object.assign(workspacePool.options, { connectionString: databaseURL, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY);
      INSERT INTO "user" VALUES ('alice'),('bob'),('carol');
      CREATE TABLE byos_connections (id uuid PRIMARY KEY, "ownerId" text, "workspaceId" text, "removedAt" timestamptz, "modelCatalog" jsonb);
      CREATE TABLE byos_bindings ("connectionId" uuid, "modelId" text);
      CREATE TABLE bots (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, "ownerId" text);
      CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY,kind text NOT NULL CHECK (kind IN ('personal','team')));
      CREATE TABLE mikka_workspace_members ("workspaceId" uuid,"userId" text,status text);
      CREATE TABLE bot_model_choices ("ownerId" text NOT NULL, "workspaceId" uuid NOT NULL, "botKey" text NOT NULL, "bindingId" uuid, PRIMARY KEY ("ownerId","workspaceId","botKey"));
      CREATE TABLE agent_runs (id uuid PRIMARY KEY, "userId" text NOT NULL, "botId" uuid, "workspaceId" uuid, "deviceId" uuid, "agentDefinition" jsonb, status text NOT NULL, "stopRequestedAt" timestamptz, "leaseExpiresAt" timestamptz, "updatedAt" timestamptz)`)
    await pool.query(await readFile(new URL('../drizzle/20261101020201_workspace_personal_policies.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../drizzle/20261109035020_organization_governance.sql', import.meta.url), 'utf8'))
    const migration = await readFile(new URL('../drizzle/20261101021000_model_api_keys.sql', import.meta.url), 'utf8')
    await pool.query(migration)
    await pool.query(migration)
    const choiceMigration = await readFile(new URL('../drizzle/20261101021100_bot_api_key_choice.sql', import.meta.url), 'utf8')
    await pool.query(choiceMigration)
    await pool.query(choiceMigration)
    const errorMigration = await readFile(new URL('../drizzle/20261102120000_model_api_key_models_error.sql', import.meta.url), 'utf8')
    await pool.query(errorMigration)
    await pool.query(errorMigration)
    const responsesMigration = await readFile(new URL('../drizzle/20261102190000_model_api_key_responses_api.sql', import.meta.url), 'utf8')
    await pool.query(responsesMigration)
    await pool.query(responsesMigration)
    const enabledMigration = await readFile(new URL('../drizzle/20261108120101_enabled_models.sql', import.meta.url), 'utf8')
    await pool.query(enabledMigration)
    await pool.query(enabledMigration)
    // Decision 2026-11-15-1900: a chat's Mikka 额度 model.
    const creditsMigration = await readFile(new URL('../drizzle/20261115175552_bot_model_choices_credits_model.sql', import.meta.url), 'utf8')
    await pool.query(creditsMigration)
    await pool.query(creditsMigration)
    // Decision 2026-11-15-2000: a custom endpoint's turned-off request features; replays cleanly.
    const gatewayMigration = await readFile(new URL('../drizzle/20261115204738_model_gateway_tokens.sql', import.meta.url), 'utf8')
    await pool.query(gatewayMigration)
    await pool.query(gatewayMigration)
    // Decision 2026-11-23: multiple API keys per preset provider + persisted defaultEffort; replays cleanly.
    await pool.query('CREATE TABLE IF NOT EXISTS model_order_settings ("ownerId" text NOT NULL, "workspaceId" uuid NOT NULL, PRIMARY KEY ("ownerId","workspaceId"))')
    const multiKeyMigration = await readFile(new URL('../drizzle/20261124010135_multi_api_keys_and_default_effort.sql', import.meta.url), 'utf8')
    await pool.query(multiKeyMigration)
    await pool.query(multiKeyMigration)
    // Decision 2026-11-27-1740: the migration withdraws every share, and what relied on another person's key.
    await pool.query('CREATE TABLE IF NOT EXISTS model_order_entries (id uuid PRIMARY KEY, "ownerId" text NOT NULL, "workspaceId" uuid NOT NULL, position integer NOT NULL, harness text NOT NULL, model text NOT NULL, "sourceKind" text NOT NULL, "sourceId" uuid NOT NULL)')
    const legacyKey = randomUUID(), legacyWorkspace = randomUUID(), legacyRun = randomUUID(), ownRun = randomUUID()
    await pool.query(`INSERT INTO model_api_keys (id,"ownerId",provider,protocol,ciphertext,iv,"keyVersion",last4) VALUES ($1,'bob','deepseek','openai','x','x',1,'abcd')`, [legacyKey])
    await pool.query('INSERT INTO model_api_key_shares ("keyId","workspaceId") VALUES ($1,$2)', [legacyKey, legacyWorkspace])
    await pool.query(`INSERT INTO agent_runs (id,"userId",status,"agentDefinition") VALUES ($1,'carol','running',$3),($2,'bob','running',$3)`, [legacyRun, ownRun, JSON.stringify({ apiKey: { keyId: legacyKey, model: 'm' } })])
    await pool.query(`INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","apiKeyId","apiKeyModel") VALUES ('carol',$1,'coordinator',$2,'m'),('bob',$1,'coordinator',$2,'m')`, [legacyWorkspace, legacyKey])
    await pool.query(`INSERT INTO model_order_entries VALUES ($1,'carol',$3,0,'codex','m','api_key',$2),($4,'bob',$3,0,'codex','m','api_key',$2)`, [randomUUID(), legacyKey, legacyWorkspace, randomUUID()])
    const personalOrWorkspace = await readFile(new URL('../drizzle/20261127173719_model_api_keys_personal_or_workspace.sql', import.meta.url), 'utf8')
    await pool.query(personalOrWorkspace)
    await pool.query(personalOrWorkspace)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_api_key_shares')).rows[0].n, 0, 'every share row is withdrawn')
    await assert.rejects(pool.query('INSERT INTO model_api_key_shares ("keyId","workspaceId") VALUES ($1,$2)', [legacyKey, legacyWorkspace]), { code: '23514' }, 'and none can be added again')
    assert.deepEqual((await pool.query('SELECT "userId","stopRequestedAt" IS NOT NULL AS stopped FROM agent_runs WHERE id=ANY($1::uuid[]) ORDER BY "userId"', [[legacyRun, ownRun]])).rows,
      [{ userId: 'bob', stopped: false }, { userId: 'carol', stopped: true }], 'only the run on another person\'s key stops')
    assert.deepEqual((await pool.query('SELECT "ownerId","apiKeyId" FROM bot_model_choices WHERE "workspaceId"=$1 ORDER BY "ownerId"', [legacyWorkspace])).rows,
      [{ ownerId: 'bob', apiKeyId: legacyKey }, { ownerId: 'carol', apiKeyId: null }], 'only a choice naming another person\'s key is cleared')
    assert.deepEqual((await pool.query('SELECT "ownerId" FROM model_order_entries WHERE "sourceId"=$1', [legacyKey])).rows, [{ ownerId: 'bob' }])
    await pool.query('DELETE FROM agent_runs; DELETE FROM bot_model_choices; DELETE FROM model_order_entries; DELETE FROM model_api_keys')
    assert.equal(await store.apiKeyAfterQuota(pool, 'alice'), true, 'on by default')

    const personal = { id: randomUUID(), kind: 'personal' as const }
    const team = { id: randomUUID(), kind: 'team' as const }
    await pool.query('INSERT INTO mikka_workspaces(id,kind) VALUES ($1,$2),($3,$4)', [personal.id, personal.kind, team.id, team.kind])
    await pool.query('INSERT INTO mikka_workspace_members VALUES ($1,\'alice\',\'active\'),($1,\'bob\',\'active\'),($1,\'carol\',\'active\')', [team.id])
    // A personal workspace uses its owner's credentials; the team also has its own key, added by an admin.

    // A rejected key is never stored.
    const calls: { url: string; headers: Record<string, string> }[] = []
    const fetchWith = (response: () => Response) => (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: init?.headers as Record<string, string> })
      return response()
    }) as typeof fetch
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'deepseek', apiKey: wrongKey }, { env, fetch: fetchWith(() => new Response('{}', { status: 401 })) }), { code: 'apiKeyInvalid' })
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'deepseek', apiKey: downKey }, { env, fetch: fetchWith(() => new Response('', { status: 503 })) }), { code: 'apiKeyUnverifiable' })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_api_keys')).rows[0].n, 0)
    assert.equal(calls[0].url, 'https://api.deepseek.com/models')
    assert.equal(calls[0].headers.authorization, `Bearer ${wrongKey}`)

    // A preset key: checked, listed, sealed, last four only.
    const secret = firstKey
    const anthropic = await store.addApiKey(pool, 'alice', { provider: 'anthropic', apiKey: secret }, { env, fetch: fetchWith(() => models(['claude-opus-5-5', 'claude-sonnet-5-5'])) })
    assert.equal(calls.at(-1)!.headers['x-api-key'], secret)
    assert.deepEqual({ ...anthropic, id: undefined }, { id: undefined, provider: 'anthropic', name: null, baseUrl: null, protocol: 'anthropic', last4: firstKey.slice(-4), models: ['claude-opus-5-5', 'claude-sonnet-5-5'], modelsError: null, responsesApi: true })
    const raw = (await pool.query('SELECT * FROM model_api_keys WHERE id=$1', [anthropic.id])).rows[0]
    assert.ok(!JSON.stringify(raw).includes(secret), 'stored sealed')
    // Adding the same preset again creates a distinct key; replaceId updates an owned key in place.
    const secondAnthropic = await store.addApiKey(pool, 'alice', { provider: 'anthropic', name: 'Secondary', apiKey: newKey }, { env, fetch: fetchWith(() => models(['claude-opus-5-5'])) })
    assert.notEqual(secondAnthropic.id, anthropic.id)
    assert.equal(secondAnthropic.name, 'Secondary')
    await store.removeApiKey(pool, 'alice', secondAnthropic.id)
    const replaced = await store.addApiKey(pool, 'alice', { provider: 'anthropic', apiKey: newKey, replaceId: anthropic.id }, { env, fetch: fetchWith(() => models(['claude-opus-5-5'])) })
    assert.equal(replaced.id, anthropic.id)
    assert.equal(replaced.last4, newKey.slice(-4))
    const renamed = await store.updateApiKey(pool, 'alice', anthropic.id, { name: 'Primary Anthropic' }, { env })
    assert.equal(renamed.name, 'Primary Anthropic')
    assert.equal(renamed.last4, newKey.slice(-4))
    await store.updateApiKey(pool, 'alice', anthropic.id, { name: null }, { env })

    // Custom providers: https on a public address only; the person's own model list wins.
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'custom', name: 'Internal', baseUrl: 'http://example.com/v1', protocol: 'openai', apiKey: customKey }, { env, fetch: fetchWith(() => models([])) }), { code: 'apiKeyBaseUrlInvalid' })
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'custom', name: 'Internal', baseUrl: 'https://10.0.0.8/v1', protocol: 'openai', apiKey: customKey }, { env, fetch: fetchWith(() => models([])) }), { code: 'apiKeyBaseUrlInvalid' })
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'custom', name: 'Internal', baseUrl: 'https://llm.internal.example/v1', protocol: 'openai', apiKey: customKey }, { env, fetch: fetchWith(() => models([])), resolve: async () => ['192.168.1.4'] }), { code: 'apiKeyBaseUrlInvalid' })
    await assert.rejects(store.addApiKey(pool, 'alice', { provider: 'custom', name: 'Local', baseUrl: 'http://127.0.0.1:9/v1', protocol: 'openai', apiKey: customKey }, { env: { ...env, MIKKA_MODEL_KEY_LOOPBACK: '1', VERCEL: '1' }, fetch: fetchWith(() => models([])) }), { code: 'apiKeyBaseUrlInvalid' })
    const gateway = await store.addApiKey(pool, 'bob', { provider: 'custom', name: 'Gateway', baseUrl: 'https://gateway.example.com/v1/', protocol: 'openai', apiKey: gatewayKey, models: ['qwen-max', 'qwen-max'] }, { env, fetch: fetchWith(() => models(['a', 'b'])), resolve: async () => ['93.184.216.34'] })
    // LiteLLM converts the CLI protocol; adding a key only reads its model catalogue.
    assert.equal(calls.at(-1)!.url, 'https://gateway.example.com/v1/models')
    assert.equal(gateway.responsesApi, true)
    assert.deepEqual([gateway.baseUrl, gateway.protocol, gateway.models], ['https://gateway.example.com/v1', 'openai', ['qwen-max']])
    // Decision 2026-11-15-2000: the owner turns off request features the provider rejects; only the off ones are kept.
    assert.equal(gateway.features, undefined, 'every feature on by default')
    await store.setApiKeyFeatures(pool, 'bob', gateway.id, { thinking: false, strict: true })
    assert.deepEqual((await store.openGatewayApiKey(pool, gateway.id, env)).features, { thinking: false })
    await assert.rejects(store.setApiKeyFeatures(pool, 'alice', gateway.id, { thinking: false }), { code: 'apiKeyNotFound' }, 'only the owner')
    await store.setApiKeyFeatures(pool, 'bob', gateway.id, {})
    assert.deepEqual((await store.openGatewayApiKey(pool, gateway.id, env)).features, {})
    const local = await store.addApiKey(pool, 'bob', { provider: 'custom', name: 'Local', baseUrl: 'http://127.0.0.1:8787', protocol: 'anthropic', apiKey: localKey }, { env: { ...env, MIKKA_MODEL_KEY_LOOPBACK: '1' }, fetch: fetchWith(() => models(['glm-5'])) })
    assert.equal(calls.at(-1)!.url, 'http://127.0.0.1:8787/v1/models')

    // 重新获取模型 (decision 2026-11-02-1200): the stored key asks the provider again; its answer is the list.
    const refetched = await store.refreshApiKeyModels(pool, 'alice', anthropic.id, { env, fetch: fetchWith(() => models(['claude-opus-5-5', 'claude-haiku-5-5'])) })
    assert.deepEqual([calls.at(-1)!.url, calls.at(-1)!.headers['x-api-key']], ['https://api.anthropic.com/v1/models?limit=1000', newKey])
    assert.deepEqual([refetched.models, refetched.modelsError], [['claude-opus-5-5', 'claude-haiku-5-5'], null])
    // Detection (#2938) reads the provider's model list only: connecting, replacing and re-reading a key never sends a paid request.
    assert.ok(calls.every(call => new URL(call.url).pathname.endsWith('/models')), 'only the model list is read')
    // A failed answer keeps the last list and says why, for the key's row; a good one clears the reason.
    const refused = await store.refreshApiKeyModels(pool, 'alice', anthropic.id, { env, fetch: fetchWith(() => new Response('{}', { status: 401 })) })
    assert.deepEqual([refused.models, refused.modelsError], [['claude-opus-5-5', 'claude-haiku-5-5'], 'invalid'])
    assert.equal((await store.refreshApiKeyModels(pool, 'alice', anthropic.id, { env, fetch: fetchWith(() => new Response('', { status: 503 })) })).modelsError, 'unavailable')
    assert.equal((await store.listApiKeys(pool, 'alice', personal)).keys[0].modelsError, 'unavailable', 'the page reads the reason')
    assert.equal((await store.refreshApiKeyModels(pool, 'alice', anthropic.id, { env, fetch: fetchWith(() => models(['claude-opus-5-5'])) })).modelsError, null)
    // Only the owner asks; a custom provider that lists nothing keeps the models it was added with.
    await assert.rejects(store.refreshApiKeyModels(pool, 'bob', anthropic.id, { env, fetch: fetchWith(() => models(['x'])) }), { code: 'apiKeyNotFound' })
    assert.deepEqual((await store.refreshApiKeyModels(pool, 'bob', gateway.id, { env, fetch: fetchWith(() => models([])), resolve: async () => ['93.184.216.34'] })).models, ['qwen-max'])
    // DNS rebinding: the custom provider's name now points inside; the refetch asks nothing and keeps the list.
    let asked = false
    const rebound = await store.refreshApiKeyModels(pool, 'bob', gateway.id, { env, fetch: fetchWith(() => { asked = true; return models(['x']) }), resolve: async () => ['10.0.0.8'] })
    assert.equal(asked, false, 'a provider whose host resolves to a private address is not asked')
    assert.deepEqual([rebound.models, rebound.modelsError], [['qwen-max'], 'unavailable'])
    assert.deepEqual((await store.refreshApiKeyModels(pool, 'alice', anthropic.id, { env, fetch: fetchWith(() => models([])) })).models, [], 'a preset that lists nothing has nothing')
    await store.refreshApiKeyModels(pool, 'alice', anthropic.id, { env, fetch: fetchWith(() => models(['claude-opus-5-5'])) })

    // Decision 2026-11-27-1740: a person's key is never shared into a workspace; a team
    // workspace adds its own key, sealed to the workspace and recorded with who added it.
    const teamKey = fakeKey('team')
    const workspaceOwner = { workspaceId: team.id }
    const teamGateway = await store.addApiKey(pool, workspaceOwner, { provider: 'custom', name: 'Team gateway', baseUrl: 'https://team.example.com/v1', protocol: 'openai', apiKey: teamKey, models: ['team-model'] },
      { env, addedBy: 'bob', fetch: fetchWith(() => models(['team-model'])), resolve: async () => ['93.184.216.34'] })
    assert.deepEqual((await pool.query('SELECT "ownerId","workspaceId"::text AS "workspaceId","addedBy" FROM model_api_keys WHERE id=$1', [teamGateway.id])).rows[0],
      { ownerId: null, workspaceId: team.id, addedBy: 'bob' })
    assert.equal((await store.openGatewayApiKey(pool, teamGateway.id, env)).apiKey, teamKey)
    await assert.rejects(pool.query('UPDATE model_api_keys SET "ownerId"=\'bob\' WHERE id=$1', [teamGateway.id]), { code: '23514' }, 'a key is a person\'s or a workspace\'s, never both')
    // It is not its adder's: Bob cannot manage it as his own; the workspace (through its admin, checked by the action) can.
    await assert.rejects(store.updateApiKey(pool, 'bob', teamGateway.id, { name: 'Mine now' }, { env }), { code: 'apiKeyNotFound' })
    await assert.rejects(store.setApiKeyFeatures(pool, 'bob', teamGateway.id, { thinking: false }), { code: 'apiKeyNotFound' })
    assert.deepEqual(await store.removeApiKey(pool, 'bob', teamGateway.id), { removed: false })
    assert.equal((await store.updateApiKey(pool, workspaceOwner, teamGateway.id, { name: 'Team' }, { env })).name, 'Team')
    await assert.rejects(store.updateApiKey(pool, { workspaceId: personal.id }, teamGateway.id, { name: 'Elsewhere' }, { env }), { code: 'apiKeyNotFound' }, 'another workspace does not own it')
    // A person's key cannot be rotated into the workspace, nor the workspace's into a person.
    await assert.rejects(store.addApiKey(pool, workspaceOwner, { provider: 'custom', name: 'Taken', baseUrl: 'https://gateway.example.com/v1', protocol: 'openai', apiKey: gatewayKey, replaceId: gateway.id },
      { env, fetch: fetchWith(() => models(['qwen-max'])), resolve: async () => ['93.184.216.34'] }), { code: 'apiKeyNotFound' })
    await assert.rejects(store.addApiKey(pool, 'bob', { provider: 'custom', name: 'Taken', baseUrl: 'https://team.example.com/v1', protocol: 'openai', apiKey: teamKey, replaceId: teamGateway.id },
      { env, fetch: fetchWith(() => models(['team-model'])), resolve: async () => ['93.184.216.34'] }), { code: 'apiKeyNotFound' })

    // The page: an admin manages the workspace's keys under 工作区连接 (`shared: true`, one-release name); a member only their own.
    const bobPage = await store.listApiKeys(pool, 'bob', team, { admin: true })
    assert.deepEqual(bobPage.keys.map(key => [key.name, key.shared]), [['Gateway', false], ['Local', false], ['Team', true]])
    assert.equal(bobPage.canShare, true)
    assert.ok(!JSON.stringify(bobPage).includes('test-'), 'views never carry the key')
    const carolPage = await store.listApiKeys(pool, 'carol', team)
    assert.deepEqual([carolPage.keys, carolPage.canShare], [[], false], 'a member who is not an admin manages only their own keys')
    assert.equal((await store.listApiKeys(pool, 'bob', personal, { admin: true })).canShare, false, 'a personal workspace has no workspace connections')

    // The picker: the person's own keys first, then the workspace's own; never another member's personal key.
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', team.id)).map(key => [key.provider, key.mine, key.workspace]), [['anthropic', true, false], ['custom', false, true]])
    assert.deepEqual((await store.usableApiKeys(pool, 'carol', team.id)).map(key => [key.id, key.ownerId]), [[teamGateway.id, team.id]], 'Carol gets the workspace\'s key, never Alice\'s or Bob\'s')
    assert.deepEqual((await store.usableApiKeys(pool, 'bob', team.id)).map(key => [key.name, key.mine]), [['Gateway', true], ['Local', true], ['Team', false]])
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', personal.id)).map(key => key.provider), ['anthropic'], 'the workspace key stays in its workspace')
    assert.deepEqual(await store.usableApiKeys(pool, 'alice', team.id, gateway.id), [], 'Bob\'s personal key is never selectable by Alice')
    // The old admin switch grants and withdraws nothing now.
    await pool.query('INSERT INTO workspace_personal_policies ("workspaceId",subscriptions) VALUES ($1,false)', [team.id])
    assert.equal((await store.usableApiKeys(pool, 'alice', team.id)).length, 2)
    await pool.query('UPDATE workspace_personal_policies SET subscriptions=true WHERE "workspaceId"=$1', [team.id])
    const anotherWorkspace = { id: randomUUID(), kind: 'team' as const }
    await pool.query('INSERT INTO mikka_workspaces(id,kind) VALUES ($1,$2)', [anotherWorkspace.id, anotherWorkspace.kind])
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', anotherWorkspace.id)).map(key => [key.id, key.mine]), [[anthropic.id, true]], 'an own key works in another workspace')
    assert.equal((await store.listApiKeys(pool, 'alice', anotherWorkspace)).keys.some(key => key.id === anthropic.id), true, 'the account key is still manageable in the other workspace')

    // The real catalogue trigger marks a newly reported model disabled. Keep
    // it in both catalogues so dropping modelSettings cannot pass by omission.
    const disabledModel = 'fixture-disabled-api-key-model'
    await pool.query('UPDATE model_api_keys SET models=models || $2::jsonb WHERE id=ANY($1::uuid[])', [[anthropic.id, teamGateway.id], JSON.stringify([disabledModel])])
    const catalogues = (await pool.query('SELECT id,models,"modelSettings" FROM model_api_keys WHERE id=ANY($1::uuid[])', [[anthropic.id, teamGateway.id]])).rows
    assert.equal(catalogues.length, 2)
    for (const key of catalogues) {
      assert.ok(key.models.includes(disabledModel))
      assert.deepEqual(key.modelSettings.models[disabledModel], { enabled: false, fresh: true, manual: false })
    }
    const governedScope = { ownerId: 'alice', workspaceId: team.id }
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', team.id, anthropic.id)).map(key => [key.mine, key.models]), [[true, ['claude-opus-5-5']]], 'disabled models stay hidden')
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', team.id, teamGateway.id)).map(key => key.models), [['team-model']], 'the workspace key gets the same enabled-model filter')
    // An Organization that denies credential sharing has nothing left to deny: own and workspace keys are nobody's share.
    const organization = randomUUID()
    await pool.query('INSERT INTO mikka_organizations(id,name,"createdBy") VALUES ($1,\'Fixture organization\',\'bob\')', [organization])
    await pool.query('INSERT INTO mikka_organization_workspaces("workspaceId","organizationId") VALUES ($1,$2)', [team.id, organization])
    await pool.query('INSERT INTO mikka_organization_resource_policies("organizationId","modelCredentialSharing") VALUES ($1,\'deny\')', [organization])
    assert.deepEqual((await store.usableApiKeys(pool, 'alice', team.id)).map(key => key.id), [anthropic.id, teamGateway.id])
    await assert.rejects(store.setBotApiKeyChoice(pool, governedScope, null, teamGateway.id, disabledModel), { code: 'executionModelUnknown' })
    assert.deepEqual(await store.setBotApiKeyChoice(pool, governedScope, null, teamGateway.id, 'team-model'), { keyId: teamGateway.id, model: 'team-model', harnesses: ['claude_code', 'codex'] })
    assert.equal((await store.openApiKeyForChat(pool, 'alice', team.id, teamGateway.id, env)).keyOwnerId, team.id)
    await assert.rejects(store.openApiKeyForChat(pool, 'alice', team.id, gateway.id, env), { code: 'apiKeyNotFound' }, 'another member\'s personal key never opens for Alice')
    await assert.rejects(store.setBotApiKeyChoice(pool, governedScope, null, gateway.id, 'qwen-max'), { code: 'executionModelUnknown' })
    await pool.query('DELETE FROM mikka_organizations WHERE id=$1', [organization])

    // A bot's saved model can be an API key's: usable here, reaching bot chats, a model the key lists.
    const scope = { ownerId: 'alice', workspaceId: team.id }
    const aliceBot = randomUUID()
    await pool.query('INSERT INTO bots (id,"workspaceId","ownerId") VALUES ($1,$2,$3)', [aliceBot, team.id, 'alice'])
    await assert.rejects(store.setBotApiKeyChoice(pool, scope, aliceBot, anthropic.id, 'not-listed'), { code: 'executionModelUnknown' })
    await assert.rejects(store.setBotApiKeyChoice(pool, scope, randomUUID(), anthropic.id, 'claude-opus-5-5'), { code: 'botNotFound' })
    assert.deepEqual(await store.setBotApiKeyChoice(pool, scope, aliceBot, teamGateway.id, 'team-model'), { keyId: teamGateway.id, model: 'team-model', harnesses: ['claude_code', 'codex'] })
    assert.deepEqual(await store.setBotApiKeyChoice(pool, scope, null, anthropic.id, 'claude-opus-5-5'), { keyId: anthropic.id, model: 'claude-opus-5-5', harnesses: ['claude_code'] })
    assert.deepEqual(await store.botApiKeyChoice(pool, scope, aliceBot), { keyId: teamGateway.id, model: 'team-model', harnesses: ['claude_code', 'codex'] })
    await assert.rejects(pool.query(`INSERT INTO bot_model_choices VALUES ('alice',$1,'both',$2,$3,'m')`, [team.id, randomUUID(), anthropic.id]), { code: '23514' }, 'a choice is a binding or a key, not both')
    // An Anthropic-only custom provider serves threads, not bot chats.
    await assert.rejects(store.setBotApiKeyChoice(pool, { ownerId: 'bob', workspaceId: team.id }, null, local.id, 'glm-5'), { code: 'executionModelUnknown' })
    // Each bot-chat model call opens the key again through the same rule.
    assert.deepEqual(await store.openApiKeyForChat(pool, 'alice', team.id, teamGateway.id, env), { apiKey: teamKey, baseUrl: 'https://team.example.com/v1', keyOwnerId: team.id, provider: 'custom', protocol: 'openai' })
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=\'alice\'', [team.id])
    await assert.rejects(store.openApiKeyForChat(pool, 'alice', team.id, teamGateway.id, env), { code: 'apiKeyNotFound' }, 'a suspended member loses the workspace key')
    await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=\'alice\'', [team.id])
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=\'bob\'', [team.id])
    assert.equal((await store.openApiKeyForChat(pool, 'alice', team.id, teamGateway.id, env)).keyOwnerId, team.id, 'the adder leaving keeps the workspace key')
    await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=\'bob\'', [team.id])
    assert.equal((await store.openApiKeyForChat(pool, 'alice', team.id, anthropic.id, env)).baseUrl, 'https://api.anthropic.com/v1')
    assert.equal((await store.openApiKeyForChat(pool, 'alice', anotherWorkspace.id, anthropic.id, env)).keyOwnerId, 'alice', 'Bot chat uses its own key across workspaces')
    await assert.rejects(store.openApiKeyForChat(pool, 'carol', team.id, anthropic.id, env), { code: 'apiKeyNotFound' })

    // Run authorization: only an active run on its owner's own key, or on its workspace's key.
    const teamBot = randomUUID(), personalBot = randomUUID()
    await pool.query('INSERT INTO bots VALUES ($1,$2),($3,$4)', [teamBot, team.id, personalBot, personal.id])
    const run = randomUUID(), done = randomUUID(), carolRun = randomUUID(), loose = randomUUID(), workspaceRun = randomUUID(), borrowedRun = randomUUID()
    await pool.query(`INSERT INTO agent_runs (id,"userId","botId",status) VALUES ($1,'alice',$2,'running'),($3,'alice',$2,'succeeded'),($4,'carol',$2,'queued'),($5,'bob',NULL,'running'),($6,'alice',$2,'running'),($7,'carol',$2,'running')`,
      [run, teamBot, done, carolRun, loose, workspaceRun, borrowedRun])
    const workspaceDefinition = freezeWorkerDefinition({ harness: 'codex', instructions: '', prompt: 'Team task', parent: null, executionId: null, model: 'team-model', apiKey: { keyId: teamGateway.id, model: 'team-model' } })
    await pool.query('UPDATE agent_runs SET "agentDefinition"=$1 WHERE id=ANY($2::uuid[])', [JSON.stringify(workspaceDefinition), [workspaceRun, carolRun]])
    const borrowedDefinition = freezeWorkerDefinition({ harness: 'claude_code', instructions: '', prompt: 'Borrowed task', parent: null, executionId: null, model: 'claude-opus-5-5', apiKey: { keyId: anthropic.id, model: 'claude-opus-5-5' } })
    await pool.query('UPDATE agent_runs SET "agentDefinition"=$1 WHERE id=$2', [JSON.stringify(borrowedDefinition), borrowedRun])
    const stopped = async (id: string) => Boolean((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [id])).rows[0].stopRequestedAt)
    assert.deepEqual(await store.validateRunApiKey(pool, run, anthropic.id), { ownerId: 'alice', workspaceId: team.id })
    const otherBot = randomUUID(), otherRun = randomUUID()
    await pool.query('INSERT INTO bots (id,"workspaceId","ownerId") VALUES ($1,$2,$3)', [otherBot, anotherWorkspace.id, 'alice'])
    await pool.query('INSERT INTO agent_runs (id,"userId","botId",status) VALUES ($1,$2,$3,\'running\')', [otherRun, 'alice', otherBot])
    assert.equal((await store.validateRunApiKey(pool, otherRun, anthropic.id)).ownerId, 'alice', 'an Agent uses its own key across workspaces')
    await assert.rejects(store.validateRunApiKey(pool, otherRun, teamGateway.id), { code: 'apiKeyNotFound' }, 'a workspace key never serves a run in another workspace')
    await assert.rejects(store.validateRunApiKey(pool, run, teamGateway.id), { code: 'apiKeyNotFound' }, 'an unbound historical run cannot newly take a workspace key')
    assert.deepEqual(await store.validateRunApiKey(pool, workspaceRun, teamGateway.id), { ownerId: team.id, workspaceId: team.id })
    assert.deepEqual(await store.validateRunApiKey(pool, carolRun, teamGateway.id), { ownerId: team.id, workspaceId: team.id }, 'every member\'s run uses the workspace key')
    await assert.rejects(store.validateRunApiKey(pool, done, anthropic.id), { code: 'apiKeyNotFound' }, 'finished runs get nothing')
    await assert.rejects(store.validateRunApiKey(pool, borrowedRun, anthropic.id), { code: 'apiKeyNotFound' }, 'a run frozen on another member\'s personal key gets nothing')
    assert.deepEqual(await store.validateRunApiKey(pool, loose, local.id), { ownerId: 'bob', workspaceId: null }, 'a run without a bot may use its owner\'s own key')
    await assert.rejects(store.validateRunApiKey(pool, loose, anthropic.id), { code: 'apiKeyNotFound' })
    // Both CLI protocols are converted by LiteLLM; key authorization is independent of that protocol.
    const deepseekKey = `sk-${randomUUID()}`
    const deepseek = await store.addApiKey(pool, 'alice', { provider: 'deepseek', apiKey: deepseekKey }, { env, fetch: fetchWith(() => models(['deepseek-flash'])) })
    // Its own run, so the runs above keep the keys they were handed.
    const deepRun = randomUUID()
    await pool.query(`INSERT INTO agent_runs (id,"userId","botId",status) VALUES ($1,'alice',$2,'running')`, [deepRun, teamBot])
    assert.deepEqual(await store.validateRunApiKey(pool, deepRun, deepseek.id), { ownerId: 'alice', workspaceId: team.id })
    assert.deepEqual((await store.setBotApiKeyChoice(pool, scope, null, deepseek.id, 'deepseek-flash')).harnesses, ['claude_code', 'codex'])
    await store.setBotApiKeyChoice(pool, scope, null, anthropic.id, 'claude-opus-5-5')
    await store.removeApiKey(pool, 'alice', deepseek.id)
    assert.equal(await stopped(deepRun), true, 'removing the key stops the run that was handed it')
    // The adder leaving the workspace keeps the workspace key and its runs; their own keys' runs there stop.
    const { stopRunsUsingApiKeys } = await import('../lib/model-api-key-runs')
    await stopRunsUsingApiKeys(pool, { ownerId: 'bob', workspaceId: team.id })
    assert.equal(await stopped(carolRun), false, 'a workspace key run goes on when its adder leaves')
    assert.deepEqual(await store.validateRunApiKey(pool, carolRun, teamGateway.id), { ownerId: team.id, workspaceId: team.id })
    // A copied ciphertext does not open on another row, nor under another owner.
    await pool.query('UPDATE model_api_keys SET ciphertext=(SELECT ciphertext FROM model_api_keys WHERE id=$1), iv=(SELECT iv FROM model_api_keys WHERE id=$1) WHERE id=$2', [local.id, gateway.id])
    await assert.rejects(store.openGatewayApiKey(pool, gateway.id, env), { code: 'apiKeyNotFound' })
    await pool.query('UPDATE model_api_keys SET "workspaceId"=NULL,"ownerId"=\'bob\' WHERE id=$1', [teamGateway.id])
    await assert.rejects(store.openGatewayApiKey(pool, teamGateway.id, env), { code: 'apiKeyNotFound' }, 'a workspace key handed to a person does not open')
    await pool.query('UPDATE model_api_keys SET "ownerId"=NULL,"workspaceId"=$2 WHERE id=$1', [teamGateway.id, team.id])
    assert.equal((await store.openGatewayApiKey(pool, teamGateway.id, env)).apiKey, teamKey)

    // A Chat Completions provider is accepted without a model-generation probe.
    const chatKey = `sk-${randomUUID()}`
    const probes: string[] = []
    const chatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      probes.push(`${init?.method ?? 'GET'} ${String(input)}`)
      return models(['chat-1'])
    }) as typeof fetch
    const chatOnly = await store.addApiKey(pool, 'alice', { provider: 'custom', name: 'Chat only', baseUrl: 'https://chat.example.com/v1', protocol: 'openai', apiKey: chatKey }, { env, fetch: chatFetch, resolve: async () => ['93.184.216.34'] })
    assert.deepEqual(probes, ['GET https://chat.example.com/v1/models'])
    assert.deepEqual([chatOnly.responsesApi, chatOnly.models], [true, ['chat-1']])
    assert.deepEqual((await store.setBotApiKeyChoice(pool, scope, null, chatOnly.id, 'chat-1')).harnesses, ['claude_code', 'codex'])
    assert.equal((await store.openApiKeyForChat(pool, 'alice', team.id, chatOnly.id, env)).baseUrl, 'https://chat.example.com/v1')
    const chatRun = randomUUID()
    await pool.query(`INSERT INTO agent_runs (id,"userId","botId",status) VALUES ($1,'alice',$2,'running')`, [chatRun, teamBot])
    assert.deepEqual(await store.validateRunApiKey(pool, chatRun, chatOnly.id), { ownerId: 'alice', workspaceId: team.id })
    assert.equal((await store.refreshApiKeyModels(pool, 'alice', chatOnly.id, { env, fetch: chatFetch, resolve: async () => ['93.184.216.34'] })).responsesApi, true)
    assert.deepEqual(probes, ['GET https://chat.example.com/v1/models', 'GET https://chat.example.com/v1/models'])
    await store.setBotApiKeyChoice(pool, scope, null, anthropic.id, 'claude-opus-5-5')
    await store.removeApiKey(pool, 'alice', chatOnly.id)

    // Removing keys: only the owner (a person, or the workspace through its admin).
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL')
    assert.deepEqual(await store.removeApiKey(pool, 'alice', local.id), { removed: false }, 'only the owner removes a key')
    assert.deepEqual(await store.removeApiKey(pool, 'bob', local.id), { removed: true })
    assert.equal(await stopped(loose), true, 'deleting a key stops the run that has it')
    // Deleting a key deletes the bot choices on it; those bots fall back to the usual order.
    await store.removeApiKey(pool, 'alice', anthropic.id)
    assert.equal(await store.botApiKeyChoice(pool, scope, null), undefined)
    assert.ok(await store.botApiKeyChoice(pool, scope, aliceBot), 'the workspace key choice stays')
    assert.equal(await stopped(run), true, 'removing her own Anthropic key stops its own run')
    assert.equal(await stopped(carolRun), false, 'other keys\' runs go on')
    assert.deepEqual(await store.removeApiKey(pool, workspaceOwner, teamGateway.id), { removed: true })
    assert.equal(await stopped(carolRun), true, 'removing the workspace key stops every member\'s run on it')
    assert.equal(await store.botApiKeyChoice(pool, scope, aliceBot), undefined)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_api_key_shares')).rows[0].n, 0)

    await store.setApiKeyAfterQuota(pool, 'alice', false)
    assert.equal((await store.listApiKeys(pool, 'alice', personal)).apiKeyAfterQuota, false)
  } finally {
    Object.assign(workspacePool.options, previousWorkspace)
    await workspacePool.end()
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})

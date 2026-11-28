import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { ExecutionSettings } from "./execution-settings";
import { createRequestScope, runRequestScope } from "../apps/api/src/context";
import type { SubscriptionCatalogueModel } from "./subscription-service-tier";
import { context, propagation, SpanStatusCode, trace } from "@opentelemetry/api";
import { AlwaysOnSampler, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { sanitizeSpan } from "./tracing/sanitize";

/** A real, controllable free /models read. No provider identity or inference. */
async function catalogueProvider() {
  const closed = new AbortController();
  const responses: ServerResponse[] = [];
  const responsesClosed: Promise<void>[] = [];
  const received = Promise.withResolvers<void>();
  const calls: { owner: string; connection: string; signal?: AbortSignal; done: Promise<void> }[] = [];
  const server = createServer((_request, response) => {
    responses.push(response);
    const ended = Promise.withResolvers<void>();
    responsesClosed.push(ended.promise);
    response.once("close", ended.resolve);
    received.resolve();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const discover = async (owner: string, connection: string, signal?: AbortSignal): Promise<SubscriptionCatalogueModel[]> => {
    const done = Promise.withResolvers<void>();
    calls.push({ owner, connection, signal, done: done.promise });
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/models`, { signal: signal ? AbortSignal.any([signal, closed.signal]) : closed.signal });
      if (!response.ok) throw new Error(await response.text());
      return await response.json() as SubscriptionCatalogueModel[];
    } finally { done.resolve(); }
  };
  return {
    calls, received: received.promise, responsesClosed, discover,
    reply(models: SubscriptionCatalogueModel[]) {
      for (const response of responses) response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(models));
    },
    refuse(message: string) { for (const response of responses) response.writeHead(503).end(message); },
    async close() {
      closed.abort();
      server.closeAllConnections();
      await Promise.all(calls.map(call => call.done));
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function beforeDeadline<T>(pending: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 1500); })]);
  } finally { clearTimeout(timer); }
}
// Subscription chats answer only on validated routes (lib/subscription-routes.ts); these tests run with both on.
process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = 'claude_cpa,codex_cpa'
const databaseURL = process.env.E2E_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && !databaseURL)
  throw new Error("Execution settings database test URL required");
test(
  "execution settings: migration replay, CRUD, ordering, owner and workspace boundaries",
  { skip: !databaseURL },
  async t => {
    assert.ok(
      ["127.0.0.1", "localhost"].includes(new URL(databaseURL!).hostname),
    );
    assert.equal(new URL(databaseURL!).pathname, "/mikka_e2e");
    const admin = new Pool({ connectionString: databaseURL });
    const schema = `execution_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: databaseURL,
      options: `-c search_path=${schema}`,
    });
    const spans = new InMemorySpanExporter();
    const telemetry = new NodeTracerProvider({ sampler: new AlwaysOnSampler(), spanProcessors: [new SimpleSpanProcessor(spans)] });
    telemetry.register();
    try {
      // Install the real scoped PG handle before the first model/resource read.
      mock.module(new URL("./workspace-db.ts", import.meta.url).href, {
        namedExports: { workspaceDb: drizzle(pool), workspacePool: pool },
      });
      // Install the existing points fixture before the first model menu read.
      // Points admission has its own DB tests; resource authorization below remains real.
      mock.module(new URL("./points-fallback.ts", import.meta.url).href, {
        namedExports: { hostedPointsRefusal: async () => null, pointsFallback: async () => null, hostedPointsHere: async () => ({ points: 98 }) },
      });
      await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES ('alice'),('bob');
      CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text,kind text,"removedAt" timestamptz,"lastSeenAt" timestamptz,"sessionOpenedAt" timestamptz,"sessionClosedAt" timestamptz,enabled boolean,"autoSchedule" boolean,"deviceType" text,name text,harnesses jsonb,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE bots (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid,"archivedAt" timestamptz);
      CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY,kind text NOT NULL DEFAULT 'team' CHECK (kind IN ('personal','team')), "requireTwoFactor" boolean, "twoFactorRequiredAt" timestamptz);
      CREATE TABLE mikka_workspace_members ("workspaceId" uuid,"userId" text,name text,status text);
      CREATE TABLE byos_connections (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,epoch bigint,state text,provider text,"accountLabel" text,quota jsonb,"removedAt" timestamptz,paused boolean NOT NULL DEFAULT false,"modelSettings" jsonb);
      CREATE TABLE byos_bindings (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,"consumerId" text,"connectionId" uuid,"connectionRevision" bigint,"modelId" text,route text,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE workspace_e2b_keys ("workspaceId" uuid PRIMARY KEY,"createdBy" text);
      CREATE TABLE user_e2b_keys ("userId" text PRIMARY KEY);
      CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,status text,"stopRequestedAt" timestamptz,"leaseExpiresAt" timestamptz,"updatedAt" timestamptz);
      CREATE TABLE byos_native_runs ("runId" uuid PRIMARY KEY,"bindingId" uuid)`);
      await pool.query(
        await readFile(
          new URL(
            "../drizzle/20261030193000_device_enrollment_management.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const migration = await readFile(
        new URL(
          "../drizzle/20261030200610_execution_rules.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await pool.query(migration);
      await pool.query(migration);
      await pool.query(await readFile(new URL("../drizzle/20261101001200_bot_model_hosted_choice.sql", import.meta.url), "utf8"));
      // Un-sharing also stops runs on the owner's API keys (lib/model-api-key-runs.ts).
      await pool.query(
        await readFile(new URL("../drizzle/20261101021000_model_api_keys.sql", import.meta.url), "utf8"),
      );
      await pool.query(
        await readFile(new URL("../drizzle/20261101021100_bot_api_key_choice.sql", import.meta.url), "utf8"),
      );
      await pool.query(
        await readFile(new URL("../drizzle/20261102120000_model_api_key_models_error.sql", import.meta.url), "utf8"),
      );
      await pool.query(
        await readFile(new URL("../drizzle/20261102190000_model_api_key_responses_api.sql", import.meta.url), "utf8"),
      );
      await pool.query(
        await readFile(new URL("../drizzle/20261115175552_bot_model_choices_credits_model.sql", import.meta.url), "utf8"),
      );
      await pool.query(
        await readFile(new URL("../drizzle/20261115204738_model_gateway_tokens.sql", import.meta.url), "utf8"),
      );
      // The Bot's reasoning effort beside its model choice (freezeBotModel reads it).
      await pool.query(await readFile(new URL("../drizzle/20261120044916_bot_settings.sql", import.meta.url), "utf8"));
      // A key is a person's or a workspace's (the schema part of 20261127173719_model_api_keys_personal_or_workspace).
      await pool.query('ALTER TABLE model_api_keys ALTER COLUMN "ownerId" DROP NOT NULL, ADD COLUMN IF NOT EXISTS "workspaceId" uuid, ADD COLUMN IF NOT EXISTS "addedBy" text');
      const catalogueMigration = await readFile(new URL('../drizzle/20261030233002_byos_model_catalog.sql',import.meta.url),'utf8');
      await pool.query(catalogueMigration); await pool.query(catalogueMigration);
      const personalPolicyMigration = await readFile(new URL("../drizzle/20261101020201_workspace_personal_policies.sql",import.meta.url),"utf8");
      await pool.query(personalPolicyMigration); await pool.query(personalPolicyMigration);
      await pool.query(await readFile(new URL("../drizzle/20261109035020_organization_governance.sql", import.meta.url), "utf8"));
      const settings = new ExecutionSettings(pool),
        alice = { ownerId: "alice", workspaceId: randomUUID() },
        bob = { ...alice, ownerId: "bob" },
        other = { ...alice, workspaceId: randomUUID() };
      await pool.query('INSERT INTO mikka_workspaces(id) VALUES ($1),($2)', [alice.workspaceId, other.workspaceId]);
      await pool.query(`INSERT INTO mikka_workspace_members VALUES ($1,'alice','Alice','active'),($1,'bob','Bob','active'),($2,'alice','Alice','active')`, [alice.workspaceId, other.workspaceId]);
      const own = randomUUID(),
        foreign = randomUUID(),
        bot = randomUUID(),
        binding = randomUUID(),
        connection = randomUUID();
      await pool.query(
        `INSERT INTO devices (id,"ownerId",kind,enabled,"autoSchedule","lastSeenAt","sessionOpenedAt",harnesses) VALUES ($1,'alice','local',true,true,now(),now(),'[{"harness":"codex","installed":true,"models":["explicit-model"],"defaultModelSlot":"default","modelSlots":[{"slot":"default","model":"explicit-model","name":"Explicit model"}]}]'),($2,'bob','local',true,true,now(),now(),'[]')`,
        [own, foreign],
      );
      await pool.query("INSERT INTO bots VALUES ($1,$2,$3)", [
        bot,
        alice.ownerId,
        alice.workspaceId,
      ]);
      await pool.query(
        `INSERT INTO byos_connections VALUES ($1,'alice',$2,1,'connected','codex');`,
        [connection, alice.workspaceId],
      );
      await pool.query(
        `INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision","modelId",route) VALUES ($1,'alice',$2,$3,$4,1,'dynamic-model','codex_cpa')`,
        [binding, alice.workspaceId, bot, connection],
      );
      assert.equal(
        (await settings.botModels(alice))[0].modelId,
        "dynamic-model",
      );
      assert.equal((await settings.botModels(bob)).length, 0);

      // Temporary picks never overwrite a preference; the receipt names the stored clone.
      const temporaryBot = randomUUID();
      await pool.query("INSERT INTO bots VALUES ($1,$2,$3)", [temporaryBot, alice.ownerId, alice.workspaceId]);
      await assert.rejects(settings.setTemporaryBotModel(bob, temporaryBot, binding), { code: "botNotFound" });
      await assert.rejects(settings.setTemporaryBotModel(other, temporaryBot, binding), { code: "botNotFound" });
      const temporary = await settings.setTemporaryBotModel(alice, temporaryBot, binding);
      assert.ok(temporary);
      assert.notEqual(temporary.bindingId, binding);
      assert.match(temporary.revision, /^[0-9]+$/);
      const savedTemporary = (await pool.query('SELECT "bindingId",xmin::text AS revision FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3',
        [alice.ownerId, alice.workspaceId, temporaryBot])).rows[0];
      assert.deepEqual(savedTemporary, temporary);
      assert.equal(await settings.setTemporaryBotModel(alice, temporaryBot, binding), null);
      const conflictingBinding = randomUUID();
      await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision","modelId",route) VALUES ($1::uuid,'alice',$2,$1::text,$3,1,'conflict-model','codex_cpa')`,
        [conflictingBinding, alice.workspaceId, connection]);
      const countBeforeConflict = (await pool.query('SELECT count(*)::int AS count FROM byos_bindings')).rows[0].count;
      assert.equal(await settings.setTemporaryBotModel(alice, temporaryBot, conflictingBinding), null);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM byos_bindings')).rows[0].count, countBeforeConflict, 'a clone created before the conflict is rolled back');
      assert.deepEqual((await pool.query('SELECT "bindingId",xmin::text AS revision FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3',
        [alice.ownerId, alice.workspaceId, temporaryBot])).rows[0], temporary);
      await pool.query('DELETE FROM byos_bindings WHERE id=$1', [conflictingBinding]);
      assert.equal(await settings.restoreTemporaryBotModel(bob, temporaryBot, temporary), false);
      assert.equal(await settings.restoreTemporaryBotModel(other, temporaryBot, temporary), false);
      assert.equal(await settings.restoreTemporaryBotModel(alice, bot, temporary), false);
      assert.equal(await settings.restoreTemporaryBotModel(alice, temporaryBot, { ...temporary, bindingId: binding }), false);
      assert.equal(await settings.restoreTemporaryBotModel(alice, temporaryBot, { ...temporary, revision: String(Number(temporary.revision) + 1) }), false);
      assert.equal(await settings.restoreTemporaryBotModel(alice, temporaryBot, temporary), true);
      assert.equal(await settings.restoreTemporaryBotModel(alice, temporaryBot, temporary), false);

      const sameValue = await settings.setTemporaryBotModel(alice, temporaryBot, binding);
      assert.ok(sameValue);
      const rewritten = (await pool.query('UPDATE bot_model_choices SET "bindingId"="bindingId" WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3 RETURNING xmin::text AS revision',
        [alice.ownerId, alice.workspaceId, temporaryBot])).rows[0];
      assert.notEqual(rewritten.revision, sameValue.revision);
      assert.equal(await settings.restoreTemporaryBotModel(alice, temporaryBot, sameValue), false, 'same value is a different committed row version');
      const temporaryApiKey = randomUUID();
      await pool.query('INSERT INTO model_api_keys (id,"ownerId",provider,protocol,ciphertext,iv,"keyVersion",last4) VALUES ($1,$2,\'custom\',\'openai\',\'fixture_ciphertext\',\'fixture_iv\',1,\'0000\')',
        [temporaryApiKey, alice.ownerId]);
      const apiKeyRewrite = (await pool.query('UPDATE bot_model_choices SET "bindingId"=NULL,"apiKeyId"=$4,"apiKeyModel"=\'fixture-model\' WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3 RETURNING xmin::text AS revision',
        [alice.ownerId, alice.workspaceId, temporaryBot, temporaryApiKey])).rows[0];
      assert.equal(await settings.restoreTemporaryBotModel(alice, temporaryBot, { ...sameValue, revision: apiKeyRewrite.revision }), false, 'an API-key replacement is never cleared');
      await pool.query('DELETE FROM model_api_keys WHERE id=$1', [temporaryApiKey]);
      await pool.query('DELETE FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3', [alice.ownerId, alice.workspaceId, temporaryBot]);
      const racing = await Promise.all([
        settings.setTemporaryBotModel(alice, temporaryBot, binding),
        settings.setTemporaryBotModel(alice, temporaryBot, binding),
      ]);
      assert.equal(racing.filter(Boolean).length, 1);
      assert.equal(racing.filter(value => value === null).length, 1);
      const winner = racing.find(value => value !== null)!;
      assert.equal(await settings.restoreTemporaryBotModel(alice, temporaryBot, winner), true);
      assert.equal((await pool.query('SELECT 1 FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3', [alice.ownerId, alice.workspaceId, temporaryBot])).rowCount, 0);

      await assert.rejects(settings.setBotModel(bob, bot, binding));
      await assert.rejects(settings.setBotModel(other, bot, binding));
      await settings.setBotModel(alice, bot, binding);
      assert.equal(await settings.botModel(alice, bot), binding);
      await assert.rejects(settings.setBotModel(alice, bot, null),{code:"executionAutoNotAllowed"});
      await settings.setBotModel(alice, null, binding);
      assert.equal(await settings.botModel(alice, null), binding);
      const secondBot = randomUUID();
      await pool.query("INSERT INTO bots VALUES ($1,$2,$3)", [
        secondBot,
        alice.ownerId,
        alice.workspaceId,
      ]);
      await settings.setBotModel(alice, secondBot, binding);
      const copiedBinding = await settings.botModel(alice, secondBot);
      assert.notEqual(copiedBinding, binding);
      assert.equal(
        (
          await pool.query(
            'SELECT "consumerId" FROM byos_bindings WHERE id=$1',
            [copiedBinding],
          )
        ).rows[0].consumerId,
        secondBot,
      );
      assert.equal((await settings.botModels(alice)).length, 1, 'copied Bot bindings do not duplicate models');
      assert.equal((await settings.botBinding(alice,binding)).bindingId,binding,'runtime can resolve a hidden original binding');
      assert.equal(await settings.botBinding(bob,binding),undefined,'runtime binding lookups remain scoped');
      await settings.setBotModel(alice, secondBot, copiedBinding!);
      assert.equal(await settings.botModel(alice, secondBot), copiedBinding, 'a saved duplicate binding remains selectable');
      await pool.query(`UPDATE byos_connections SET "accountLabel"='Claude Max', quota='{"plan":"Max"}' WHERE id=$1`, [connection]);
      const option = (await settings.botModels(alice))[0];
      assert.equal(option.accountLabel, 'Claude Max'); assert.equal(option.plan, 'Max');
      const refreshed = await settings.refreshBotModels(alice, connection, async (owner, id) => {
        assert.equal(owner, 'alice'); assert.equal(id, connection);
        return [{id:'provider-model',prioritySupported:false}, {id:'provider-model',prioritySupported:false}, {id:'second-provider-model',prioritySupported:true}];
      });
      assert.deepEqual(refreshed.map(row=>row.modelId).sort(), ['provider-model','second-provider-model']);
      assert.deepEqual((await pool.query('SELECT "modelCatalog" FROM byos_connections WHERE id=$1',[connection])).rows[0].modelCatalog, {
        revision:'1',models:['provider-model','second-provider-model'],webSearchVersion:1,priorityVersion:1,
        prioritySupport:{'provider-model':false,'second-provider-model':true},
      });
      assert.equal((await settings.connectedSubscriptions('alice',true)).includes(connection),false);
      // A valid legacy catalogue remains sufficient for ordinary dispatch.
      // Only the chat menu explicitly requests the optional Fast capability.
      await pool.query(`UPDATE byos_connections SET "modelCatalog"="modelCatalog"-'priorityVersion'-'prioritySupport'-'webSearchVersion' WHERE id=$1`,[connection]);
      const legacyCatalogue = {revision:'1',models:['provider-model','second-provider-model']};
      await t.test("a valid catalogue is readable before optional metadata discovery completes", async () => {
        const provider = await catalogueProvider();
        const request = createRequestScope(new Request("http://127.0.0.1/mikka/api/rpc"));
        const pending = runRequestScope(request, () => trace.getTracer("fixture").startActiveSpan("catalogue.read", async span => {
          try { return await settings.ensureCatalogues(alice, 8000, provider.discover, { codexPriority: true, deferOptional: true }); }
          finally { span.end(); }
        }));
        try {
          await beforeDeadline(pending, "an optional provider refresh blocked the valid catalogue read");
          assert.equal(provider.calls.length, 0, "the owned after queue starts the refresh after response disposal");
          await telemetry.forceFlush();
          const read = spans.getFinishedSpans().find(span => span.name === "catalogue.read")!;
          assert.equal(read.attributes["mikka.catalogue.cache"], "optional_metadata");
          assert.equal(read.attributes["mikka.catalogue.deferred"], 1);
          assert.deepEqual((await pool.query('SELECT "modelCatalog" FROM byos_connections WHERE id=$1', [connection])).rows[0].modelCatalog, legacyCatalogue);
          const after = request.after.finish();
          await beforeDeadline(provider.received, "optional refresh never reached the provider");
          provider.reply([{ id: "provider-model" }, { id: "second-provider-model" }]);
          await beforeDeadline(after, "optional refresh did not settle its owned lifetime");
          const catalogue = (await pool.query('SELECT "modelCatalog" FROM byos_connections WHERE id=$1', [connection])).rows[0].modelCatalog;
          assert.equal(catalogue.priorityVersion, 1);
          assert.deepEqual(catalogue.prioritySupport, {}, "an unreported capability stays unknown");
        } finally {
          await provider.close();
          await pending;
          await request.after.finish();
          await pool.query('UPDATE byos_connections SET "modelCatalog"=$2::jsonb WHERE id=$1', [connection, JSON.stringify(legacyCatalogue)]);
        }
      });
      await t.test("a catalogue deadline aborts the actual discovery and prevents a late durable write", async () => {
        const provider = await catalogueProvider();
        const pending = settings.ensureCatalogues(alice, 100, provider.discover, { codexPriority: true });
        try {
          await beforeDeadline(provider.received, "the provider was never called");
          await pending;
          assert.equal(provider.calls.length, 1);
          assert.equal(provider.calls[0].signal?.aborted, true, "a Promise.race timeout must cancel the actual provider request");
          await beforeDeadline(provider.calls[0].done, "discovery remained alive after its deadline");
          await beforeDeadline(provider.responsesClosed[0], "the provider connection stayed open after cancellation");
          provider.reply([{ id: "late-provider-model", prioritySupported: true }]);
          assert.deepEqual((await pool.query('SELECT "modelCatalog" FROM byos_connections WHERE id=$1', [connection])).rows[0].modelCatalog, legacyCatalogue);
        } finally { await provider.close(); await pending; }
      });
      await t.test("direct manual refresh keeps the worker deadline instead of adding a menu deadline", async () => {
        const provider = await catalogueProvider();
        const pending = settings.refreshBotModels(alice, connection, provider.discover);
        try {
          await beforeDeadline(provider.received, "manual refresh never reached the provider");
          assert.equal(provider.calls[0].signal, undefined, "only an explicit caller budget may add the menu deadline");
          provider.reply([{ id: "provider-model" }, { id: "second-provider-model" }]);
          assert.deepEqual((await pending).map(row => row.modelId).sort(), legacyCatalogue.models);
          assert.equal((await pool.query('SELECT "modelCatalog" FROM byos_connections WHERE id=$1', [connection])).rows[0].modelCatalog.priorityVersion, 1);
        } finally {
          await provider.close(); await Promise.allSettled([pending]);
          await pool.query('UPDATE byos_connections SET "modelCatalog"=$2::jsonb WHERE id=$1', [connection, JSON.stringify(legacyCatalogue)]);
        }
      });
      await t.test("concurrent catalogue reads share one discovery and reread their authorized view", async () => {
        const provider = await catalogueProvider();
        const reads = Array.from({ length: 3 }, () => new ExecutionSettings(pool).ensureCatalogues(alice, 8000, provider.discover, { codexPriority: true }));
        try {
          await beforeDeadline(provider.received, "the provider was never called");
          // All three physical candidates reads must reach the database before the assertion.
          await pool.query('SELECT 1');
          await new Promise(resolve => setTimeout(resolve, 50));
          assert.equal(provider.calls.length, 1, "concurrent reads must not launch duplicate provider requests");
          provider.reply([{ id: "provider-model" }, { id: "second-provider-model" }]);
          await beforeDeadline(Promise.all(reads), "coalesced readers did not finish");
          assert.deepEqual((await settings.botModels(alice)).map(row => row.modelId).sort(), legacyCatalogue.models);
          assert.deepEqual(await settings.botModels(bob), [], "the shared refresh never makes Alice's models available to Bob");
        } finally {
          await provider.close();
          await Promise.all(reads);
          await pool.query('UPDATE byos_connections SET "modelCatalog"=$2::jsonb WHERE id=$1', [connection, JSON.stringify(legacyCatalogue)]);
        }
      });
      await t.test("a discovery that ignores cancellation cannot commit its late answer", async () => {
        const provider = await catalogueProvider();
        let signal: AbortSignal | undefined;
        const pending = settings.ensureCatalogues(alice, 100, (owner, id, observed) => {
          signal = observed;
          return provider.discover(owner, id); // Deliberately ignore the supplied cancellation signal.
        }, { codexPriority: true });
        try {
          await beforeDeadline(provider.received, "the provider was never called");
          assert.equal(await pending, false);
          assert.equal(signal?.aborted, true);
          provider.reply([{ id: "late-provider-model", prioritySupported: true }]);
          await beforeDeadline(provider.calls[0].done, "the fixture did not deliver its late answer");
          await new Promise(resolve => setImmediate(resolve));
          assert.deepEqual((await pool.query('SELECT "modelCatalog" FROM byos_connections WHERE id=$1', [connection])).rows[0].modelCatalog, legacyCatalogue);
          assert.equal((await pool.query('SELECT 1 FROM byos_bindings WHERE "connectionId"=$1 AND "modelId"=$2', [connection, "late-provider-model"])).rowCount, 0);
        } finally { await provider.close(); await pending; }
      });
      await t.test("a new credential revision or revocation fences a refresh already in flight", async () => {
        for (const change of ["epoch", "state"] as const) {
          const provider = await catalogueProvider();
          const pending = settings.ensureCatalogues(alice, 8000, provider.discover, { codexPriority: true });
          try {
            await beforeDeadline(provider.received, "the provider was never called");
            await pool.query(change === "epoch" ? 'UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1' : "UPDATE byos_connections SET state='disconnected' WHERE id=$1", [connection]);
            provider.reply([{ id: "revoked-provider-model", prioritySupported: true }]);
            assert.equal(await beforeDeadline(pending, "revoked refresh did not settle"), false);
            assert.deepEqual((await pool.query('SELECT "modelCatalog" FROM byos_connections WHERE id=$1', [connection])).rows[0].modelCatalog, legacyCatalogue);
            assert.equal((await pool.query('SELECT 1 FROM byos_bindings WHERE "connectionId"=$1 AND "modelId"=$2', [connection, "revoked-provider-model"])).rowCount, 0);
          } finally {
            await provider.close(); await pending;
            await pool.query("UPDATE byos_connections SET epoch=1,state='connected' WHERE id=$1", [connection]);
          }
        }
      });
      await t.test("separate database and workspace authority never joins another refresh", async () => {
        const separate = `catalogue_${randomUUID().replaceAll("-", "")}`;
        await admin.query(`CREATE SCHEMA ${separate}`);
        const otherPool = new Pool({ connectionString: databaseURL, options: `-c search_path=${separate}` });
        try {
          await otherPool.query(`CREATE TABLE byos_connections (LIKE ${schema}.byos_connections INCLUDING ALL)`);
          await otherPool.query(`INSERT INTO byos_connections SELECT * FROM ${schema}.byos_connections WHERE id=$1`, [connection]);
          for (const [reader, target] of [[new ExecutionSettings(otherPool), alice], [settings, other]] as const) {
            const provider = await catalogueProvider();
            const bothStarted = Promise.withResolvers<void>();
            const discover = (owner: string, id: string, signal?: AbortSignal) => {
              const pending = provider.discover(owner, id, signal);
              if (provider.calls.length === 2) bothStarted.resolve();
              return pending;
            };
            const reads = [settings.ensureCatalogues(alice, 8000, discover, { codexPriority: true }), reader.ensureCatalogues(target, 8000, discover, { codexPriority: true })];
            try {
              await beforeDeadline(bothStarted.promise, "distinct authority shared an in-flight refresh");
              assert.equal(provider.calls.length, 2);
              assert.notEqual(provider.calls[0].signal, provider.calls[1].signal);
            } finally { await provider.close(); await Promise.all(reads); }
          }
        } finally { await otherPool.end(); await admin.query(`DROP SCHEMA ${separate} CASCADE`); }
      });
      await t.test("provider failure tracing exports only safe reason and closed catalogue attributes", async () => {
        const provider = await catalogueProvider();
        const warnings: string[] = [];
        const warning = mock.method(console, "warn", (line: unknown) => { warnings.push(String(line)); });
        const pending = settings.ensureCatalogues(alice, 8000, provider.discover, { codexPriority: true });
        try {
          await beforeDeadline(provider.received, "the provider was never called");
          provider.refuse("https://private-catalogue.test/models?key=private-key Authorization: private-token");
          assert.equal(await pending, false);
          await telemetry.forceFlush();
          const span = spans.getFinishedSpans().filter(span => span.name === "subscription.models").at(-1)!;
          assert.equal(span.status.code, SpanStatusCode.ERROR);
          assert.equal(span.attributes["error.type"], "Error");
          assert.equal(span.attributes["mikka.catalogue.provider"], "codex");
          assert.equal(span.attributes["mikka.catalogue.refresh_count"], 1);
          const sanitized = sanitizeSpan(span);
          assert.doesNotMatch(JSON.stringify({ attributes: sanitized.attributes, events: sanitized.events, warnings }), /private-|Authorization|\/models|alice/);
          assert.deepEqual((await pool.query('SELECT "modelCatalog" FROM byos_connections WHERE id=$1', [connection])).rows[0].modelCatalog, legacyCatalogue);
        } finally { warning.mock.restore(); await provider.close(); await pending; }
      });
      assert.equal((await settings.connectedSubscriptions('alice',true)).includes(connection),false);
      assert.equal((await settings.connectedSubscriptions('alice',true,{codexPriority:true})).includes(connection),true);
      let catalogueReads=0;
      const unknownCapability = async () => { catalogueReads++; return [{id:'provider-model'},{id:'second-provider-model'}] };
      await settings.ensureCatalogues(alice,8000,unknownCapability);
      assert.equal(catalogueReads,0,'ordinary availability does not discover an optional chat capability');
      assert.deepEqual((await pool.query('SELECT "modelCatalog" FROM byos_connections WHERE id=$1',[connection])).rows[0].modelCatalog,legacyCatalogue);
      let failedReads=0;
      const failedDiscovery = async () => { failedReads++; throw new Error('synthetic catalogue failure') };
      const warnings: string[]=[];
      const warning=mock.method(console,'warn',(line: unknown) => { warnings.push(String(line)) });
      try { await settings.ensureCatalogues(alice,8000,failedDiscovery,{codexPriority:true}); }
      finally { warning.mock.restore(); }
      assert.equal(failedReads,1); assert.equal(warnings.length,1);
      assert.equal(JSON.parse(warnings[0]).msg,'subscription_catalogue_failed');
      assert.deepEqual((await pool.query('SELECT "modelCatalog" FROM byos_connections WHERE id=$1',[connection])).rows[0].modelCatalog,legacyCatalogue,'a failed upgrade does not mark capability as read');
      await settings.ensureCatalogues(alice,8000,failedDiscovery);
      assert.equal(failedReads,1,'ordinary dispatch does not retry a failed optional upgrade');
      await settings.ensureCatalogues(alice,8000,unknownCapability,{codexPriority:true});
      await settings.ensureCatalogues(alice,8000,unknownCapability,{codexPriority:true});
      assert.equal(catalogueReads,1,'successful unknown capability is read once, not probed on every menu read');
      assert.equal((await settings.connectedSubscriptions('alice',true,{codexPriority:true})).includes(connection),false);
      assert.deepEqual((await pool.query('SELECT "modelCatalog" FROM byos_connections WHERE id=$1',[connection])).rows[0].modelCatalog.prioritySupport,{});
      await pool.query(`UPDATE byos_connections SET "modelCatalog"=jsonb_set("modelCatalog",'{revision}','"0"') WHERE id=$1`,[connection]);
      await settings.ensureCatalogues(alice,8000,unknownCapability);
      assert.equal(catalogueReads,2,'ordinary dispatch still refreshes a stale credential epoch catalogue');
      await pool.query('UPDATE byos_connections SET "modelCatalog"=NULL WHERE id=$1',[connection]);
      await settings.ensureCatalogues(alice,8000,unknownCapability);
      assert.equal(catalogueReads,3,'ordinary dispatch still discovers genuinely missing models');

      await assert.rejects(settings.refreshBotModels(bob, connection, async () => { throw new Error('must not discover foreign account') }), { code: 'executionAccountUnavailable' });
      // A subscription belongs to the account: its owner refreshes it from any workspace (decision 2026-10-31-2130).
      await settings.refreshBotModels(other, connection, async () => []);
      await settings.refreshBotModels(alice, connection, async () => [{id:'fresh-only'}]);
      assert.deepEqual((await settings.botModels(alice)).map(row=>row.modelId),['fresh-only']);
      assert.equal(await settings.botModel(alice,secondBot),copiedBinding,'refresh preserves saved binding');
      await settings.refreshBotModels(alice, connection, async () => []);
      assert.deepEqual(await settings.botModels(alice),[],'empty provider catalogue remains authoritative');
      await settings.refreshBotModels(alice, connection, async () => [{id:'dynamic-model'}]);
      assert.equal((await (await import('./bot-model-menu')).botModelMenu(pool,settings,alice,secondBot)).current.id,(await settings.botModels(alice))[0].bindingId,'the picker maps the saved copy to its visible option');
      await assert.rejects(settings.refreshBotModels(alice, connection, async () => { throw new Error('raw provider response'); }), {code:'executionAccountUnavailable'});
      await assert.rejects(settings.refreshBotModels(alice, connection, async () => {
        await pool.query(`UPDATE byos_connections SET epoch=2 WHERE id=$1`,[connection]);
        return [{id:'stale-provider-model'}];
      }), {code:'executionAccountUnavailable'});
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM byos_bindings WHERE "modelId"='stale-provider-model'`)).rows[0].count,0);
      await pool.query(`UPDATE byos_connections SET epoch=1 WHERE id=$1`,[connection]);
      let sessionOwner: string | null = "alice";
      const stub = (path: string, exports: Record<string, unknown>) =>
        mock.module(new URL(path, import.meta.url).href, {
          namedExports: exports,
        });
      mock.module("@/lib/server-runtime/headers", {
        namedExports: { headers: async () => new Headers() },
      });
      stub("./auth.ts", {
        auth: {
          api: {
            getSession: async () =>
              sessionOwner ? { user: { id: sessionOwner } } : null,
          },
        },
      });
      stub("./workspace-access.ts", {
        loadWorkspaceContext: async () => ({
          workspace: { id: alice.workspaceId },
        }),
      });
      stub("./db/index.ts", { pool });
      const actions = await import("../app/actions/execution-settings");
      const { freezeBotModel } = await import('./bot-model-selection');
      const { SubscriptionRepository } = await import('./subscription-repository');
      const dependencies = {service:()=>({repository:new SubscriptionRepository(pool)}) as never, workspace:async () => {}};
      const frozen = await freezeBotModel({ownerId:alice.ownerId,workspaceId:alice.workspaceId,botId:secondBot},dependencies);
      assert.equal((frozen.modelSelection as { bindingId?: string } | undefined)?.bindingId,copiedBinding,'execution uses its stored hidden binding after model list deduplication');
      const catalogue = (await settings.botModels(alice))[0];
      await settings.setBotModel(alice,null,catalogue.bindingId);
      const coordinator = await freezeBotModel({ownerId:alice.ownerId,workspaceId:alice.workspaceId,botId:null},dependencies);
      assert.equal(coordinator.modelSelection?.modelId,'dynamic-model','refreshed catalogue bindings support Coordinator execution');
      assert.equal((await (await import('./bot-model-menu')).botModelMenu(pool,settings,alice,secondBot)).current.id,catalogue.bindingId,'the picker shows the visible option for a saved copied binding');
      const unbound = {ownerId:'bob',workspaceId:randomUUID(),botId:randomUUID()};
      await pool.query('INSERT INTO mikka_workspaces(id) VALUES ($1)', [unbound.workspaceId]);
      await pool.query(`INSERT INTO mikka_workspace_members VALUES ($1,'bob','Bob','active')`, [unbound.workspaceId]);
      await pool.query('INSERT INTO bots (id,"ownerId","workspaceId") VALUES ($1,$2,$3)',[unbound.botId,unbound.ownerId,unbound.workspaceId]);
      await assert.rejects(freezeBotModel(unbound,dependencies),{code:'executionModelUnknown'},'a bot with no choice and no subscription asks for a model');
      const revokedBot = randomUUID();
      await pool.query('INSERT INTO bots (id,"ownerId","workspaceId") VALUES ($1,$2,$3)',[revokedBot,alice.ownerId,alice.workspaceId]);
      await settings.setBotModel(alice,revokedBot,catalogue.bindingId);
      const { rows: [revoked] } = await pool.query('UPDATE byos_connections SET state=$2 WHERE id=(SELECT "connectionId" FROM byos_bindings WHERE id=$1) RETURNING id,state',[catalogue.bindingId,'disconnected']);
      const others = await pool.query(`UPDATE byos_connections SET state='disconnected' WHERE "ownerId"=$1 AND "workspaceId"=$2 AND state='connected' RETURNING id`,[alice.ownerId,alice.workspaceId]);
      await assert.rejects(freezeBotModel({ownerId:alice.ownerId,workspaceId:alice.workspaceId,botId:revokedBot},dependencies),{code:'executionModelUnknown'},'a saved choice whose account was disconnected, with nothing else bound, asks for a model (no Mikka 默认)');
      await assert.rejects(freezeBotModel({ownerId:alice.ownerId,workspaceId:alice.workspaceId,botId:null},dependencies),{code:'executionModelUnknown'},'the Coordinator with no bound subscription asks for a model (no Mikka 默认)');
      await pool.query(`UPDATE byos_connections SET state='connected' WHERE id=ANY($1::uuid[])`,[[revoked.id,...others.rows.map(row=>row.id)]]);

      // Decision 2026-11-01-2240: a subscription connected once, in alice's first workspace, runs her own bots in team B
      // with no share row and no switch; 分享给团队成员 and the admin switch decide only other members' use.
      const teamB = { ownerId: alice.ownerId, workspaceId: randomUUID() };
      const teamBot = randomUUID(), bobBot = randomUUID();
      await pool.query('INSERT INTO mikka_workspaces(id) VALUES ($1)', [teamB.workspaceId]);
      await pool.query(`INSERT INTO mikka_workspace_members VALUES ($1,'alice','Alice','active'),($1,'bob','Bob','active')`, [teamB.workspaceId]);
      await pool.query('INSERT INTO bots (id,"ownerId","workspaceId") VALUES ($1,$2,$3),($4,$5,$3)',[teamBot,alice.ownerId,teamB.workspaceId,bobBot,'bob']);
      const inTeam = await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:teamBot},dependencies);
      assert.equal(inTeam.modelSelection?.workspaceId,teamB.workspaceId,'her own bot uses her subscription without sharing; the run and its binding belong to team B');
      assert.equal(inTeam.modelSelection?.consumerId,teamBot);
      assert.ok((await settings.botModels(teamB)).length > 0,'Bot 与 Agents in team B offers her own subscription without sharing');
      const teamMenu = await (await import('./bot-model-menu')).botModelMenu(pool,settings,teamB,null);
      assert.ok(teamMenu.groups.some(group => group.kind === 'subscription' && group.options.length > 0),'her Coordinator\'s model menu in team B lists her subscription');
      const { rows: [teamBinding] } = await pool.query('SELECT b."workspaceId",c."workspaceId" AS "connectionWorkspace" FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId" WHERE b.id=$1',[(inTeam.modelSelection as { bindingId: string }).bindingId]);
      assert.deepEqual(teamBinding,{workspaceId:teamB.workspaceId,connectionWorkspace:alice.workspaceId},'the connection keeps the workspace it was made in; nothing is re-issued');
      const teamCoordinator = await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:null},dependencies);
      assert.equal(teamCoordinator.modelSelection?.workspaceId,teamB.workspaceId,'her Coordinator in team B uses her subscription too');
      // Unshared, it is hers alone.
      assert.equal((await settings.botModels({ownerId:'bob',workspaceId:teamB.workspaceId})).length,0,'another member of team B never sees or uses it');
      await assert.rejects(freezeBotModel({ownerId:'bob',workspaceId:teamB.workspaceId,botId:bobBot},dependencies),{code:'executionModelUnknown'},'another member\'s bot asks for a model');
      await assert.rejects(settings.bindingForBot({ownerId:'bob',workspaceId:teamB.workspaceId},null,catalogue.bindingId),{code:'account_unavailable'},'another member\'s binding is a borrow refusal, not an unknown model');
      await assert.rejects(settings.setBotModel({ownerId:'bob',workspaceId:teamB.workspaceId},bobBot,catalogue.bindingId),{code:'executionModelUnknown'});
      // A choice borrowed before owner-only stays stored under the member: the run refuses it.
      await pool.query('INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId") VALUES ($1,$2,$3,$4)',['bob',teamB.workspaceId,bobBot,catalogue.bindingId]);
      await assert.rejects(freezeBotModel({ownerId:'bob',workspaceId:teamB.workspaceId,botId:bobBot},dependencies),{code:'account_unavailable'},'a member\'s stored borrow refuses as unavailable, not an unknown model');
      await pool.query('DELETE FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2',['bob',teamB.workspaceId]);
      // Team B's admin switch 团队权限 › 订阅与 API Key off (decision 2026-11-27-1740): her own subscription does not serve there.
      await pool.query('INSERT INTO workspace_personal_policies ("workspaceId",subscriptions) VALUES ($1,false)',[teamB.workspaceId]);
      assert.equal((await settings.botModels(teamB)).length,0,'admin switch off: her menu in team B offers no own subscription');
      for (const botId of [teamBot,null]) {
        const frozen = await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId},dependencies).catch((error: unknown) => error);
        assert.notEqual((frozen as { modelSelection?: { type?: string } }).modelSelection?.type,'subscription','admin switch off: neither her bot nor her Coordinator runs on her subscription there');
      }
      await pool.query('UPDATE workspace_personal_policies SET subscriptions=true WHERE "workspaceId"=$1',[teamB.workspaceId]);
      assert.ok((await settings.botModels(teamB)).length > 0,'admin switch on: her menu offers it again');
      assert.ok((await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:teamBot},dependencies)).modelSelection,'admin switch on: her own bot uses her subscription');
      // A subscription serves its owner only (decision 2026-11-17): bob's bot never runs on hers.
      await assert.rejects(freezeBotModel({ownerId:'bob',workspaceId:teamB.workspaceId,botId:bobBot},dependencies),{code:'executionModelUnknown'},'bob\'s bot asks for his own model');
      await assert.rejects(freezeBotModel({ownerId:'bob',workspaceId:teamB.workspaceId,botId:null},dependencies),{code:'executionModelUnknown'},'bob\'s Coordinator never uses another member\'s subscription');
      assert.equal((await settings.botModels({ownerId:'bob',workspaceId:teamB.workspaceId})).length,0,'bob is never offered her credential');
      assert.ok((await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:teamBot},dependencies)).modelSelection,'hers still works');
      sessionOwner = null;
      await assert.rejects(actions.listBotModels());
      sessionOwner = "alice";
      await pool.query(
        `UPDATE byos_connections SET state='disconnected' WHERE id=$1`,
        [connection],
      );
      assert.equal((await settings.botModels(alice)).length, 0);
      await assert.rejects(settings.setBotModel(alice, bot, binding));
    } finally {
      await telemetry.shutdown();
      trace.disable(); context.disable(); propagation.disable();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

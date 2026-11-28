import { reconcileSubscriptionModels, type ModelSettings } from './enabled-models-policy'
import type { SubscriptionCatalogueModel } from './subscription-service-tier'
import "server-only";
import { ActionFailureError } from "./action-error";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { HOSTED_CHOICE, creditsOptionId, parseCreditsOption } from "./bot-model-menu-view";
import { creditsModelOffered } from "./credits-models";
import { subscriptionRouteReady } from "./subscription-routes";
import { executionBinding, executionModelOptions } from "./execution-model-options";
import { afterJob } from "./background";
import { databaseCommitScope } from "./db/commit-effects";
import { singleFlight } from "./single-flight";
import { abortable } from "@mikka/protocol/web-url-policy";
import { safeErrorAttributes } from "@mikka/protocol/tracing";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

export interface ExecutionSettingsScope {
  ownerId: string;
  workspaceId: string;
}
/** Callers obtain scope from the session and current workspace, never from input. */
type CatalogueRequirements = { codexPriority?: true; deferOptional?: true };
type DiscoverModels = (ownerId: string, connectionId: string, signal?: AbortSignal) => Promise<SubscriptionCatalogueModel[]>;

export class ExecutionSettings {
  constructor(readonly pool: Pool) {}
  /** The owner's connected subscriptions, from any workspace: a subscription belongs to the account,
   * and its owner may always use it here (decision 2026-11-01-2240). Membership is the caller's check. */
  private async connectedBindings(
    scope: ExecutionSettingsScope,
    bindingId?: string,
    query: Pick<PoolClient, "query"> = this.pool,
  ) {
    return this.bindingsOf(scope.ownerId, scope.workspaceId, bindingId, query);
  }
  private async bindingsOf(
    ownerId: string,
    workspaceId: string,
    bindingId?: string,
    query: Pick<PoolClient, "query"> = this.pool,
  ) {
    const scope = { ownerId, workspaceId };
    if (!bindingId) return executionModelOptions(query, scope);
    const binding = await executionBinding(query, scope, bindingId);
    return binding ? [binding] : [];
  }
  /** Public model identities only: quota is read once per connection by credentialStates. */
  async modelCandidates(scope: ExecutionSettingsScope, query: Pick<PoolClient, "query"> = this.pool) {
    return executionModelOptions(query, scope, true);
  }

  /** False once the owner left or was suspended and the bot was archived (§8.3), or when it is not theirs. */
  async botActive(ownerId: string, botId: string) {
    return Boolean((await this.pool.query('SELECT 1 FROM bots WHERE id=$1 AND "ownerId"=$2 AND "archivedAt" IS NULL', [botId, ownerId])).rowCount);
  }
  /** Execution resolves its saved binding independently of the deduplicated catalogue. */
  async botBinding(scope: ExecutionSettingsScope, bindingId: string) {
    return (await this.connectedBindings(scope, bindingId))[0];
  }
  /** The binding exists but under another owner — a stored borrow, not a
   * missing model. A gone binding answers false so callers keep their fallback. */
  async bindingHeldElsewhere(
    scope: ExecutionSettingsScope,
    bindingId: string,
    query: Pick<PoolClient, "query"> = this.pool,
  ): Promise<boolean> {
    const { rows: [held] } = await query.query<{ ownerId: string }>(
      'SELECT b."ownerId" FROM byos_bindings b WHERE b.id=$1', [bindingId]);
    return Boolean(held && held.ownerId !== scope.ownerId);
  }
  /** A bot chat's subscription options: `botModels` on a route that answers chats for its owner (`subscriptionRouteReady`). */
  async chatModels(scope: ExecutionSettingsScope, query: Pick<PoolClient, "query"> = this.pool, rows?: Awaited<ReturnType<ExecutionSettings["botModels"]>>) {
    return chatReady(rows ?? await this.botModels(scope, query));
  }
  /** A saved chat choice, while its route answers chats. */
  async chatBinding(scope: ExecutionSettingsScope, bindingId: string) {
    const row = await this.botBinding(scope, bindingId);
    return row && (await chatReady([row])).length ? row : undefined;
  }
  /** One option per model/account. Binding lookups remain independent of this presentation deduplication. */
  async botModels(
    scope: ExecutionSettingsScope,
    query: Pick<PoolClient, "query"> = this.pool,
  ) {
    const seen = new Set<string>();
    return (await this.connectedBindings(scope, undefined, query)).filter(
      (row) => {
        const key = JSON.stringify([row.connectionId, row.modelId]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    );
  }
  /** Missing models are refreshed for every consumer; menu/settings reads may also request optional Fast metadata. */
  async connectedSubscriptions(ownerId: string, missingOnly = false, requirements: CatalogueRequirements = {}): Promise<string[]> {
    return (await this.catalogueCandidates(ownerId, missingOnly, requirements)).map(row => row.id);
  }
  private async catalogueCandidates(ownerId: string, missingOnly: boolean, requirements: CatalogueRequirements) {
    return (await this.pool.query<{ id: string; epoch: string; missing: boolean }>(
      `SELECT id::text AS id,epoch::text AS epoch,"modelCatalog"->>'revision' IS DISTINCT FROM epoch::text AS missing
       FROM byos_connections WHERE "ownerId"=$1 AND state='connected' AND paused=false AND "removedAt" IS NULL
       AND ($2::boolean=false OR "modelCatalog"->>'revision' IS DISTINCT FROM epoch::text
         OR ($3::boolean AND provider='codex' AND "modelCatalog"->>'priorityVersion' IS DISTINCT FROM '1')) ORDER BY id`,
      [ownerId, missingOnly, requirements.codexPriority === true])).rows;
  }
  /**
   * A subscription's models reach the menu, 优先使用的模型 and dispatch only through its catalogue.
   * Each connected subscription with none for its current revision asks its account once; one that
   * does not answer in time is cancelled and asked again on the next read. Valid
   * models need not wait for optional metadata; the menu owns that bounded after job.
   */
  async ensureCatalogues(scope: ExecutionSettingsScope, timeoutMs = 8000, discover?: DiscoverModels, requirements: CatalogueRequirements = {}): Promise<boolean> {
    const candidates = await this.catalogueCandidates(scope.ownerId, true, requirements);
    const deferred = requirements.deferOptional ? candidates.filter(row => !row.missing) : [];
    trace.getActiveSpan()?.setAttributes({
      'mikka.catalogue.cache': candidates.some(row => row.missing) ? 'miss' : candidates.length ? 'optional_metadata' : 'hit',
      'mikka.catalogue.refresh_candidates': candidates.length,
      'mikka.catalogue.deferred': deferred.length,
    });
    if (deferred.length) {
      afterJob('after:subscription-catalogue', async () => {
        // Recheck current ownership/state/revision in the owned background
        // context; another request may already have completed the upgrade.
        if (await this.ensureCatalogues(scope, timeoutMs, discover, { codexPriority: true })) {
          await (await import('./live/lists')).ownerSettingsChanged(this.pool, scope.ownerId);
        }
      });
    }
    const results = await Promise.all(candidates.filter(row => !requirements.deferOptional || row.missing).map(connection =>
      singleFlight(['subscription-catalogue', scope.ownerId, scope.workspaceId, connection.id, connection.epoch, timeoutMs], async () => {
        try {
          await this.refreshBotModels(scope, connection.id, discover, AbortSignal.timeout(timeoutMs));
          return true;
        } catch (error: unknown) {
          // The reason only, never the provider response or its credential.
          const safe = safeErrorAttributes(error instanceof ActionFailureError && error.cause ? error.cause : error);
          console.warn(JSON.stringify({ level: 'warn', msg: 'subscription_catalogue_failed', code: safe['mikka.error.code'] ?? safe['error.type'] ?? 'unknown' }));
          return false;
        }
      }, databaseCommitScope(this.pool))));
    // The flight shares no menu/credential projection. Each caller reads its
    // own authorized view after this barrier in its own request context.
    return results.some(Boolean);
  }
  async refreshBotModels(scope: ExecutionSettingsScope, connectionId: string, discover?: DiscoverModels, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!z.uuid().safeParse(connectionId).success) throw new ActionFailureError("executionAccountUnavailable");
    const connection = (await this.pool.query(
      `SELECT id,epoch,provider,"workspaceId" FROM byos_connections WHERE id=$1 AND "ownerId"=$2 AND state='connected' AND paused=false AND "removedAt" IS NULL`,
      [connectionId, scope.ownerId])).rows[0];
    if (!connection) throw new ActionFailureError("executionAccountUnavailable");
    let models: SubscriptionCatalogueModel[];
    try {
      models = await trace.getTracer('mikka.subscription').startActiveSpan('subscription.models', {
        kind: SpanKind.CLIENT, attributes: { 'mikka.catalogue.provider': connection.provider === 'codex' ? 'codex' : 'claude', 'mikka.catalogue.refresh_count': 1 },
      }, async span => {
        try {
          const readModels = () => (discover ?? (async (ownerId, id, signal) => (await import("./subscription-runtime")).subscriptionRuntime().models(ownerId, id, signal)))(scope.ownerId, connectionId, signal);
          return signal ? await abortable(readModels, signal) : await readModels();
        } catch (error) {
          span.setAttributes(safeErrorAttributes(error));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally { span.end(); }
      });
    } catch (error) { throw Object.assign(new ActionFailureError("executionAccountUnavailable"), { cause: error }); }
    signal?.throwIfAborted();
    const unique = [...new Map(models.map(model => [model.id, model])).values()];
    const route = connection.provider === 'codex' ? 'codex_cpa' : 'claude_cpa';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      signal?.throwIfAborted();
      const current = await client.query(`SELECT id,"modelSettings" FROM byos_connections WHERE id=$1 AND "ownerId"=$2 AND epoch=$3 AND state='connected' AND paused=false AND "removedAt" IS NULL FOR UPDATE`, [connectionId,scope.ownerId,connection.epoch]);
      if (!current.rowCount) throw new ActionFailureError("executionAccountUnavailable");
      for (const model of unique) {
        signal?.throwIfAborted();
        if (!z.string().trim().min(1).max(128).safeParse(model.id).success) throw new ActionFailureError("executionModelUnknown");
        // Account-level catalogue: the id leaves out the workspace, and the row keeps the connection's own workspace.
        const hash = createHash('sha256').update(JSON.stringify([scope.ownerId,connectionId,connection.epoch,model.id])).digest('hex');
        const id = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
        await client.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`, [id,scope.ownerId,connection.workspaceId,id,connectionId,connection.epoch,route,model.id]);
      }
      const codexUltrafast = connection.provider === 'codex'
        ? Object.fromEntries(unique.filter(model => typeof model.ultrafastSupported === 'boolean').map(model => [model.id, model.ultrafastSupported]))
        : null;
      const claudeFast = connection.provider === 'claude'
        ? Object.fromEntries(unique.filter(model => typeof model.fastSupported === 'boolean').map(model => [model.id, model.fastSupported]))
        : null;
      const webSearchSupport = Object.fromEntries(unique.filter(model => typeof model.webSearchSupported === 'boolean').map(model => [model.id, model.webSearchSupported]));
      const catalogPayload = {
        revision: String(connection.epoch),
        models: unique.map(model => model.id),
        webSearchVersion: 1,
        ...(connection.provider === 'codex' ? {
          priorityVersion: 1,
          prioritySupport: Object.fromEntries(unique.filter(model => typeof model.prioritySupported === 'boolean').map(model => [model.id, model.prioritySupported])),
          ...(codexUltrafast && Object.keys(codexUltrafast).length ? { ultrafastSupport: codexUltrafast } : {}),
        } : {}),
        ...(claudeFast && Object.keys(claudeFast).length ? { fastSupport: claudeFast } : {}),
        ...(Object.keys(webSearchSupport).length ? { webSearchSupport } : {}),
        // Each model's reasoning levels as the account's catalogue lists them (lib/model-capabilities.ts reads them).
        ...(unique.some(model => model.efforts) ? { effortSupport: Object.fromEntries(unique.filter(model => model.efforts).map(model => [model.id, model.efforts])) } : {}),
        ...(unique.some(model => model.defaultEffort) ? { defaultEffort: Object.fromEntries(unique.filter(model => model.defaultEffort).map(model => [model.id, model.defaultEffort])) } : {}),
        // The seat's Daybreak access: each model's tiers its catalogue offers (Capy's per-seat `DaybreakAccess`).
        ...(unique.some(model => model.daybreak?.length) ? { daybreakSupport: Object.fromEntries(unique.filter(model => model.daybreak?.length).map(model => [model.id, model.daybreak])) } : {}),
      };
      signal?.throwIfAborted();
      await client.query(`UPDATE byos_connections SET "modelCatalog"=$2::jsonb,"modelSettings"=$3::jsonb WHERE id=$1`, [connectionId, JSON.stringify(catalogPayload), JSON.stringify({ ...reconcileSubscriptionModels(unique.map(model => model.id), current.rows[0].modelSettings as ModelSettings | null), refreshedAt: new Date().toISOString() })]);
      signal?.throwIfAborted();
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const options = (await this.botModels(scope)).filter(row => row.connectionId === connectionId && unique.some(model => model.id === row.modelId));
    return options;
  }
  async setBotModel(
    scope: ExecutionSettingsScope,
    botId: string | null,
    bindingId: string | null,
  ) {
    if (botId !== null) {
      if (!z.uuid().safeParse(botId).success)
        throw new ActionFailureError("botNotFound");
      if (
        !(
          await this.pool.query(
            'SELECT id FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "archivedAt" IS NULL',
            [botId, scope.ownerId, scope.workspaceId],
          )
        ).rowCount
      )
        throw new ActionFailureError("botNotFound");
    }
    const key = botId ?? "coordinator";
    // A model run on Mikka 额度 (decision 2026-11-15-1900): `credits:<vendor/model>`, no binding or key behind it.
    const credits = parseCreditsOption(bindingId ?? "");
    if (credits) {
      if (!(await creditsModelOffered(credits, scope.ownerId))) throw new ActionFailureError("executionModelUnknown");
      await this.pool.query(
        // The pick replaces a subscription or API key model saved before.
        'INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","creditsModel") VALUES ($1,$2,$3,$4) ON CONFLICT ("ownerId","workspaceId","botKey") DO UPDATE SET "bindingId"=NULL,"apiKeyId"=NULL,"apiKeyModel"=NULL,"creditsModel"=EXCLUDED."creditsModel"',
        [scope.ownerId, scope.workspaceId, key, credits],
      );
      return;
    }
    if (bindingId === null || bindingId === "auto")
      throw new ActionFailureError("executionAutoNotAllowed");
    if (!z.uuid().safeParse(bindingId).success)
      throw new ActionFailureError("executionModelUnknown");
    const choice = (await this.connectedBindings(scope, bindingId)).find(
      (row) => row.bindingId === bindingId,
    );
    // A subscription serves its owner only (decision 2026-11-17): only this person's own binding is a choice.
    if (!choice) throw new ActionFailureError("executionModelUnknown");
    bindingId = await this.bindingForBot(scope, botId, bindingId);
    await this.pool.query(
      'INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId") VALUES ($1,$2,$3,$4) ON CONFLICT ("ownerId","workspaceId","botKey") DO UPDATE SET "bindingId"=EXCLUDED."bindingId","apiKeyId"=NULL,"apiKeyModel"=NULL,"creditsModel"=NULL',
      [scope.ownerId, scope.workspaceId, key, bindingId],
    );
  }
  /**
   * An opt-in temporary pick can create only an absent preference. Its receipt
   * identifies the stored per-bot binding, not a deduplicated menu option.
   * The clone and insert share a short transaction; a conflict rolls both back.
   */
  async setTemporaryBotModel(scope: ExecutionSettingsScope, botId: string, bindingId: string): Promise<{ bindingId: string; revision: string } | null> {
    if (!z.uuid().safeParse(botId).success) throw new ActionFailureError("botNotFound");
    if (!z.uuid().safeParse(bindingId).success || bindingId === HOSTED_CHOICE) throw new ActionFailureError("executionModelUnknown");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const bot = await client.query('SELECT id FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "archivedAt" IS NULL FOR SHARE',
        [botId, scope.ownerId, scope.workspaceId]);
      if (!bot.rowCount) throw new ActionFailureError("botNotFound");
      // Only this account's usable subscription is eligible. Shared/API/hosted
      // selections retain the ordinary picker contract, not this temporary one.
      const storedBinding = await this.bindingForBot(scope, botId, bindingId, client);
      const { rows: [receipt] } = await client.query<{ bindingId: string; revision: string }>(
        'INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId") VALUES ($1,$2,$3,$4) ON CONFLICT ("ownerId","workspaceId","botKey") DO NOTHING RETURNING "bindingId",xmin::text AS revision',
        [scope.ownerId, scope.workspaceId, botId, storedBinding]);
      if (!receipt) { await client.query("ROLLBACK"); return null; }
      await client.query("COMMIT");
      return receipt;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  /** A receipt authorizes no scope: the normal route reauthenticates the bot.
   * A same-value rewrite has a new xmin and must survive this conditional delete.
   * A missing selection response cannot be reconstructed from current values. */
  async restoreTemporaryBotModel(scope: ExecutionSettingsScope, botId: string, receipt: { bindingId: string; revision: string }): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM bot_model_choices choice WHERE choice."ownerId"=$1 AND choice."workspaceId"=$2 AND choice."botKey"=$3 AND choice."bindingId"=$4 AND choice.xmin::text=$5 AND choice."apiKeyId" IS NULL AND choice."apiKeyModel" IS NULL AND EXISTS (SELECT 1 FROM bots bot WHERE bot.id=$3::uuid AND bot."ownerId"=$1 AND bot."workspaceId"=$2 AND bot."archivedAt" IS NULL)',
      [scope.ownerId, scope.workspaceId, botId, receipt.bindingId, receipt.revision]);
    return rowCount === 1;
  }
  /** Clone only the owner's connected account reference, never a credential. The clone belongs to
   * the run's workspace, so membership, admission and the admin switch are checked there. */
  async bindingForBot(
    scope: ExecutionSettingsScope,
    botId: string | null,
    bindingId: string,
    query: Pick<PoolClient, "query"> = this.pool,
  ): Promise<string> {
    const source = (await this.connectedBindings(scope, bindingId, query)).find(
      (row) => row.bindingId === bindingId,
    );
    if (!source) {
      // A member re-sending an owner's subscription-bound run holds someone
      // else's binding: refuse it as theirs-not-yours, not an unknown model
      // (issue #3057 — turn.started must not report executionModelUnknown).
      if (await this.bindingHeldElsewhere(scope, bindingId, query)) {
        const { SubscriptionRefusal } = await import("@mikka/protocol/subscription");
        throw new SubscriptionRefusal("account_unavailable");
      }
      throw new ActionFailureError("executionModelUnknown");
    }
    if (source.workspaceId === scope.workspaceId && (botId === null || source.consumerId === botId)) return bindingId;
    const hash = createHash("sha256")
      .update(
        JSON.stringify([scope.ownerId, scope.workspaceId, botId ?? "coordinator", bindingId]),
      )
      .digest("hex");
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const result = await query.query(
      `INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
      SELECT $1,b."ownerId",$4::text,$6::text,b."connectionId",b."connectionRevision",b.route,b."modelId" FROM byos_bindings b
      JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId" AND c.epoch=b."connectionRevision" AND c.state='connected' AND c.paused=false
      WHERE b.id=$5 AND b."ownerId"=$3
      AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM bots bot WHERE bot.id=$2::uuid AND bot."ownerId"=$3 AND bot."workspaceId"=$4::uuid))
      ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id RETURNING id`,
      [id, botId, scope.ownerId, scope.workspaceId, bindingId, botId ?? id],
    );
    if (!result.rows[0]) throw new ActionFailureError("executionModelUnknown");
    return result.rows[0].id;
  }
  async botModel(
    scope: ExecutionSettingsScope,
    botId: string | null,
  ): Promise<string | undefined> {
    const row = (
      await this.pool.query(
        'SELECT "bindingId","apiKeyId","creditsModel" FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3',
        [scope.ownerId, scope.workspaceId, botId ?? "coordinator"],
      )
    ).rows[0];
    if (row?.bindingId) return row.bindingId;
    // The saved choice is an API key's model (lib/model-api-keys.ts botApiKeyChoice), not a binding.
    if (row?.apiKeyId) return undefined;
    if (row?.creditsModel) return creditsOptionId(row.creditsModel);
    // A row with none of the three was 「Mikka 默认」 (gone, decision 2026-11-15-1900): no choice,
    // so the usual order below fills it in when a subscription exists.
    // Decision 2026-10-30 (#537): a Claude subscription first, otherwise ChatGPT/Codex, as `suggested` does.
    const models = await this.chatModels(scope);
    const first = models.find((m) => m.provider === "claude") ?? models[0];
    if (!first) return undefined;
    const bindingId = await this.bindingForBot(scope, botId, first.bindingId);
    await this.pool.query(
      'INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId") VALUES ($1,$2,$3,$4) ON CONFLICT ("ownerId","workspaceId","botKey") DO UPDATE SET "bindingId"=EXCLUDED."bindingId" WHERE bot_model_choices."bindingId" IS NULL AND bot_model_choices."apiKeyId" IS NULL AND bot_model_choices."creditsModel" IS NULL',
      [scope.ownerId, scope.workspaceId, botId ?? "coordinator", bindingId],
    );
    return this.botModel(scope, botId);
  }
}

/** Bot scope is exact. Work with no bot of its own (the Coordinator's triage,
 * memory extraction) runs and bills in the owner's first active workspace, as
 * before: it is charged where it happens, never moved to a new personal
 * workspace (decision 2026-10-31-2225). */
export async function executionWorkspace(
  ownerId: string,
  botId: string | null,
): Promise<string> {
  const { pool } = await import("./db");
  if (botId) {
    const bot = (
      await pool.query(
        // An archived bot (its owner left or was suspended) runs nothing until an admin takes it over (§8.3).
        'SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2 AND "archivedAt" IS NULL',
        [botId, ownerId],
      )
    ).rows[0];
    if (!bot) throw new ActionFailureError("botNotFound");
    await (
      await import("./subscription-runtime")
    ).authorizeSubscriptionWorkspace(ownerId, bot.workspaceId);
    return bot.workspaceId;
  }
  const { workspaceDb } = await import("./workspace-db");
  const { workspaceMembers, workspaces } =
    await import("./db/workspace-schema");
  const { and, eq, asc } = await import("drizzle-orm");
  const [workspace] = await workspaceDb
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      eq(workspaceMembers.workspaceId, workspaces.id),
    )
    .where(
      and(
        eq(workspaceMembers.userId, ownerId),
        eq(workspaceMembers.status, "active"),
      ),
    )
    .orderBy(asc(workspaces.createdAt))
    .limit(1);
  if (!workspace) throw new ActionFailureError("workspaceAccessDenied");
  return workspace.id;
}

/** The rows whose route answers bot chats for the subscription's owner; one check per owner and route. */
async function chatReady<T extends { route: string; ownerId: string }>(rows: T[]): Promise<T[]> {
  const ready = new Map<string, Promise<boolean>>();
  const check = (row: T) => {
    const key = `${row.ownerId}|${row.route}`;
    if (!ready.has(key)) ready.set(key, subscriptionRouteReady(row.route, row.ownerId));
    return ready.get(key)!;
  };
  const answers = await Promise.all(rows.map(check));
  return rows.filter((_, index) => answers[index]);
}

import "server-only";
import { hostedModelEnabled } from "./enabled-models";
import type { Pool } from "pg";
import { z } from "zod";
import { ActionFailureError } from "./action-error";
import type { ExecutionSettings, ExecutionSettingsScope } from "./execution-settings";
import { apiKeyChatBaseUrl } from "./model-api-key-providers";
import { subscriptionAvailability } from "./subscription-quota";
import { botModelPreference, resolveBotModelChoice } from "./bot-model-choice";
import { isCloudEdition } from "./edition";
import { defaultModelTarget } from "./default-model";
import { modelKeyOf, modesFor, modesFromTier, supportedModes, tierForModes, type ModelCapabilities, type ModelModes } from "./model-capabilities";
import { modelDisplayName } from "./model-display-name";
import { modelEnabled, type ModelSettings } from "./enabled-models-policy";
import { modelRouteRejection, ModelRouteUnavailable, type ModelRouteHealth } from "./model-route-rejection";

export { quotaExhausted } from "./subscription-quota";
import {
  pickerRouteKey, groupModelOptions, orderedRouteGroups, apiKeyOptionId,
  creditsOptionId,
  NO_MODEL,
  type BotModelCurrent,
  type BotModelMenuOption,
  type BotModelMenu,
  type BotModelMenuGroup,
} from "./bot-model-menu-view";

/**
 * The scope a chat's picker reads and saves in: the bot's own workspace, or
 * where the Coordinator runs. `freezeBotModel` resolves the same one, so the
 * chip shows what the next run uses. `onlyWorkspace` fences a workspace-bound token.
 */
export async function botModelScope(ownerId: string, botId: string | null, onlyWorkspace?: string): Promise<ExecutionSettingsScope> {
  if (botId !== null && !z.uuid().safeParse(botId).success) throw new ActionFailureError("botNotFound");
  const { executionWorkspace } = await import("./execution-settings");
  const workspaceId = await executionWorkspace(ownerId, botId);
  if (onlyWorkspace && onlyWorkspace !== workspaceId) throw new ActionFailureError("botNotFound");
  return { ownerId, workspaceId };
}


/**
 * The composer's model menu for one bot, or the Coordinator (`botId` null),
 * and what its chip shows. It lists only credentials the resolver can use in
 * this workspace (`ExecutionSettings.chatModels`), so the menu never offers a
 * model the next run would refuse. It reads; it never saves a default.
 */
export async function botModelMenu(
  pool: Pick<Pool, "query">,
  settings: Pick<ExecutionSettings, "botModels" | "chatModels" | "chatBinding">,
  scope: ExecutionSettingsScope,
  botId: string | null,
  now = Date.now(),
  inspectPreference = false,
): Promise<BotModelMenu & { preferenceState?: "absent" | "present" }> {
  const [{ usableApiKeys }, { hostedPointsHere }, { creditsModels }] = await Promise.all([
    import("./model-api-keys"), import("./points-fallback"), import("./credits-models"),
  ]);
  const local = !isCloudEdition();
  const subscriptionsRead = settings.botModels(scope).then(async allRows => {
    const rows = await settings.chatModels(scope, pool, allRows);
    return { allRows, rows };
  });
  const keysRead = usableApiKeys(pool, scope.ownerId, scope.workspaceId).then(allKeys => {
    const keys = allKeys.filter((key) => apiKeyChatBaseUrl(key) && key.models.length);
    return { allKeys, keys };
  });
  const pointsRead = local ? Promise.resolve({ points: 0 }) : hostedPointsHere(scope.workspaceId);
  const enabledRead = (async () => {
    const target = local ? await defaultModelTarget(scope.ownerId) : null;
    return await hostedModelEnabled(pool, scope.ownerId) && (!local || target !== null);
  })();
  const preferenceRead = botModelPreference(pool, scope, botId);
  const catalogueRead = enabledRead.then(enabled => enabled ? creditsModels(scope.ownerId) : []);
  // #2938 (2): LiteLLM list pricing rides every menu option, whichever route serves it.
  const pricingRead = import("./model-catalog-server").then(async ({ modelCatalog }) =>
    new Map((await modelCatalog()).map(model => [model.id, model.pricing] as const))).catch(() => new Map<string, never>());
  const ownerNamesRead = keysRead.then(({ keys }) => {
    const sharedOwners = [...new Set(keys.filter((key) => !key.mine).map((key) => key.ownerId))];
    return sharedOwners.length ? memberNames(scope.workspaceId, sharedOwners) : new Map<string, string>();
  });
  const choiceRead = Promise.all([subscriptionsRead, keysRead, preferenceRead]).then(([{ allRows, rows }, { allKeys, keys }, preference]) =>
    resolveBotModelChoice(pool, settings, scope, botId, preference, { rows, keys, now, fallback: { rows: allRows, keys: allKeys } }));
  const [{ rows }, { keys }, { points }, enabled, preference, catalogue, ownerNames, choice, pricing] = await Promise.all([
    subscriptionsRead, keysRead, pointsRead, enabledRead, preferenceRead, catalogueRead, ownerNamesRead, choiceRead, pricingRead,
  ]);
  const priceFor = (modelId: string) => {
    // Catalogue keys are gateway-shaped (`vendor/model`); a bare id matches its vendor entry.
    const price = pricing.get(modelId)
      ?? (modelId.includes('/') ? undefined : [...pricing.entries()].find(([id]) => id.endsWith(`/${modelId}`))?.[1]);
    return price ? { price: { input: price.input, output: price.output } } : {};
  };
  // Claude first, then ChatGPT/Codex, as the resolver orders them (orchestration §2).
  const ordered = [
    ...rows.filter((row) => row.provider === "claude"),
    ...rows.filter((row) => row.provider !== "claude"),
  ];
  const subscriptions = new Map<string, BotModelMenuGroup>();
  for (const row of ordered) {
    const key = String(row.connectionId);
    const group: BotModelMenuGroup = subscriptions.get(key) ?? {
      kind: "subscription",
      provider: row.provider,
      plan: row.plan ?? null,
      credentialLabel: row.accountLabel?.trim() || `…${String(row.connectionId).slice(-6)}`,
      options: [],
    };
    subscriptions.set(key, group);
    // The connection's own usage limit for this model: an exhausted one stays listed, dimmed with when it resets.
    const quota = subscriptionAvailability(row.quota, row.modelId, row.provider === "codex" ? "codex" : "claude", now);
    group.options.push({
      id: row.bindingId, modelId: row.modelId, provider: row.provider, ...priceFor(row.modelId),
      route: { source: "subscription", connectionId: key, label: group.credentialLabel ?? "", service: row.provider },
      ...(quota.status === "exhausted" ? {
        unavailable: { reason: "quota" as const, resetsAt: quota.resetsAt },
        health: modelRouteRejection("quota", quota.resetsAt)?.health,
      } : {}),
    });
  }
  // API keys and custom providers that reach bot chats (C22): the person's own, then teammates' shared ones.
  const keyLabel = (key: (typeof keys)[number]) => [key.name, key.last4 ? `····${key.last4}` : null].filter(Boolean).join(" ") || key.provider;
  const keyOptions = (key: (typeof keys)[number]): BotModelMenuOption[] =>
    key.models.map((model) => ({ id: apiKeyOptionId(key.id, model), modelId: model, provider: key.provider, ...priceFor(model),
      ...(key.modelsError === "invalid" ? { health: modelRouteRejection("keyRefused")?.health } : {}),
      route: { source: "byok", connectionId: key.id, label: keyLabel(key) } }));
  const ownKeys = keys.filter((key) => key.mine);
  // Mikka 额度: every catalogue model, listed whenever the source is on; the balance is checked when a message is sent
  // (decision 2026-11-15-1900). A self-hosted server lists its LiteLLM default alias.
  const usable = enabled && (local || points > 0);
  const hostedSource = local ? "self-hosted" as const : undefined;
  const creditsOption = (model: { id: string; name?: string; pricing?: { input: number; output: number } | null }): BotModelMenuOption => ({
    id: creditsOptionId(model.id), modelId: model.id, provider: "mikka", ...(model.name ? { name: model.name } : {}),
    ...(model.pricing ? { price: { input: model.pricing.input, output: model.pricing.output } } : {}),
    ...(hostedSource ? { hostedSource } : {}),
    route: { source: "credits", connectionId: null, label: "" },
    ...(usable ? {} : { unavailable: { reason: "points" as const }, health: modelRouteRejection("balance")?.health }),
  });
  const groups = orderedRouteGroups([
    ...(catalogue.length ? [{ kind: "hosted" as const, ...(hostedSource ? { hostedSource } : { points }),
      options: catalogue.map((model) => creditsOption(model)) }] : []),
    ...subscriptions.values(),
    ...ownKeys.map((key) => ({ kind: "apiKey" as const, credentialLabel: keyLabel(key), options: keyOptions(key) })),
    ...keys.filter((key) => !key.mine && ownerNames.has(key.ownerId)).map((key) => ({
      kind: "shared" as const, owner: ownerNames.get(key.ownerId)!, credentialLabel: keyLabel(key), options: keyOptions(key),
    })),
  ]);
  const state = { chosen: choice.chosen, ...(choice.fallback ? { fallback: choice.fallback } : {}) };
  let current: BotModelCurrent;
  if (choice.kind === "none") {
    current = { ...NO_MODEL, ...state };
  } else if (choice.kind === "hosted") {
    const model = catalogue.find((item) => item.id === choice.model) ?? { id: choice.model };
    current = { ...creditsOption(model), kind: "hosted", ...state, available: usable, availability: usable ? "available" : "exhausted" };
  } else if (choice.kind === "apiKey") {
    current = {
      id: apiKeyOptionId(choice.key.id, choice.model), modelId: choice.model, provider: choice.key.provider,
      kind: choice.key.mine ? "apiKey" : "shared", ...state, available: true, availability: "available",
      credentialLabel: choice.key.mine ? keyLabel(choice.key) : [ownerNames.get(choice.key.ownerId), keyLabel(choice.key)].filter(Boolean).join(" · "),
      route: { source: "byok", connectionId: choice.key.id, label: keyLabel(choice.key) },
      ...(choice.quota ? { quota: choice.quota } : {}),
    };
  } else {
    const binding = choice.binding;
    const option = rows.find(item => item.connectionId === binding.connectionId && item.modelId === binding.modelId);
    const availability = subscriptionAvailability(binding.quota, binding.modelId, binding.provider === "codex" ? "codex" : "claude", now);
    current = {
      id: option?.bindingId ?? binding.bindingId, modelId: binding.modelId, provider: binding.provider,
      kind: "subscription", ...state, available: availability.status === "available", availability: availability.status,
      credentialLabel: binding.accountLabel?.trim() || `…${String(binding.connectionId).slice(-6)}`,
      route: { source: "subscription", connectionId: String(binding.connectionId), label: binding.accountLabel?.trim() || `…${String(binding.connectionId).slice(-6)}`, service: binding.provider },
      ...(availability.status === "exhausted" ? {
        unavailable: { reason: "quota" as const, resetsAt: availability.resetsAt },
        health: modelRouteRejection("quota", availability.resetsAt)?.health,
      } : {}),
      ...(choice.quota ? { quota: choice.quota } : {}),
    };
  }
  // Every option says what it can be asked for on its route, from the provider's own catalogue (decision 2026-11-25-1700).
  const capabilityOf = await (await import("./model-capabilities-server")).modelCapabilityReader(pool,
    [...groups.flatMap(group => group.options), current].flatMap(option => option.route?.source === "subscription" && option.route.connectionId ? [option.route.connectionId] : []));
  const keyById = new Map(keys.map(key => [key.id, key]));
  const withCapabilities = <T extends BotModelMenuOption>(option: T): T => {
    if (!option.modelId || !option.route) return option;
    const route = option.route;
    const key = route.source === "byok" && route.connectionId ? keyById.get(route.connectionId) : undefined;
    const modelKey = modelKeyOf(option.modelId, option.provider, key?.name || route.label);
    const display = modelDisplayName(modelKey);
    const name = display.family ? display.name : (catalogue.find(item => item.id === modelKey)?.name ?? display.name);
    const kind = route.source === "subscription" ? "plan" : route.source === "byok" ? "key" : "credits";
    return { ...option, modelKey, entryId: pickerRouteKey(option), name, route: { ...route, kind }, capabilities: route.source === "credits"
      ? capabilityOf({ source: "credits", modelId: option.modelId })
      : route.source === "subscription" && route.connectionId
        ? capabilityOf({ source: "subscription", connectionId: route.connectionId, provider: option.provider, modelId: option.modelId })
        : capabilityOf({ source: "byok", provider: option.provider, modelId: option.modelId, responsesApi: key?.responsesApi,
          ...(key?.daybreak ? { daybreak: key.daybreak } : {}),
          ...(key?.modelSpeedModes && Object.hasOwn(key.modelSpeedModes, option.modelId) ? { advertisedSpeedModes: key.modelSpeedModes[option.modelId] } : {}) }) };
  };
  for (const group of groups) group.options = group.options.map(withCapabilities);
  current = withCapabilities(current);
  const models = groupModelOptions(groups);
  const modes = current.capabilities ? modesFor(current.capabilities, preference.chat.modes) : modesFromTier(null);
  const chat = { ...preference.chat, modes, effort: modes.pro ? null : preference.chat.effort };
  const savedKey = preference.key && keys.find(key => key.id === preference.key?.keyId && (key.mine || ownerNames.has(key.ownerId)));
  const unavailableSelection = choice.fallback === "preference" && preference.selected
    ? await subscriptionPickerHealth(pool, scope.ownerId, preference.selected)
    : savedKey?.modelsError === "invalid" ? modelRouteRejection("keyRefused")?.health : undefined;
  return { groups, models, preferredRoutes: {}, current, chat,
    ...(unavailableSelection ? { unavailableSelection } : {}),
    ...(inspectPreference ? { preferenceState: !preference.key && preference.selected === undefined ? "absent" as const : "present" as const } : {}) };
}

/** Read only known, owned subscription entries. Missing and foreign entries have the same response. */
async function subscriptionPickerHealth(pool: Pick<Pool, "query">, ownerId: string, id: string): Promise<ModelRouteHealth | undefined> {
  const stable = /^subscription:([^:]+):(.+)$/.exec(id);
  if (!z.uuid().safeParse(stable?.[1] ?? id).success) return;
  const { rows: [route] } = await pool.query<{ state: string; paused: boolean; settings: ModelSettings | null; modelId: string }>(
    `SELECT c.state,c.paused,to_jsonb(c)->'modelSettings' AS settings,b."modelId"
     FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId"
     WHERE b."ownerId"=$1 AND c."removedAt" IS NULL
       AND (($3::text IS NULL AND b.id=$2::uuid) OR (b."connectionId"=$2::uuid AND b."modelId"=$3)) LIMIT 1`,
    [ownerId, stable?.[1] ?? id, stable?.[2] ?? null]);
  if (!route) return;
  if (route.state === "reconnect_required") return modelRouteRejection("expired")?.health;
  if (route.paused || !modelEnabled(route.settings, route.modelId)) return modelRouteRejection("paused")?.health;
}

/**
 * Saves the chat's reasoning level and/or serving speed beside its model, for the Bot or the Coordinator (`botId`
 * null). A field left out keeps its value; null clears it (the model's default level; the workspace's speed).
 */
export async function setChatModelSettings(pool: Pick<Pool, "query">, scope: ExecutionSettingsScope, botId: string | null,
  change: { effort?: string | null; serviceTier?: string | null; modes?: ModelModes }, capabilities?: ModelCapabilities): Promise<void> {
  const { MODEL_ROUTING_EFFORTS, MODEL_SERVICE_TIERS } = await import("./model-routing");
  const hasModes = change.modes !== undefined;
  if (change.modes) {
    if (!supportedModes(capabilities, change.modes) || (change.serviceTier != null && change.serviceTier !== tierForModes(change.modes)))
      throw new ActionFailureError("validationGeneric");
    change = { ...change, serviceTier: change.serviceTier === null && !change.modes.fast && !change.modes.ultrafast ? null : tierForModes(change.modes), ...(change.modes.pro ? { effort: null } : {}) };
  }
  if (!change.modes && capabilities && change.serviceTier != null && !supportedModes(capabilities, modesFromTier(change.serviceTier)))
    throw new ActionFailureError("validationGeneric");
  if (change.effort != null && !MODEL_ROUTING_EFFORTS.some(level => level === change.effort)) throw new ActionFailureError("validationGeneric");
  if (change.serviceTier != null && !MODEL_SERVICE_TIERS.some(tier => tier === change.serviceTier)) throw new ActionFailureError("validationGeneric");
  if (botId !== null) {
    if (!z.uuid().safeParse(botId).success) throw new ActionFailureError("botNotFound");
    const { rowCount } = await pool.query('SELECT 1 FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "archivedAt" IS NULL', [botId, scope.ownerId, scope.workspaceId]);
    if (!rowCount) throw new ActionFailureError("botNotFound");
  }
  const effort = change.effort !== undefined, tier = change.serviceTier !== undefined;
  if (!effort && !tier && !hasModes) return;
  await pool.query(`INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey",effort,"serviceTier",pro,daybreak) VALUES ($1,$2,$3,$4,$5,$8,$11)
    ON CONFLICT ("ownerId","workspaceId","botKey") DO UPDATE SET
      effort = CASE WHEN (NOT $7 AND bot_model_choices.pro AND $9) THEN NULL WHEN $6 THEN EXCLUDED.effort ELSE bot_model_choices.effort END,
      pro = CASE WHEN $7 THEN EXCLUDED.pro ELSE bot_model_choices.pro AND $9 END,
      daybreak = CASE WHEN $10 THEN EXCLUDED.daybreak ELSE bot_model_choices.daybreak AND $12 END,
      "serviceTier" = CASE WHEN $7 THEN EXCLUDED."serviceTier" ELSE bot_model_choices."serviceTier" END`,
    [scope.ownerId, scope.workspaceId, botId ?? "coordinator", change.effort ?? null, change.serviceTier ?? null, effort, tier, change.modes?.pro === true, capabilities === undefined || capabilities.pro === true, hasModes, change.modes?.daybreak === true, capabilities === undefined || capabilities.daybreak !== undefined]);
}

/** Validate the device's route choice. Legacy callers receive the validated choice in this response only. */
export async function setPreferredRoute(pool: Pool, settings: ExecutionSettings, scope: ExecutionSettingsScope,
  botId: string | null, modelKey: string, optionId: string): Promise<BotModelMenu> {
  const menu = await botModelMenu(pool, settings, scope, botId);
  const route = menu.models?.find(model => model.key === modelKey)?.routes.find(option => option.id === optionId || option.entryId === optionId);
  if (!route)
    throw new ActionFailureError("executionModelUnknown");
  return { ...menu, preferredRoutes: { [modelKey]: route.id } };
}

/** Active members' public names for shared API keys. Never the credential. */
async function memberNames(workspaceId: string, userIds: string[]) {
  const [{ workspaceDb }, { workspaceMembers }, { and, eq, inArray }] = await Promise.all([
    import("./workspace-db"), import("./db/workspace-schema"), import("drizzle-orm"),
  ]);
  const rows = await workspaceDb.select({ userId: workspaceMembers.userId, name: workspaceMembers.name }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, userIds), eq(workspaceMembers.status, "active")));
  return new Map(rows.map((row) => [row.userId, row.name]));
}

/**
 * 刷新模型列表: asks each connected subscription for its current models
 * (`refreshBotModels`), then reads the menu again, so a new subscription, a
 * renewed quota or a new model shows at once. A provider that does not answer
 * in time keeps its last catalogue; the menu is still re-read.
 */
export async function refreshBotModelMenu(
  pool: Pick<Pool, "query">,
  settings: Pick<ExecutionSettings, "botModels" | "chatModels" | "chatBinding" | "refreshBotModels" | "connectedSubscriptions">,
  scope: ExecutionSettingsScope,
  botId: string | null,
  timeoutMs = 8000,
  refreshQuota: (ownerId: string, connectionId: string, signal: AbortSignal) => Promise<unknown> = async (ownerId, connectionId, signal) =>
    (await import("./subscription-runtime")).subscriptionRuntime().usage(ownerId, connectionId, signal),
  refreshKey: (ownerId: string, keyId: string) => Promise<unknown> = async (ownerId, keyId) =>
    (await import("./model-api-keys")).refreshApiKeyModels(pool, ownerId, keyId),
): Promise<BotModelMenu> {
  // Every connected subscription, not only those already listed: one never asked has no models to list yet.
  const connections = await settings.connectedSubscriptions(scope.ownerId);
  // The person's own keys list their models again (the provider's free /models read, #2938); a teammate's shared key is its owner's to refresh.
  const { rows: ownKeys } = await pool.query<{ id: string }>('SELECT id::text AS id FROM model_api_keys WHERE "ownerId"=$1', [scope.ownerId]);
  const timed = (work: Promise<unknown>) => Promise.race([work, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.())]);
  await Promise.allSettled([
    ...ownKeys.map((key) => timed(refreshKey(scope.ownerId, key.id))),
    ...connections.map((connectionId) =>
      Promise.race([
        // A catalogue read alone cannot confirm a stale allowance. The same
        // refresh checks usage, whose safe snapshot is persisted by the service.
        Promise.allSettled([
          settings.refreshBotModels(scope, connectionId),
          refreshQuota(scope.ownerId, connectionId, AbortSignal.timeout(timeoutMs)),
        ]),
        new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
      ]),
    ),
  ]);
  return botModelMenu(pool, settings, scope, botId);
}

/**
 * Saves a chat's model pick for the bot's next runs (a run already going keeps
 * its model) and returns the menu: a binding id, a Mikka 额度 model (`credits:<vendor/model>`), or
 * an API key model (`apikey:<keyId>:<model>`, saved as that key's choice). The
 * web's action and the iOS app's route both save through here, so every option
 * the menu lists can be picked from either.
 */
export async function chooseBotModel(
  pool: Pool,
  settings: ExecutionSettings,
  scope: ExecutionSettingsScope,
  botId: string | null,
  id: string,
): Promise<BotModelMenu> {
  if (id.startsWith("subscription:")) {
    const menu = await botModelMenu(pool, settings, scope, botId);
    const route = menu.models?.flatMap(model => model.routes).find(option => option.entryId === id);
    if (!route) {
      const health = await subscriptionPickerHealth(pool, scope.ownerId, id);
      if (health) throw new ModelRouteUnavailable(health);
      throw new ActionFailureError("executionModelUnknown");
    }
    id = route.id;
  }
  const { parseApiKeyOption } = await import("./bot-model-menu-view");
  const apiKey = parseApiKeyOption(id);
  if (apiKey) {
    const { setBotApiKeyChoice } = await import("./model-api-keys");
    const { WorkspaceError } = await import("./workspace-error");
    try {
      await setBotApiKeyChoice(pool, scope, botId, apiKey.keyId, apiKey.model);
    } catch (error) {
      if (error instanceof WorkspaceError) {
        const health = error.code === "apiKeyInvalid" ? modelRouteRejection("keyRefused")?.health : undefined;
        if (health) throw new ModelRouteUnavailable(health, { cause: error });
        throw new ActionFailureError(error.code === "botNotFound" ? "botNotFound" : "executionModelUnknown", undefined, undefined, { cause: error });
      }
      throw error;
    }
  } else {
    try {
      await settings.setBotModel(scope, botId, id);
    } catch (error) {
      if (error instanceof ActionFailureError && error.code === "executionModelUnknown") {
        const health = await subscriptionPickerHealth(pool, scope.ownerId, id);
        if (health) throw new ModelRouteUnavailable(health, { cause: error });
      }
      throw error;
    }
  }
  return botModelMenu(pool, settings, scope, botId);
}

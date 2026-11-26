import "server-only";
import { z } from "zod";
import { pool } from "./db";
import { ActionFailureError } from "./action-error";
import { botModelEffort } from "./bot-model-effort";
import { ExecutionSettings, executionWorkspace } from "./execution-settings";
import { botApiKeyChoice, usableApiKeys } from "./model-api-keys";
import { apiKeyServesBotModel, resolveBotModelChoice } from "./bot-model-choice";
import { MODEL_ROUTING_EFFORTS, MODEL_SERVICE_TIERS, type ModelRoutingEffort, type ModelServiceTier } from "./model-routing";
import {
  freezeHostedModelSelection,
  hostedApiKeySnapshotSchema,
  type HostedModelDependencies,
  type HostedModelScope,
  type HostedRuntimeSnapshot,
} from "./subscription-model-snapshot";

/** Runs inside the first reservation callback; replays keep their frozen choice. */
export async function freezeBotModel(
  scope: HostedModelScope,
  dependencies: HostedModelDependencies,
): Promise<HostedRuntimeSnapshot> {
  const workspaceId = scope.workspaceId ?? (await executionWorkspace(scope.ownerId, scope.botId));
  const { snapshot, fellBack } = await freezeBotModelChoice({ ...scope, workspaceId }, dependencies);
  // The Bot's reasoning effort and serving speed tier are frozen with the turn's model.
  const [botEffort, orderRow, chatTier] = await Promise.all([
    botModelEffort(pool, { ownerId: scope.ownerId, workspaceId }, scope.botId),
    pool
      ? pool.query<{ effort: string | null; tier: string | null }>(
          `SELECT to_jsonb(model_order_settings)->>'defaultEffort' AS effort,
                  to_jsonb(model_order_settings)->>'defaultServiceTier' AS tier
           FROM model_order_settings WHERE "ownerId"=$1 AND "workspaceId"=$2`,
          [scope.ownerId, workspaceId],
        ).then(result => result.rows[0] ?? null, () => null)
      : Promise.resolve(null),
    pool
      ? pool.query<{ tier: string | null; pro: boolean; daybreak: boolean }>(
          'SELECT "serviceTier" AS tier, pro, (to_jsonb(bot_model_choices)->\'daybreak\' = \'true\'::jsonb) AS daybreak FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3',
          [scope.ownerId, workspaceId, scope.botId ?? "coordinator"]).then(result => result.rows[0] ?? null, () => null)
      : Promise.resolve(null),
  ]);
  const workspaceEffort = MODEL_ROUTING_EFFORTS.find(item => item === orderRow?.effort);
  let effort: ModelRoutingEffort | undefined = botEffort ?? (workspaceEffort && workspaceEffort !== "medium" ? workspaceEffort : undefined);
  // The chat's own speed (bot_model_choices.serviceTier) comes before the workspace's default.
  const savedTier = MODEL_SERVICE_TIERS.find(item => item === chatTier?.tier) ?? MODEL_SERVICE_TIERS.find(item => item === orderRow?.tier);
  // A level the frozen model cannot take is left out (its default), checked against the provider's own catalogue
  // (lib/model-capabilities.ts), so a model the built-in list does not know still gets the level its provider lists.
  let pro = false;
  let cyberProgram: import("./model-capabilities").CyberAccessProgram | undefined;
  const allowDaybreak = !fellBack && chatTier?.daybreak === true;
  if ((effort || chatTier?.pro || allowDaybreak) && snapshot.model) {
    const capabilities = await frozenCapabilities(snapshot).catch(() => null);
    pro = chatTier?.pro === true && capabilities?.pro === true;
    if (pro || (effort && capabilities && !capabilities.efforts.includes(effort))) effort = undefined;
    if (allowDaybreak && snapshot.modelSelection && capabilities?.daybreak) {
      const { cyberAccessProgram } = await import("./model-capabilities");
      cyberProgram = cyberAccessProgram(capabilities.daybreak);
    }
  }
  let serviceTier: ModelServiceTier | undefined = savedTier;
  if (!snapshot.modelSelection && snapshot.model && (savedTier === "fast" || savedTier === "ultrafast")) {
    // Verify Mikka Credits speed capability on the Node server before freezing (keeps Workflow VM free of model-order).
    const { creditsModelSpeedModes } = await import("./model-order");
    const supported = await creditsModelSpeedModes(snapshot.model);
    serviceTier = supported.includes(savedTier) ? savedTier : "standard";
  }
  return {
    ...snapshot,
    ...(effort ? { effort } : {}),
    ...(pro ? { pro: true as const } : serviceTier ? { serviceTier } : {}),
    ...(cyberProgram ? { cyberAccessProgram: cyberProgram } : {}),
  };
}

/** What the frozen model can be asked for on its route: Mikka 额度, a subscription or a key. */
async function frozenCapabilities(snapshot: HostedRuntimeSnapshot) {
  const [{ modelCapabilityReader }, { parseDaybreakAccess }] = await Promise.all([
    import("./model-capabilities-server"),
    import("./model-capabilities"),
  ]);
  const selection = snapshot.modelSelection;
  if (!selection) return (await modelCapabilityReader(pool, []))({ source: "credits", modelId: snapshot.model! });
  if (selection.type === "subscription") {
    return (await modelCapabilityReader(pool, [selection.connectionId]))({ source: "subscription", connectionId: selection.connectionId,
      provider: selection.route === "claude_cpa" ? "claude" : "codex", modelId: selection.modelId });
  }
  const { rows: [key] } = await pool.query<{ provider: string; responsesApi: boolean; daybreak: unknown }>(
    'SELECT provider,"responsesApi",to_jsonb(model_api_keys)->\'daybreak\' AS daybreak FROM model_api_keys WHERE id=$1',
    [selection.keyId],
  );
  return (await modelCapabilityReader(pool, []))({
    source: "byok",
    provider: key?.provider ?? "custom",
    modelId: selection.modelId,
    responsesApi: key?.responsesApi,
    daybreak: parseDaybreakAccess(key?.daybreak),
  });
}

async function freezeBotModelChoice(
  scope: HostedModelScope,
  dependencies: HostedModelDependencies,
): Promise<{ snapshot: HostedRuntimeSnapshot; fellBack: boolean }> {
  const workspaceId =
    scope.workspaceId ?? (await executionWorkspace(scope.ownerId, scope.botId));
  const settings = new ExecutionSettings(pool);
  // An archived bot (its owner left or was suspended) runs nothing until an admin takes it over (§8.3).
  if (scope.botId && !(await settings.botActive(scope.ownerId, scope.botId)))
    throw new ActionFailureError("botNotFound");
  const settingsScope = { ownerId: scope.ownerId, workspaceId };
  const keyChoice = await botApiKeyChoice(pool, settingsScope, scope.botId);
  const keys = await usableApiKeys(pool, scope.ownerId, workspaceId);
  // botModel creates the initial per-bot binding; a valid saved key keeps its
  // existing precedence and needs no subscription default written.
  const savedKey = keyChoice && keys.find(key => key.id === keyChoice.keyId && apiKeyServesBotModel(key, keyChoice.model));
  const selected = savedKey ? undefined : await settings.botModel(settingsScope, scope.botId);
  // A member's saved choice can still name an owner's subscription binding
  // (borrowed before owner-only, decision 2026-11-17): refuse the run as
  // theirs-not-yours, not an unselected model — menus keep their fallback
  // (issue #3057).
  if (selected && z.uuid().safeParse(selected).success
    && await settings.bindingHeldElsewhere(settingsScope, selected)) {
    const { SubscriptionRefusal } = await import("@mikka/protocol/subscription");
    throw new SubscriptionRefusal("account_unavailable");
  }
  const choice = await resolveBotModelChoice(pool, settings, settingsScope, scope.botId,
    { selected, key: keyChoice }, { keys });
  const fellBack = Boolean(choice.fallback);
  if (choice.kind === "hosted") return { snapshot: { harness: "ai_sdk", model: choice.model }, fellBack };
  // Nothing chosen and nothing to fall back to: the chat asks for a model first (decision 2026-11-15-1900).
  if (choice.kind === "none") throw new ActionFailureError("executionModelUnknown");
  if (choice.kind === "apiKey")
    return {
      fellBack,
      snapshot: {
        harness: "ai_sdk",
        model: choice.model,
        modelSelection: hostedApiKeySnapshotSchema.parse({
          ...(scope.botId === null ? { coordinator: true } : { consumerId: scope.botId }),
          type: "api_key", keyId: choice.key.id, ownerId: scope.ownerId, workspaceId, modelId: choice.model,
          ...(choice.fallback === "points" ? { afterPoints: true } : {}),
          ...(choice.quota ? { afterQuota: {
            subscription: choice.quota.subscription === "codex" ? "codex" : "claude",
            plan: choice.quota.plan,
            keyProvider: choice.key.provider,
            keyName: choice.key.name,
          } } : {}),
        }),
      },
    };
  const bindingId = await settings.bindingForBot(settingsScope, scope.botId, choice.binding.bindingId);
  const frozen = await freezeHostedModelSelection(
    { ...scope, workspaceId },
    { harness: "ai_sdk", model: null },
    { type: "subscription", bindingId },
    dependencies,
  );
  return {
    fellBack,
    snapshot: choice.fallback === "points" && frozen.modelSelection
      ? { ...frozen, modelSelection: { ...frozen.modelSelection, afterPoints: true } }
      : frozen,
  };
}

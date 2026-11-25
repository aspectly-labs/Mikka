/** Local-only DeepSeek setup. Provider keys stay in process memory. */
import type { Pool } from 'pg'
import type { OrderChange } from '@/lib/model-order'
import { entryKey, type OrderEntry, type OrderHarness } from '@/lib/model-order-plan'
import { assertFlashTestModel } from '../test-model-policy.mjs'

export const DEV_MODEL_PREFERENCE = [/v4\.1.*flash/i, /flash/i]
interface ModelKey { id: string; models: string[] }
export interface SeedDeps {
  owners(): Promise<{ ownerId: string; key?: ModelKey }[]>
  addKey(ownerId: string, apiKey: string): Promise<ModelKey>
  scopes(ownerId: string, keyId: string, model: string): Promise<{ workspaceId: string; botIds: (string | null)[] }[]>
  prefer(scope: { ownerId: string; workspaceId: string }, keyId: string, model: string): Promise<void>
  choose(scope: { ownerId: string; workspaceId: string }, botId: string | null, keyId: string, model: string): Promise<void>
}

/** The next production writer change that puts the local Flash API-key entry at
 * dispatch position zero. `bot_model_choices` is only Bot chat preference; this
 * action is the separate coding-run model-order preference. */
export function modelOrderSeedAction(order: { preferredHarness: OrderHarness; entries: Pick<OrderEntry, 'id' | 'harness' | 'model' | 'source'>[] }, keyId: string, model: string): OrderChange | null {
  const desired = { harness: order.preferredHarness, model, source: { kind: 'api_key' as const, keyId } }
  const key = entryKey(desired)
  if (order.entries[0] && entryKey(order.entries[0]) === key) return null
  const existing = order.entries.find(entry => entryKey(entry) === key)
  if (!existing) return { kind: 'add', entries: [desired], at: 0 }
  return { kind: 'reorder', ids: [existing.id, ...order.entries.filter(entry => entry.id !== existing.id).map(entry => entry.id)] }
}
export type SeedState = Map<string, { failures: number; retryAt: number }>
export function preferredModel(models: string[]): string | undefined {
  for (const pattern of DEV_MODEL_PREFERENCE) {
    const hit = models.find(model => {
      if (!pattern.test(model)) return false
      try { assertFlashTestModel(model); return true } catch { return false }
    })
    if (hit) return hit
  }
  return undefined
}

/** Failures are isolated and backed off; existing keys never refetch /models. */
export async function seedModelKeys(apiKey: string | undefined, deps: SeedDeps, log: (line: string) => void = () => {}, state: SeedState = new Map(), now = Date.now): Promise<number> {
  if (!apiKey) return 0
  let seeded = 0
  for (const { ownerId, key: existing } of await deps.owners()) {
    if ((state.get(ownerId)?.retryAt ?? 0) > now()) continue
    try {
      const key = existing ?? await deps.addKey(ownerId, apiKey)
      const model = preferredModel(key.models)
      if (!model) throw new Error('DS 4.1 Flash is not listed by the DeepSeek key')
      for (const scope of await deps.scopes(ownerId, key.id, model)) {
        await deps.prefer({ ownerId, workspaceId: scope.workspaceId }, key.id, model)
        for (const botId of scope.botIds) await deps.choose({ ownerId, workspaceId: scope.workspaceId }, botId, key.id, model)
      }
      state.delete(ownerId)
      if (!existing) { log(`seeded DeepSeek key for 1 account (model ${model})`); seeded++ }
    } catch {
      const failures = (state.get(ownerId)?.failures ?? 0) + 1
      const delay = Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4))
      state.set(ownerId, { failures, retryAt: now() + delay })
      // Provider exceptions can contain the key or request headers. Log no error body.
      log(`DeepSeek setup failed for 1 account; retry in ${delay / 1000}s`)
    }
  }
  return seeded
}

export async function productSeedDeps(pool: Pool): Promise<SeedDeps> {
  const { addApiKey, setBotApiKeyChoice } = await import('@/lib/model-api-keys')
  return {
    owners: async () => (await pool.query<{ ownerId: string; keyId: string | null; models: string[] | null }>(
      `SELECT u.id AS "ownerId", k.id AS "keyId", k.models FROM "user" u
       LEFT JOIN model_api_keys k ON k."ownerId" = u.id AND k.provider = 'deepseek'`)).rows.map(row => ({ ownerId: row.ownerId, ...(row.keyId ? { key: { id: row.keyId, models: row.models ?? [] } } : {}) })),
    addKey: async (ownerId, apiKey) => addApiKey(pool, ownerId, { provider: 'deepseek', apiKey }),
    scopes: async (ownerId, keyId, model) => {
      const [memberships, choices] = await Promise.all([
        pool.query<{ workspaceId: string; botId: string | null }>(
          `SELECT candidates."workspaceId"::text AS "workspaceId", candidates."botId"::text AS "botId" FROM (
             SELECT m."workspaceId", b.id AS "botId" FROM mikka_workspace_members m
             JOIN bots b ON b."workspaceId" = m."workspaceId" AND b."ownerId" = $1 WHERE m."userId" = $1
             UNION ALL SELECT m."workspaceId", NULL::uuid FROM mikka_workspace_members m WHERE m."userId" = $1
           ) candidates`, [ownerId]),
        pool.query<{ workspaceId: string; botKey: string; apiKeyId: string | null; apiKeyModel: string | null }>(
          'SELECT "workspaceId"::text AS "workspaceId","botKey","apiKeyId"::text AS "apiKeyId","apiKeyModel" FROM bot_model_choices WHERE "ownerId"=$1', [ownerId]),
      ])
      const chosen = new Map(choices.rows.map(row => [`${row.workspaceId} ${row.botKey}`, row]))
      const grouped = new Map<string, Set<string | null>>()
      for (const row of memberships.rows) {
        const bots = grouped.get(row.workspaceId) ?? new Set<string | null>()
        bots.add(row.botId)
        grouped.set(row.workspaceId, bots)
      }
      return [...grouped].map(([workspaceId, bots]) => ({
        workspaceId,
        botIds: [...bots].filter(botId => {
          const choice = chosen.get(`${workspaceId} ${botId ?? 'coordinator'}`)
          return choice?.apiKeyId !== keyId || choice?.apiKeyModel !== model
        }),
      }))
    },
    prefer: async (scope, keyId, model) => {
      const { changeOrder, readOrder } = await import('@/lib/model-order')
      const action = modelOrderSeedAction(await readOrder(pool, scope), keyId, model)
      if (action) await changeOrder(pool, scope, action)
    },
    choose: async (scope, botId, keyId, model) => { await setBotApiKeyChoice(pool, scope, botId, keyId, model) },
  }
}

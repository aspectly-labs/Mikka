import { sql } from 'drizzle-orm'
import type { db } from '@/lib/db'
import type { GatewayUsage } from './usage'

export interface ModelReceipt {
  messageId: string | null
  cost: number | null
  usage: (Omit<GatewayUsage, 'cacheReadTokens' | 'cacheWriteTokens'> & {
    cacheReadTokens: number | null
    cacheWriteTokens: number | null
  }) | null
  generationId?: string
}

export async function recordExternalModelUsage(query: Pick<typeof db, 'execute'>, receipt: ModelReceipt & {
  id: string
  workspaceId: string
  ownerId: string
  runId: string
  threadId: string | null
  model: string
  source: 'api_key' | 'subscription'
}) {
  await query.execute(sql`INSERT INTO hosted_usage (id,"workspaceId","usageWorkspaceId","executionOwnerId","actorId",
    "usageRunId","usageThreadId","usageMessageId",model,"billingSource",state,"costMicroUsd","inputTokens","outputTokens",
    "cacheReadTokens","cacheWriteTokens","generationId","settledAt")
    VALUES (${receipt.id},${receipt.workspaceId},${receipt.workspaceId},${receipt.ownerId},${receipt.ownerId},
      ${receipt.runId},${receipt.threadId},${receipt.messageId},${receipt.model},${receipt.source},'settled',
      ${receipt.cost},${receipt.usage?.inputTokens ?? 0},${receipt.usage?.outputTokens ?? 0},
      ${receipt.usage?.cacheReadTokens ?? null},${receipt.usage?.cacheWriteTokens ?? null},
      ${receipt.generationId ?? null},now())
    ON CONFLICT (id) DO NOTHING`)
}

/** Reserve a single external usage record without holding Mikka credits. */
export async function claimSubscriptionUsage(query: Pick<typeof db, 'execute'>, receipt: {
  id: string; workspaceId: string; ownerId: string; runId?: string; threadId: string | null; model: string; generationId?: string
}) {
  const result = await query.execute(sql`INSERT INTO hosted_usage (id,"workspaceId","usageWorkspaceId","executionOwnerId","actorId",
    "usageRunId","usageThreadId",model,"billingSource",state,"generationId") VALUES (${receipt.id},${receipt.workspaceId},
    ${receipt.workspaceId},${receipt.ownerId},${receipt.ownerId},${receipt.runId ?? null},${receipt.threadId},${receipt.model},'subscription','unknown',${receipt.generationId ?? null})
    ON CONFLICT (id) DO NOTHING RETURNING id`)
  return result.rows.length === 1
}

export async function linkSubscriptionChatGatewayCall(query: Pick<typeof db, 'execute'>, id: string, generationId: string) {
  await query.execute(sql`UPDATE hosted_usage SET "generationId"=${generationId}
    WHERE id=${id} AND "billingSource"='subscription' AND "generationId" IS NULL`)
}

export async function finishSubscriptionUsage(query: Pick<typeof db, 'execute'>, id: string, receipt: ModelReceipt, complete: boolean) {
  await query.execute(sql`UPDATE hosted_usage SET state=${complete ? 'settled' : 'unknown'},
    "usageMessageId"=${receipt.messageId},"costMicroUsd"=${receipt.cost},"inputTokens"=${receipt.usage?.inputTokens ?? 0},
    "outputTokens"=${receipt.usage?.outputTokens ?? 0},"cacheReadTokens"=${receipt.usage?.cacheReadTokens ?? null},
    "cacheWriteTokens"=${receipt.usage?.cacheWriteTokens ?? null},"settledAt"=now()
    WHERE id=${id} AND "billingSource"='subscription' AND state='unknown'`)
}

import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { DEFAULT_REVIEW_RULE, reviewRule } from '@mikka/protocol/orchestrator'
import { db } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceListChanged } from '@/lib/live/lists'
import type { WorkspaceActor } from '@/lib/workspace-admin/current'
import {
  deleteWorkspaceReviewRuleInput,
  saveWorkspaceReviewRuleInput,
  type WorkspaceReviewRulesView,
} from './contract'
import { workspaceReviewRules } from './schema'

type Reader = Pick<typeof db, 'select'>

async function readReviewRulesView(workspaceId: string, database: Reader = db): Promise<WorkspaceReviewRulesView> {
  const rows = await database
    .select()
    .from(workspaceReviewRules)
    .where(eq(workspaceReviewRules.workspaceId, workspaceId))
    .orderBy(asc(workspaceReviewRules.repoKey))

  const defaultRow = rows.find(row => row.repoKey === '')
  const overrides = rows
    .filter(row => row.repoKey !== '')
    .map(row => ({
      repoKey: row.repoKey,
      rule: reviewRule({
        requirePullRequest: row.requirePullRequest,
        requireCi: row.requireCi,
        checkHarness: row.checkHarness,
        branchTemplate: row.branchTemplate,
        prBodyTemplate: row.prBodyTemplate,
      }),
      source: 'repository' as const,
      updatedAt: row.updatedAt.toISOString(),
    }))

  return {
    workspaceId,
    rule: defaultRow
      ? {
          value: reviewRule({
            requirePullRequest: defaultRow.requirePullRequest,
            requireCi: defaultRow.requireCi,
            checkHarness: defaultRow.checkHarness,
            branchTemplate: defaultRow.branchTemplate,
            prBodyTemplate: defaultRow.prBodyTemplate,
          }),
          source: 'workspace',
          updatedAt: defaultRow.updatedAt.toISOString(),
        }
      : {
          value: DEFAULT_REVIEW_RULE,
          source: 'default',
          updatedAt: null,
        },
    overrides,
  }
}

export async function readWorkspaceReviewRules(actor: Pick<WorkspaceActor, 'userId' | 'workspaceId'>): Promise<WorkspaceReviewRulesView> {
  return workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, actor.workspaceId, actor.userId)
    return readReviewRulesView(actor.workspaceId, db)
  })
}

export async function writeWorkspaceReviewRule(actor: Pick<WorkspaceActor, 'userId' | 'workspaceId' | 'role'>, raw: unknown): Promise<WorkspaceReviewRulesView> {
  if (actor.role !== 'admin') throw new WorkspaceError('workspaceAccessDenied')
  const parsed = saveWorkspaceReviewRuleInput.parse(raw)
  return workspaceDb.transaction(async workspaceTx => {
    await requireWorkspace(workspaceTx, actor.workspaceId, actor.userId, true)
    const result = await db.transaction(async tx => {
      const updated = {
        requirePullRequest: parsed.rule.requirePullRequest,
        requireCi: parsed.rule.requireCi,
        checkHarness: parsed.rule.checkHarness,
        branchTemplate: parsed.rule.branchTemplate,
        prBodyTemplate: parsed.rule.prBodyTemplate ?? null,
        updatedAt: new Date(),
      }
      await tx
        .insert(workspaceReviewRules)
        .values({
          workspaceId: actor.workspaceId,
          repoKey: parsed.repoKey,
          ...updated,
        })
        .onConflictDoUpdate({
          target: [workspaceReviewRules.workspaceId, workspaceReviewRules.repoKey],
          set: updated,
        })
      return readReviewRulesView(actor.workspaceId, tx)
    })
    await workspaceListChanged(workspaceTx, actor.workspaceId, ['workspace_settings'])
    return result
  })
}

export async function removeWorkspaceReviewRule(actor: Pick<WorkspaceActor, 'userId' | 'workspaceId' | 'role'>, raw?: unknown): Promise<WorkspaceReviewRulesView> {
  if (actor.role !== 'admin') throw new WorkspaceError('workspaceAccessDenied')
  const parsed = deleteWorkspaceReviewRuleInput.parse(raw === undefined ? {} : raw)
  return workspaceDb.transaction(async workspaceTx => {
    await requireWorkspace(workspaceTx, actor.workspaceId, actor.userId, true)
    const result = await db.transaction(async tx => {
      await tx
        .delete(workspaceReviewRules)
        .where(
          and(
            eq(workspaceReviewRules.workspaceId, actor.workspaceId),
            eq(workspaceReviewRules.repoKey, parsed.repoKey),
          ),
        )
      return readReviewRulesView(actor.workspaceId, tx)
    })
    await workspaceListChanged(workspaceTx, actor.workspaceId, ['workspace_settings'])
    return result
  })
}

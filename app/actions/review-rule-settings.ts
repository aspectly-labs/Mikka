'use server'

import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { settingsWorkspaceAction } from '@/lib/workspace-admin/settings-action'
import { readWorkspaceReviewRules, removeWorkspaceReviewRule, writeWorkspaceReviewRule } from '@/lib/review-rules/store'

export async function getWorkspaceReviewRules(workspaceId: string) {
  return settingsWorkspaceAction(async () => readWorkspaceReviewRules(await currentWorkspaceActor(workspaceId)))
}

export async function saveWorkspaceReviewRule(workspaceId: string, raw: unknown) {
  return settingsWorkspaceAction(async () => writeWorkspaceReviewRule(await currentWorkspaceActor(workspaceId), raw))
}

export async function deleteWorkspaceReviewRule(workspaceId: string, raw?: unknown) {
  return settingsWorkspaceAction(async () => removeWorkspaceReviewRule(await currentWorkspaceActor(workspaceId), raw))
}

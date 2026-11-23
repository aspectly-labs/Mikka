'use server'

import { requireUser } from '@/lib/issue-access'
import { withFreshSession } from '@/lib/fresh-session'
import { settingsWorkspaceAction } from '@/lib/workspace-admin/settings-action'
import { readEnvironmentInstructions, saveEnvironmentInstructions } from '@/lib/project-resources/store'
import { readBotInstructions, saveBotInstructions } from '@/lib/bot-instructions-store'
import { readInstructionContextPreview, type InstructionPreviewInput } from '@/lib/settings/instruction-preview'

export async function getEnvironmentInstructions(workspaceId: string, environmentId: string) {
  return settingsWorkspaceAction(async () => readEnvironmentInstructions(await requireUser(), { workspaceId, environmentId }))
}

export async function updateEnvironmentInstructions(input: { workspaceId: string; environmentId: string; instructions: string; revision?: number }) {
  return withFreshSession(() => settingsWorkspaceAction(async () => saveEnvironmentInstructions(await requireUser(), input)))
}

export async function getBotInstructions(botId: string, workspaceId?: string) {
  return settingsWorkspaceAction(async () => readBotInstructions(await requireUser(), botId, workspaceId))
}

export async function updateBotInstructions(input: { botId: string; instructions: string; workspaceId?: string }) {
  return withFreshSession(() => settingsWorkspaceAction(async () => saveBotInstructions(await requireUser(), input)))
}

export async function getInstructionPreview(input?: InstructionPreviewInput) {
  return settingsWorkspaceAction(async () => readInstructionContextPreview(await requireUser(), input))
}

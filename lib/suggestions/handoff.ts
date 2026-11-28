import 'server-only'
import { z } from 'zod'
import { afterJob } from '@/lib/background'
import { ActionFailureError } from '@/lib/action-error'
import { db } from '@/lib/db'
import {
  personalSubmissionRecorded,
  recordPersonalSubmission,
  SubmissionConflictError,
} from '@/lib/coordinator-submission'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'
import { suggestionInboxChanged } from '@/lib/inbox/live'
import { suggestionMessage } from './card'
import { claimSuggestion, readClaimedSuggestion } from './store'

/**
 * Single owning writer for handing a suggestion to the person's Coordinator chat.
 * Used by both the web server action (`app/actions/coordinator.ts:sendSuggestion`)
 * and the mobile REST API (`POST /api/mobile/suggestions/:id`).
 */
export async function handoffSuggestionToCoordinator(
  userId: string,
  suggestionId: string,
): Promise<{ queued: true }> {
  const id = z.uuid().safeParse(suggestionId)
  if (!id.success) throw new ActionFailureError('validationGeneric')
  try {
    await db.transaction(async tx => {
      const claimed = await claimSuggestion(userId, id.data, tx)
      const item = claimed ?? (await readClaimedSuggestion(userId, id.data, tx))
      if (!item) throw new ActionFailureError('suggestionNotFound')
      if (!(await coordinatorEnabled(userId, item.botId))) {
        throw new ActionFailureError('coordinatorUnavailable')
      }
      const text = suggestionMessage({
        source: item.source,
        action: item.action,
        title: item.title,
        actionTitle: item.actionTitle,
        actor: item.actor,
        url: item.url,
      })
      // The suggestion stored its Coordinator bot row when it was made (null only on an older one).
      if (claimed) await recordPersonalSubmission(tx, userId, text, { submissionId: item.id, botId: item.botId })
      else if (!(await personalSubmissionRecorded(tx, userId, text, item.id, item.botId))) {
        throw new ActionFailureError('suggestionNotFound')
      }
      if (claimed) await suggestionInboxChanged(tx, userId, item.botId)
    })
  } catch (error) {
    if (error instanceof SubmissionConflictError) {
      throw Object.assign(new ActionFailureError('submissionConflict'), { cause: error })
    }
    throw error
  }
  afterJob('after:coordinator-wake', () => wakeCoordinator(userId))
  return { queued: true }
}

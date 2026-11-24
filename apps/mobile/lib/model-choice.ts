import { mobileMessages } from './messages'

const C = mobileMessages.MobileCore.modelChoice

/** Why a model pick did not save, by the PUT /api/mobile/model error code (Figma 843:2 #3). */
export function choiceFailureReason(code: string | null): string {
  switch (code) {
    case 'modelUnavailable': return C.modelUnavailable
    case 'botNotFound': return C.botNotFound
    case 'invalidModel': case 'originNotAllowed': return C.updateApp
    default: return mobileMessages.MobileCore.unreachable
  }
}

/** 「没换成 claude-sonnet-5-5：这个模型现在不可用」 */
export const choiceFailureLine = (name: string, code: string | null) => C.failed.replace('{reason}', choiceFailureReason(code)).replace('{name}', () => name)

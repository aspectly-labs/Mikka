import { createDictationPostRoute } from '@/lib/dictation-route'

export const maxDuration = 120

/**
 * Chat composer voice dictation (#3333): transcribes recorded audio into text
 * for coding threads and Bot chats, reusing the same provider and limits as
 * `/api/tasks/dictation`.
 */
export const POST = createDictationPostRoute('/api/chat/dictation', 'chatDictationFailed')

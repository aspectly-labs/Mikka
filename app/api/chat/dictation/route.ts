import { dictationFailure, handleDictationPost } from '@/lib/dictation-route'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 120

/**
 * Chat composer voice dictation (#3333): transcribes recorded audio into text
 * for coding threads and Bot chats, reusing the same provider and limits as
 * `/api/tasks/dictation`.
 */
export const POST = defineRoute(
  {
    route: '/api/chat/dictation',
    auth: 'session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped',
    onWorkspaceError: () => dictationFailure('notFound', 404),
  },
  ({ request, session }) => handleDictationPost(request, session, 'chatDictationFailed'),
)

import { dictationFailure, handleDictationPost } from '@/lib/dictation-route'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 120

/**
 * 新建任务's 语音 (Capy's dictation): the recorded audio becomes text for the description. It reuses chat transcription
 * (lib/chat-attachments/transcribe.ts), so it runs only on the person's own authorized OpenAI key and stores nothing.
 */
export const POST = defineRoute(
  {
    route: '/api/tasks/dictation',
    auth: 'session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped',
    onWorkspaceError: () => dictationFailure('notFound', 404),
  },
  ({ request, session }) => handleDictationPost(request, session, 'taskDictationFailed'),
)

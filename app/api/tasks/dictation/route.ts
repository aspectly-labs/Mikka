import { createDictationPostRoute } from '@/lib/dictation-route'

export const maxDuration = 120

/**
 * 新建任务's 语音 (Capy's dictation): the recorded audio becomes text for the description. It reuses chat transcription
 * (lib/chat-attachments/transcribe.ts), so it runs only on the person's own authorized OpenAI key and stores nothing.
 */
export const POST = createDictationPostRoute('/api/tasks/dictation', 'taskDictationFailed')

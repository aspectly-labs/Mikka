'use client'

import useSWR, { unstable_serialize } from 'swr'
import { readBotChatUploads, readThreadMachineMetrics, readThreadWorkspace } from '@/app/actions/task-runs'
import { useLiveKey } from './use-live-key'

export const threadWorkspaceKey = (runId: string) => ['thread-workspace', runId] as const

/**
 * A thread's machine workspace (readThreadWorkspace, #2940): its checkout, machine, Environment and uploads. A change to
 * the thread's runs (a new attempt, the machine's state, a file sent) wakes its `run` live key, so it follows without a
 * timer. `error` keeps the refusal's code (runNotFound) for the tab to say why it has nothing.
 */
export function useThreadWorkspace(runId: string | null) {
  const key = runId ? threadWorkspaceKey(runId) : null
  const read = useSWR(key, () => readThreadWorkspace(runId!), { revalidateOnFocus: false, shouldRetryOnError: false })
  useLiveKey('run', runId, key ? [unstable_serialize(key)] : [])
  const data = read.data && !('error' in read.data) ? read.data : null
  const refused = read.data && 'error' in read.data ? read.data.error : null
  return { data, refused, error: read.error as unknown, loading: read.isLoading, retry: () => { void read.mutate() } }
}

/** The live sandbox's latest recorded load, read once when the Setup tab opens and again when the run changes. */
export function useThreadMachineMetrics(runId: string | null, running: boolean) {
  const key = runId && running ? ['thread-machine-metrics', runId] as const : null
  const read = useSWR(key, () => readThreadMachineMetrics(runId!), { revalidateOnFocus: false, shouldRetryOnError: false })
  useLiveKey('run', key ? runId : null, key ? [unstable_serialize(key)] : [])
  return read.data ?? null
}

/** What the person sent in their chat with a Bot, for the Files tab's Uploads view. */
export function useBotChatUploads(botId: string | null) {
  const key = botId ? ['bot-chat-uploads', botId] as const : null
  const read = useSWR(key, () => readBotChatUploads(botId!), { revalidateOnFocus: false, shouldRetryOnError: false })
  useLiveKey('bot_chat', botId, key ? [unstable_serialize(key)] : [])
  return { data: read.data && !('error' in read.data) ? read.data : null, loading: read.isLoading, error: read.error as unknown, retry: () => { void read.mutate() } }
}

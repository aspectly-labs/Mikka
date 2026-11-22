'use client'

import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import type { IssueThreadDetail } from '@/app/actions/agents'
import { mergeThreadChunks } from '@/lib/issue-run-conversation'
import { primeFold } from '@/lib/conversation/folded'

/** The conversation layer's key for a thread (lib/conversation). */
export const threadConversationKey = (runId: string) => `thread:${runId}`

export function useIssueThreadRead(issueId: string | null, runId: string | null) {
  const { cache } = useSWRConfig()
  return useSWR(runId ? ['issue-thread', issueId, runId] as const : null, async key => {
    const [, issue, run] = key
    const held = cache.get(unstable_serialize(key))?.data as IssueThreadDetail | undefined
    const page = held?.historyPage
    const { getIssueThread } = await import('@/app/actions/agents')
    const read = await getIssueThread(issue, run, held?.chunkCursor ?? {
      kind: 'history',
      ...(page?.latest ? { after: { chain: page.chain, count: page.count, position: page.latest } } : {}),
    })
    // The read is folded before it is shown, by the same fold the server reads with (lib/conversation/fold.ts).
    if (!page || !read.historyPage?.append || !held) {
      const next = mergeThreadChunks(held, read)
      await primeFold(threadConversationKey(run), next.chunks)
      return next
    }
    const { messageUpdates, ...merged } = mergeThreadChunks(held, { ...read, chunksAppend: true })
    const updated = new Map(messageUpdates?.map(message => [message.id, message]))
    await primeFold(threadConversationKey(run), merged.chunks)
    return {
      ...merged,
      chunksAppend: false,
      messages: [...held.messages.map(message => updated.get(message.id) ?? message), ...read.messages],
      historyPage: { ...read.historyPage, before: page.before },
    }
  }, { revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false })
}

import type { GatewayProtocol } from './usage'

const MAX_RECEIPT_BYTES = 16 * 1024 * 1024

/**
 * Collects the lines that report usage as the response streams through, so the
 * whole body is never held in memory.
 */
export function usageTap(streaming: boolean, onDone: (text: string, complete: boolean) => Promise<void>, nativeProtocol?: GatewayProtocol) {
  const decoder = new TextDecoder()
  let partial = '', kept = '', terminal = false
  let settlement: Promise<void> | undefined
  const keep = (line: string) => {
    if (kept.length < MAX_RECEIPT_BYTES && (!streaming || line.includes('usage') || line.includes('message_start') || line.includes('response.created'))) kept += line + '\n'
    if (nativeProtocol && line.startsWith('data:') && /"(?:message_stop|response\.completed|response\.incomplete)"/.test(line)) {
      try {
        const { type } = JSON.parse(line.slice(5))
        terminal ||= nativeProtocol === 'anthropic' ? type === 'message_stop' : type === 'response.completed' || type === 'response.incomplete'
      } catch { /* An incomplete event cannot attest completion. */ }
    }
  }
  const finish = (flushed = false) => settlement ??= (async () => {
    keep(partial)
    await onDone(kept, flushed && (!streaming || terminal))
  })()
  return {
    finish,
    stream: new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
        const lines = (partial + decoder.decode(chunk, { stream: true })).split('\n')
        partial = lines.pop() ?? ''
        for (const line of lines) keep(line)
      },
      async flush() { await finish(true) },
    }),
  }
}

/** Finalize the same receipt if a returned body is cancelled or the upstream fails. */
export function observeUsageStream(source: ReadableStream<Uint8Array>, tap: ReturnType<typeof usageTap>, signal?: AbortSignal) {
  const reader = source.pipeThrough(tap.stream).getReader()
  let released = false
  const onAbort = () => {
    void tap.finish().catch(() => { console.warn('model_usage_receipt_unavailable') })
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  const release = () => {
    if (released) return
    released = true
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read()
        if (!part.done) controller.enqueue(part.value)
        else { release(); controller.close() }
      } catch (error) {
        try { await tap.finish() } finally { release() }
        controller.error(error)
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason) }
      finally { try { await tap.finish() } finally { release() } }
    },
  })
}

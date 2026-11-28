import { SearchProviderError, type SearchOptions, type ScrapeResult } from './types'
import { webUrlSchema } from './url-schema'

export async function fetchPublicPage(url: string, options?: SearchOptions): Promise<ScrapeResult> {
  const target = webUrlSchema.parse(url)
  // Eve 1.3.0 pins DNS results through a Node Undici dispatcher. Fetch
  // implementations that ignore the dispatcher cannot enforce that policy.
  if (typeof process === 'undefined' || !process.versions?.node || globalThis.navigator?.userAgent === 'Cloudflare-Workers')
    throw new SearchProviderError('upstream_error', 'Eve web fetch requires Node networking')
  const { fetchPublicWebPage } = await import('eve/tools/web_fetch')
  try {
    const result = await fetchPublicWebPage({ url: target, format: 'markdown' }, {
      abortSignal: options?.signal, rejectRedirects: true, rejectHttpErrors: true,
    })
    return { url: result.url, markdown: result.content }
  } catch (cause) {
    if (cause instanceof Error && 'status' in cause)
      throw Object.assign(new SearchProviderError(cause.status === 429 ? 'rate_limited' : 'upstream_error', 'Eve web fetch failed'), { cause })
    throw cause
  }
}

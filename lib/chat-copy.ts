import { extractLegacyOpenUIText } from './legacy-chat-content'

/**
 * What 复制 on a reply copies: its Markdown as written. Historical stored
 * OpenUI replies are copied as their readable prose and words instead of the
 * legacy card source.
 */
export function replyCopyText(text: string): string {
  const legacy = extractLegacyOpenUIText(text)
  return legacy === null ? text.trim() : legacy
}

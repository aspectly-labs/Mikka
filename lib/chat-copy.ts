import { extractLegacyOpenUIMarkdown } from './legacy-chat-content'

/**
 * What 复制 on a reply copies: its Markdown as written. Historical stored
 * OpenUI replies are copied as their readable Markdown (preserving full
 * multiline code blocks, tables, lists, and option descriptions) instead of
 * the legacy card source.
 */
export function replyCopyText(text: string): string {
  const legacy = extractLegacyOpenUIMarkdown(text)
  return legacy === null ? text.trim() : legacy
}

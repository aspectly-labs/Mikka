/**
 * A thread's or task's title as a list row shows it (Alex 2026-11-06): without a leading issue key (ALEX-12, #1408,
 * [MIK-3]) and without a trailing date or time stamp (2026-11-06, 11/06 03:12, 20261106-0312). The stored title
 * stays as it is; a title that would be left empty keeps its original text. Machine ids are not shown either (Alex
 * 2026-11-24): a UUID, or a hash such as c3f72167 (6 to 40 hex characters with a letter and a digit), anywhere in it.
 */
const LEADING_KEY = /^\s*(?:\[\s*)?(?:[A-Za-z][A-Za-z0-9]*-\d+|#\d+)(?:\s*\])?\s*[:：\-–—·|]?\s*/
const TRAILING_STAMP = new RegExp(
  '(?:^|\\s+|\\s*[-–—·|,，(（\\[]\\s*)' +
  '(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)?' +
  '|(?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\\d|3[01])(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?' +
  '|\\d{1,2}:\\d{2}(?::\\d{2})?' +
  '|\\d{8}(?:[-_T]?\\d{4,6})?)' +
  '(?:\\s*(?:UTC|GMT|Z))?\\s*[)）\\]]?\\s*$')

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const HASH = /(^|[\s\-_·:：(（\[])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,40}(?=$|[\s\-_·:：)）\],，])/gi

/** The text without UUIDs and hashes, and without the separators they leave behind. */
export function withoutMachineIds(raw: string): string {
  return raw.replace(UUID, ' ').replace(HASH, (_, before: string) => /[-_]/.test(before) ? ' ' : `${before} `)
    .replace(/\s*[-_·:：]\s*(?=[-_·:：]|$)/g, '')
    .replace(/^\s*[-_·:：]\s*/, '')
    .replace(/[(（]\s*[)）]/g, '')
    .replace(/\s{2,}/g, ' ').trim()
}

export function displayTitle(raw: string): string {
  let title = withoutMachineIds(raw.trim())
  for (let i = 0; i < 2; i++) title = title.replace(LEADING_KEY, '')
  for (let i = 0; i < 2; i++) title = title.replace(TRAILING_STAMP, '')
  title = title.trim()
  return title || raw.trim()
}

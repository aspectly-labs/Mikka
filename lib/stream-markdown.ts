import { withoutPartialCitation } from '@/lib/coordinator/citations'

/**
 * What a streaming reply's Markdown hides at its very end until it can draw, as handlers for remend (the pass
 * @lobehub/streamdown runs on the open tail before parsing). remend already closes an open `**`, `` ` ``, link or code
 * fence; these add Mikka's two cases. Both only ever cut the end of the text, so nothing is reordered, and stored text
 * never goes through them.
 */

/** A line of a pipe table: it starts with `|`, after at most three spaces. */
const PIPE_ROW = /^ {0,3}\|/
const DELIMITER_CELL = /^\s*:?-+:?\s*$/
const FENCE = /^ {0,3}(?:```|~~~)/

const cellsOf = (line: string) => {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  return row.split(/(?<!\\)\|/)
}

/**
 * A pipe table whose header has arrived but whose delimiter row (`| --- | --- |`) has not, cut off: until then
 * Markdown reads it as a paragraph and would show its pipes. Once the delimiter row has as many cells as the header,
 * the table draws, and its rows follow as they arrive.
 */
export function withoutPartialTable(text: string): string {
  const lines = text.split('\n')
  // Inside an open code fence a pipe is code.
  if (lines.filter(line => FENCE.test(line)).length % 2 === 1) return text
  // A header row whose line has ended but whose next line has not begun is still the end.
  const end = lines.at(-1) === '' ? lines.length - 1 : lines.length
  let start = end
  while (start > 0 && PIPE_ROW.test(lines[start - 1])) start--
  if (start === end) return text
  const [header, delimiter] = lines.slice(start, end)
  if (delimiter !== undefined) {
    const cells = cellsOf(delimiter)
    if (cells.length === cellsOf(header).length && cells.every(cell => DELIMITER_CELL.test(cell))) return text
  }
  return lines.slice(0, start).join('\n')
}

/** remend's handlers for a streaming reply; they run before its own (lower priority first), so a cut marker is never completed as a link. */
export const STREAM_TAIL_HANDLERS = [
  { name: 'mikka-partial-citation', priority: -10, handle: withoutPartialCitation },
  { name: 'mikka-partial-table', priority: -10, handle: withoutPartialTable },
] as const

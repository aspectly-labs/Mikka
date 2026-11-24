/**
 * A coding task's review on iPhone (#1738; decisions/2026-11-08-1230-coding-workspace.md, frames R2a, R2, R3, R3b),
 * as plain data over the shared contract (contract.ts, a copy of lib/code-review/contract.ts, #1741). review-api.ts is
 * the only file that calls the server.
 */
import type { ReviewCheck, ReviewComment, ReviewCommentSide, ReviewDenialReason, ReviewDiffSource, ReviewSummary } from './contract'
import { mobileMessages } from '@/lib/messages'

const C = mobileMessages.ReviewCopy
const V = mobileMessages.MobileCore.review
const count = (template: string, value: number) => template.replace('{count}', String(value))

export type { ReviewCheck, ReviewDiff, ReviewFile, ReviewFileRead, ReviewRead, ReviewSentComment, ReviewSummary } from './contract'

/** One line of a parsed patch, with its old and new numbers. */
export type DiffLine = { kind: 'add' | 'del' | 'ctx'; old?: number; new?: number; text: string }
export type DiffHunk = { header: string; lines: DiffLine[] }

/** A comment waiting in the batch; `quote` is the line it is on, shown in R3b and the batch sheet. */
export type PendingComment = ReviewComment & { quote: string }

/** The batch 发给 Agent sends: line comments, an optional note and attached failing checks (their ids). */
export type Batch = { comments: PendingComment[]; note: string; checks: string[] }

export const EMPTY_BATCH: Batch = { comments: [], note: '', checks: [] }

/** R11, in the person's words, from the contract's reason codes. */
export const DENIAL: Record<ReviewDenialReason, string> = {
  not_owner_merge: C.notOwnerMerge,
  not_owner_send: C.notOwnerSend,
  not_owner_terminal: C.notOwnerTerminal,
  github_permission: V.githubPermission,
  review_unavailable: C.reviewUnavailable,
}
export const denial = (reason: string | undefined, fallback: string) => (reason && reason in DENIAL ? DENIAL[reason as ReviewDenialReason] : fallback)
export const CANNOT_SEND = DENIAL.not_owner_send
export const CANNOT_MERGE = DENIAL.not_owner_merge

export const VERSIONED_READ_ONLY = C.versionedReadOnly
export const usesVersionedReview = (summary: ReviewSummary) => summary.reviewRef !== undefined
export const isMerged = (summary: ReviewSummary) => summary.pr?.state === 'merged'

/**
 * The summary line (R0, R2a): 「PR #1471 · 3 个文件 +42 −7 · ⚠ 1 项检查失败」 with a PR, 「3 个文件 +42 −7 · 运行中」 before
 * one. The parts are separate so the row can colour +/− and the check mark. `short` is R2a's form under the task
 * title: no file count once there is a PR, and 「1 项失败」.
 */
export function summaryParts(summary: ReviewSummary, short = false) {
  const merged = isMerged(summary)
  return {
    pr: summary.pr ? `PR #${summary.pr.number}` : null,
    files: summary.files === null || (short && summary.pr) ? null : count(summary.files === 1 ? V.filesOne : V.files, summary.files),
    additions: summary.additions === null ? null : `+${summary.additions}`,
    deletions: summary.deletions === null ? null : `−${summary.deletions}`,
    status: merged ? C.merged
      : summary.checks?.failed ? count(short ? V.failedShort : C.checksFailed, summary.checks.failed)
      : summary.running ? mobileMessages.MobileCore.states.running
      : summary.checks?.pending ? V.checking
      : summary.checks?.passed ? V.checksPassed : null,
    failed: !merged && !!summary.checks?.failed,
  }
}

/** The whole line as one string, for the screen reader. */
export const summaryLabel = (summary: ReviewSummary) => {
  const p = summaryParts(summary)
  return [p.pr, [p.files, p.additions, p.deletions].filter(Boolean).join(' '), p.status].filter(Boolean).join(V.separator)
}

/** The check row at the top of R2: 「1 项检查失败 · 5 项通过」. */
export function checksLine(checks: ReviewSummary['checks']) {
  if (checks === null) return V.noCheckData
  return [checks.neutral ? count(V.checksNeutral, checks.neutral) : null, checks.failed ? count(C.checksFailed, checks.failed) : null, checks.passed ? count(C.checksPassed, checks.passed) : null, checks.pending ? count(C.checksPending, checks.pending) : null]
    .filter(Boolean).join(' · ') || V.noChecks
}

/** The source line when the machine was reclaimed (R12), or null while the machine serves the diff. */
export function sourceLine(source: ReviewDiffSource, when: (iso: string) => string) {
  if (!source.reclaimed) return null
  const from = source.kind === 'pr' ? V.sources.pr : source.kind === 'commit' ? V.sources.commit : source.kind === 'machine' ? V.sources.machine : V.sources.checkpoint
  return V.reclaimed.replace('{source}', from).replace('{time}', () => when(source.at))
}

/** The floating bar's words: 「2 条评论 · ios-unit 失败」, or null when nothing is in the batch (写修改意见…). */
export function batchLine(batch: Batch, checks: ReviewCheck[]) {
  const attached = checks.filter(check => batch.checks.includes(check.id)).map(check => C.checkFailed.replace('{name}', () => check.name))
  return [batch.comments.length ? count(batch.comments.length === 1 ? V.commentOne : C.commentsCount, batch.comments.length) : null, ...attached].filter(Boolean).join(' · ') || null
}

export const batchIsEmpty = (batch: Batch) => !batch.comments.length && !batch.note.trim() && !batch.checks.length

export function addComment(batch: Batch, comment: PendingComment): Batch {
  return { ...batch, comments: [...batch.comments.filter(item => item.id !== comment.id), comment] }
}
export function editComment(batch: Batch, id: string, body: string): Batch {
  return { ...batch, comments: batch.comments.map(item => item.id === id ? { ...item, body } : item) }
}
export function removeComment(batch: Batch, id: string): Batch {
  return { ...batch, comments: batch.comments.filter(item => item.id !== id) }
}
export function toggleCheck(batch: Batch, id: string): Batch {
  return { ...batch, checks: batch.checks.includes(id) ? batch.checks.filter(item => item !== id) : [...batch.checks, id] }
}

/** The ReviewSubmission 发给 Agent posts; the same key for the same batch, so a second tap sends nothing twice. */
export function sendBody(batch: Batch, idempotencyKey: string) {
  return {
    idempotencyKey,
    comments: batch.comments.map(({ id, path, line, side, body }) => ({ id, path, line, side, body: body.trim() })).filter(item => item.body),
    ...(batch.note.trim() ? { note: batch.note.trim() } : {}),
    attachedChecks: batch.checks,
  }
}

/** A line's number as the sheet titles it (「第 22 行」): the new side's, or the old side's for a removed line. */
export const lineNumber = (line: DiffLine) => line.kind === 'del' ? line.old ?? 0 : line.new ?? line.old ?? 0
export const lineSide = (line: DiffLine): ReviewCommentSide => line.kind === 'del' ? 'old' : 'new'

/** A file's unified diff (the contract's `patch`) as hunks of numbered lines. File headers and "\ No newline" are skipped. */
export function parsePatch(patch: string | null): DiffHunk[] {
  if (!patch) return []
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldLine = 0, newLine = 0
  for (const raw of patch.split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (head) {
      oldLine = Number(head[1]); newLine = Number(head[2])
      current = { header: raw, lines: [] }
      hunks.push(current)
      continue
    }
    if (!current || raw.startsWith('\\')) continue
    if (raw.startsWith('+')) current.lines.push({ kind: 'add', new: newLine++, text: raw.slice(1) })
    else if (raw.startsWith('-')) current.lines.push({ kind: 'del', old: oldLine++, text: raw.slice(1) })
    else if (raw.startsWith(' ') || raw === '') current.lines.push({ kind: 'ctx', old: oldLine++, new: newLine++, text: raw.slice(1) })
  }
  // A trailing newline in the patch is not a line of the file.
  for (const hunk of hunks) while (hunk.lines.length && hunk.lines.at(-1)!.kind === 'ctx' && hunk.lines.at(-1)!.text === '' && patch.endsWith('\n')) { hunk.lines.pop(); break }
  return hunks
}

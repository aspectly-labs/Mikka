/**
 * A runtime event in the chat, as the line the person sees (review C1). The stored text is written for the
 * model (eventPrompt): English, with run and task ids and instructions. The chat never shows it; it draws
 * this line in the person's language, with the thread or task as a chip (R-15). Parsed from the stored text
 * so events written before this existed read the same way.
 */
export type EventLineKind =
  | 'runFinished' | 'runRetried' | 'runSwitched' | 'runPaused' | 'runWaitingDevice' | 'runDeviceBack'
  | 'issueStatus' | 'issueSnapshot' | 'issueAssigned' | 'issueCommented' | 'issueMentioned' | 'runReport' | 'runQuestion' | 'runBlocked' | 'artifact' | 'action' | 'scheduleRan' | 'scheduleDue' | 'other'

export interface EventLine {
  kind: EventLineKind
  runId: string | null
  issueId: string | null
  /** run_finished: succeeded / failed / stopped…; issue_status_changed: the new status; action_decided: done / failed / declined…;
   * a schedule's result: succeeded / failed / skipped / cancelled. */
  status: string | null
  /** A task's, an artifact's or a schedule's title. */
  title: string | null
  /** An Agent's own words to the chat (a report, a question), for its collapsed row (Alex, 2026-11-23); never the model's wrapper. */
  message?: string
}

/** The Agent's words in a report or question event (eventPrompt), without the lines written for the model. */
function agentWords(kind: EventLineKind, text: string): string | undefined {
  const lines = text.split('\n')
  if (kind === 'runReport') {
    const at = /^\[Event\] (?:The agent in run \S+ reports progress|An Agent reports coordination data): /.exec(lines[0] ?? '')
    if (!at) return undefined
    const rest = [lines[0]!.slice(at[0].length), ...lines.slice(1)]
    while (rest.length > 1 && /^(Issue: \S+\.|Triage: .*)$/.test(rest.at(-1)!)) rest.pop()
    const words = rest.join('\n').trim()
    return words && words !== 'undefined' ? words : undefined
  }
  if (kind === 'runQuestion') {
    const at = /^\[Event\] The agent in run \S+ asks the person: (.*)$/.exec(lines[0] ?? '')
    if (!at?.[1]) return undefined
    const options = lines.find(line => line.startsWith('Options: '))?.slice('Options: '.length)
    return options ? `${at[1]}\n\n${options}` : at[1]
  }
  return undefined
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const RUN = new RegExp(`\\b[Rr]un (${UUID})\\b`)
const ISSUE = new RegExp(`\\b(?:Issue|issue|task):? (${UUID})\\b`)

/** A schedule's own events (eventPrompt): `[Event] Schedule <id> "<title>" ran with status <status>…` or `… is due.` */
const SCHEDULE = new RegExp(`^\\[Event\\] Schedule ${UUID}(?: "(.*)")? (?:ran with status (\\w+)|(is due)\\.)`)
/** A schedule's result before its event named it: it had no text, so the model read this. */
const LEGACY_SCHEDULE_RESULT = '[Event] An Agent reports coordination data: undefined'

const KINDS: Record<string, EventLineKind> = {
  run_finished: 'runFinished', run_retried: 'runRetried', run_credential_switched: 'runSwitched', run_quota_paused: 'runPaused',
  run_dispatch_failed: 'runWaitingDevice', run_redispatched: 'runDeviceBack', issue_done: 'issueStatus', issue_status_changed: 'issueStatus', issue_assigned: 'issueAssigned', issue_activity: 'issueCommented',
  run_report: 'runReport', run_question: 'runQuestion', run_blocked: 'runBlocked', artifact_submitted: 'artifact', action_decided: 'action',
}

export function eventLine(eventKind: string | null | undefined, text: string, observedState: string | null = null): EventLine {
  const first = text.split('\n')[0] ?? ''
  const kind: EventLineKind = (eventKind ? KINDS[eventKind] : undefined) ?? 'other'
  const runId = RUN.exec(first)?.[1]?.toLowerCase() ?? null
  const issueId = ISSUE.exec(text)?.[1]?.toLowerCase() ?? null
  let status: string | null = observedState
  let title: string | null = null
  if (kind === 'issueStatus') {
    const moved = /"(.*)" moved from \S+ to (\S+?)\.$/.exec(first)
    title = moved?.[1] ?? null
    status = eventKind === 'issue_done' ? 'done' : moved?.[2] ?? null
  }
  if (kind === 'issueCommented') {
    // eventPrompt's issue_activity line: who commented on or mentioned the Bot, and the task's title.
    const activity = /^\[Event\] (.*) (commented on|mentioned you on) task \S+ "(.*)"\. Issue: /.exec(first)
    return { kind: activity?.[2] === 'mentioned you on' ? 'issueMentioned' : kind, runId: null, issueId, status: activity?.[1] ?? null, title: activity?.[3] ?? null }
  }
  if (kind === 'issueAssigned') {
    // `status` carries who assigned it; `title` is the task's own title (eventPrompt's issue_assigned line).
    const assigned = /^\[Event\] (.*) assigned you task \S+ "(.*)"\. Issue: /.exec(first)
    return { kind, runId: null, issueId, status: assigned?.[1] ?? null, title: assigned?.[2] ?? null }
  }
  if (kind === 'runFinished' && !status) status = /ended with status (\w+)/.exec(first)?.[1] ?? null
  if (kind === 'artifact') title = /"(.*)", version \d+/.exec(first)?.[1] ?? null
  if (kind === 'runReport') {
    const schedule = SCHEDULE.exec(first)
    if (schedule) return { kind: schedule[3] ? 'scheduleDue' : 'scheduleRan', runId: null, issueId: null, status: schedule[2] ?? null, title: schedule[1] ?? null }
    if (first === LEGACY_SCHEDULE_RESULT) return { kind: 'scheduleRan', runId: null, issueId: null, status: null, title: null }
  }
  const message = agentWords(kind, text)
  if (message) return { kind, runId, issueId, status, title, message }
  if (kind === 'action' && !status) status = /approved .* and it is done/.test(first) ? 'done' : / but it failed/.test(first) ? 'failed' : /declined/.test(first) ? 'declined' : null
  return { kind, runId, issueId, status, title }
}

# Remembered approvals and deny-with-a-note on approval cards

- Date: 2026-11-27
- **Status:** Accepted
- Source: owner direction, 2026-11-27 (relayed by the coordinator session): the approval card matches Codex and Claude Code, which offer "Always approve" / "Yes, and don't ask again" and "Tell it what to do instead" besides Approve and Deny. The hosted UI half (mikka-hosted-ui#393) found that the decide APIs take only a boolean.
- Relates to: [2026-11-19-native-mcp-authorization](2026-11-19-native-mcp-authorization.md) (authorized connections run without a second decision; this record changes nothing there) and [2026-11-01-1430-browser-has-no-ask](2026-11-01-1430-browser-has-no-ask.md).

## Decision

An approval card (`decidePendingAction` for account and app-tool cards,
`decideApprovedWrite` for ledger writes) takes two optional fields:

- `remember: true` with an approval is 「始终同意」. The server stores one
  allow rule (`approval_rules`) for the person and the Bot whose run proposed
  the card. The rule is derived from the stored card, never from the request:
  a client cannot send a pattern, a scope or a target.
- `note` is the person's words. On a decline they reach the Agent as what to
  do instead (the Coordinator event `action_decided` carries `note`); on an
  approval they reach it as an addition.

Both are optional, so every existing caller keeps working. A card says whether
it can offer the option (`rememberable: true` on the pending-card list and the
approved-write view), as Claude Code shows "don't ask again" only when the rule
covers just what the prompt shows.

## What a rule matches

A rule is the person, the Bot, the action, the connected account, and the
target class the card showed. Text the card showed as data (a subject, a body,
a message) may differ, as a Claude Code Bash prefix rule or WebFetch domain
rule lets the rest of the command differ.

| Action | Target the rule binds |
| --- | --- |
| `send_email` | the exact recipient set (to + cc + bcc, case-folded) |
| `create_calendar_event` | the exact attendee set (empty: no guests) |
| `update_calendar_event` | the event id and, when given, the attendee set |
| `app_tool_call` | the toolkit and the tool slug |
| `send_slack_message` / `append_notion_paragraph` | the ledger target (`writeTarget`: the channel or the page) |

Only `sha256` of the canonical match is compared (`matchKey`); `match` is kept
for the list the person reads.

Never remembered: `browser_operation`, `credential_operation`,
`cancel_calendar_event`, any app tool whose slug names an irreversible or
permission-changing effect (delete, remove, merge, share, transfer, pay, …) or
that the provider tags `destructiveHint`, a card without a Bot, and any action
not in the table. This mirrors Codex's list of prefixes it never offers to
remember (`BANNED_PREFIX_SUGGESTIONS`).

## Where it is checked

Only where a review answered `ask`, immediately before a card would be stored:
the dispatch gate in `writeAccountAction`, `callAppTool`, and
`proposeFromRun`. A matching rule turns that `ask` into `allow`; it never
turns a `deny` into anything, and the workspace app admission and account
checks still run (deny > ask > allow, as in Claude Code). The owner and Bot
come from the authenticated run, so one person's rule never answers another
person's card, and a rule for one Bot (and so one workspace) never answers
another Bot's.

## Scope, storage, revocation

- Scope: the person and the Bot. This is Mikka's closest match to Claude
  Code's per-repository rule; a Bot belongs to one workspace. A session-only
  rule (Codex's `ApprovedForSession`) is not offered: Mikka's cards outlive a
  session and arrive from other threads.
- Storage: `approval_rules` in the app database
  (`drizzle/20261127145325_approval_rules.sql`), deleted with the person or
  the Bot (`ON DELETE CASCADE`), at most 500 per person.
- Revocation: `approval-rules.listApprovalRules` and
  `approval-rules.revokeApprovalRule` (server actions, desktop RPC), owner-only.
  The settings list (设置 › 权限) is the UI follow-up.

## References

- Codex `ReviewDecision` (`ApprovedForSession`, `ApprovedExecpolicyAmendment`,
  `Denied { rejection }`) and `AskForApproval`:
  https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
- Codex `ExecPolicyAmendment` (a `prefix_rule(..., decision="allow")`):
  https://github.com/openai/codex/blob/main/codex-rs/protocol/src/approvals.rs
- Codex rules file (`~/.codex/rules/default.rules`) and
  `BANNED_PREFIX_SUGGESTIONS`:
  https://github.com/openai/codex/blob/main/codex-rs/core/src/exec_policy.rs
- Claude Code permissions ("Yes, and don't ask again" scope per tool type,
  `.claude/settings.local.json`, `/permissions`, deny > ask > allow, a comment
  on No sent as the denial reason): https://code.claude.com/docs/en/permissions

Cost if wrong: a remembered rule runs later calls the person did not see. The
match is deliberately narrow (exact recipients, one channel, one page, one
tool on one account, from one Bot) and revocable; widening it needs a new
decision.

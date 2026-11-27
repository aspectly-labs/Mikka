# Remembered approvals and deny-with-a-note on approval cards

- Date: 2026-11-27
- **Status:** Accepted
- Source: owner direction, 2026-11-27, relayed by the coordinator session. The approval card should match Codex and Claude Code, which offer "Always approve" / "Yes, and don't ask again" and "Tell it what to do instead" besides Approve and Deny. The hosted UI half (mikka-hosted-ui#393) found that the decide APIs took only a boolean. The independent security review of #3384 set the precedence, the app-tool allow-list, the Bot binding and the follow-up below.
- Relates to: [2026-11-19-native-mcp-authorization](2026-11-19-native-mcp-authorization.md) and [2026-11-01-1430-browser-has-no-ask](2026-11-01-1430-browser-has-no-ask.md). This record changes neither: authorized connections still run without a second decision.

## Decision

An approval card takes two optional fields. `decidePendingAction` covers
account and app-tool cards; `decideApprovedWrite` covers ledger writes. Every
existing caller keeps working.

- **`remember: true`** with an approval is 「始终同意」. The server stores one
  allow rule (`approval_rules`) for the person and the Bot whose run proposed
  the card. It derives the rule from the stored card, never from the request:
  a client cannot send a pattern, a scope or a target, and the strict request
  schemas reject one. Only a card that is still `pending` can be remembered.
- **`note`** is the person's words, run through the credential masker and
  capped at 2000 characters. It reaches the Agent in `action_decided`. With a
  decline it reads as what to do instead; with an approval, as an addition.

A card offers the option only when it can keep it. The pending-card list and
a pending approved-write view carry `rememberable: true` in that case. This
follows Claude Code, which shows "don't ask again" only when the rule covers
just what the prompt shows.

## What a rule matches

A rule is the person, the Bot, the action, the connected account, and the
exact target the card showed. Text the card showed as data, such as a subject,
a body or a message, may differ.

| Action | Target the rule binds exactly |
| --- | --- |
| `send_email` | the recipient set (to + cc + bcc, case-folded) |
| `create_calendar_event` | the attendee set (empty: no guests) |
| `update_calendar_event` | the event id and, when given, the attendee set |
| `send_slack_message` / `append_notion_paragraph` | the ledger target (`writeTarget`: the channel or the page) |
| `app_tool_call` | only a tool on `REMEMBERABLE_APP_TOOLS`, with its named target arguments: `GMAIL_SEND_EMAIL` (the recipients and the sending user) and `SLACK_SEND_MESSAGE` (the channel and thread) |

An app tool is not rememberable by default. A tool off the allow-list always
asks, whatever its name. A call with any argument the list does not name is
never remembered or matched, because the card would show an effect the rule
did not name. This is the exact-match shape of a Codex exec-policy rule. The
list of banned names is an extra layer, not a substitute. It covers delete,
merge, share, collaborator, visibility, secret, filter, reference, workflow
dispatch, deploy, clear and similar names, and the provider's
`destructiveHint` is checked again at call time.

Never remembered:

- `browser_operation`, `credential_operation` and `cancel_calendar_event`;
- any app tool off the allow-list;
- a card without a Bot;
- any action not in the table.

Codex has a similar list of prefixes it never offers to remember
(`BANNED_PREFIX_SUGGESTIONS`).

Only `sha256` of the canonical match is compared (`matchKey`). `match` is kept
for the list the person reads.

## Precedence

A configured choice always wins over a personal rule, as Claude Code's
managed settings win over a user's rules.

- A deny, the workspace app admission and the account checks always stop the
  call. A rule never turns a deny into anything.
- An ask that a workspace admin configured is never answered by a personal
  rule.
- Only the default, built-in ask for a person's own Bot action may be answered
  by that person's matching rule.

**Where people are asked today.** Since 2026-11-19, connected-app calls never
ask on the production paths:

- Every new run write uses `lockWritePolicy({ direct: true })`.
- The Coordinator's `accountWrite`, `appTools` and `personalWrite` steps pass
  no review.
- The Eve product bridge records the callers' own `allow`.

`approval-rules.db.test.ts` asserts that the Coordinator's path sends at once.
No admin-configured ask exists for these writes either: the workspace
Allow/Ask/Deny matrix is no longer read for them.

The rule check therefore sits only where a host review answers `ask`, just
before a card would be stored: the dispatch gate in `writeAccountAction`,
`callAppTool`, and `proposeFromRun`. A host that brings back an ask for these
writes must keep the precedence above. `lockWritePolicy` already reports
`defaulted`, which separates a default ask from a configured one. Bringing
back a default ask for Bot writes reverses 2026-11-19 and needs the owner's
decision.

## Scope, binding, storage, revocation

- **Scope:** the person and the Bot. This is Mikka's closest match to Claude
  Code's per-repository rule; a Bot belongs to one workspace. A session-only
  rule (Codex's `ApprovedForSession`) is not offered, because Mikka's cards
  outlive a session.
- **Binding:** each rule records the Bot as the person saw it: its workspace,
  its owner, and `botFingerprint`. The fingerprint is md5 of the Bot's private
  instructions and the person's active Agent definition version. A check
  matches only while all of these are unchanged and the Bot is not archived.
  So a Bot that is handed over, paused, re-instructed or redefined asks again.
  The settings list shows such a rule with `active: false`.
- **Deletion:**
  - `transferBots` deletes every rule on the Bots it hands over.
  - `releaseDepartingMember` deletes the departing person's rules in that
    workspace.
  - Deleting the person or the Bot cascades.
- **Storage:** `approval_rules` in the app database
  (`drizzle/20261127145325_approval_rules.sql`), at most 500 rules per person.
- **Failure:** a rule is saved only after the card's outcome is recorded, or
  for ledger writes inside the approval's transaction behind a savepoint. A
  failed save never strands the card; the decision then reports
  `remembered: false`.
- **Revocation:** `approval-rules.listApprovalRules` and
  `approval-rules.revokeApprovalRule` (server actions and desktop RPC) work on
  the owner's own rules only. The settings list (设置 › 权限) is the UI
  follow-up.

## Follow-up (not in this record's code): Factory permission questions

The questions people actually answer today are Factory permission questions:
a device run's `ask` for actions such as installing a dependency or reaching
the network. Those answers are free text, and the continuation prompt says
the input "grants no new permission". The recommended extension:

- `runQuestion` carries a structured `permission: { action, target }`. The
  action is one of the protocol's `PERMISSION_ACTIONS`, and the host derives
  and checks the target (a package, a host, a path) from the run, not from the
  Agent's words.
- 「始终同意」 on such a question writes a scoped allow into the run-policy
  layer in `lib/agent-tool-approval/policy-store.ts`, for the person and that
  Bot or task scope only.
- The same precedence applies there. A workspace or team layer's explicit
  `ask` or `deny`, or `approvalMode: 'read_only'`, is never answered by it.
  Only the personal default ask (`personalApprovalMode`) is.
- It is never offered for publish, promote or deploy, for `git_push`, or for a
  free-text question that names no permission action.

## References

- Codex `ReviewDecision` (`ApprovedForSession`, `ApprovedExecpolicyAmendment`,
  `Denied { rejection }`) and `AskForApproval`:
  https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
- Codex `ExecPolicyAmendment` (a `prefix_rule(..., decision="allow")`):
  https://github.com/openai/codex/blob/main/codex-rs/protocol/src/approvals.rs
- Codex rules file (`<codex_home>/rules/default.rules`) and
  `BANNED_PREFIX_SUGGESTIONS`:
  https://github.com/openai/codex/blob/main/codex-rs/core/src/exec_policy.rs
- Claude Code permissions:
  https://code.claude.com/docs/en/permissions. It covers the scope of "Yes,
  and don't ask again" per tool type, `.claude/settings.local.json`,
  `/permissions`, deny > ask > allow, and a comment on No sent as the denial
  reason.

Cost if wrong: a remembered rule runs later calls the person did not see. The
match is deliberately exact: the same recipients, channel, page or
allow-listed tool target, on one account, from one Bot as it was. It is
revocable and lapses when the Bot changes. Widening it needs a new decision.

# No consent asks: once a person has spoken, the agent acts

- Date: 2026-11-27 17:20 UTC
- **Status:** Accepted (Alex, 2026-11-27)
- Source: Alex, 2026-11-27: 「第一个问题不需要问，直接操作，就说我说话之后就直接操作就行了。第二个，禁止 agent 操作屏幕的设置，可以保留。」
- Extends: [2026-11-27-1615-no-permission-approvals](2026-11-27-1615-no-permission-approvals.md), which says agents never ask for permission. This record names the consent asks that rule covers and the one setting it keeps.

## Decision

1. **No consent asks.** Mikka never asks a person before an agent:
   - runs on a device (the person's own machine, a connected device, a local daemon run);
   - uses computer use or operates a screen (local or cloud);
   - acts as the person (posting "as you" in Slack, or any similar act-as-you step).

   Once the person has sent the message, the agent acts. There is no consent card, no "Allow / Allow for this task / Deny", no pending consent state and no consent-required error that stops a run to wait for a person.
2. **The screen setting stays.** The workspace setting that forbids agents to operate the screen (设置 › 团队权限 › 电脑操作: Allow / Block, `workspace_computer_policies`, and the workspace `computer_use` choice read by `storedComputerUse` in `packages/protocol/src/agent-policy.ts`) is an admin boundary, not a per-run prompt. `Block` still blocks computer use, and turning it on stops runs that hold computer authority. A stored legacy `ask` reads as allow. A device's own computer-use switch (`devices."computerUseEnabled"`) stays for the same reason.
3. **Still not consent asks, and kept:** logins and OAuth the person completes (provider consent screens, device sign-in, subscription and Linear app authorization, saved logins); macOS Accessibility and Screen Recording grants the operating system requires; connection ownership and sharing; tenant and workspace isolation; provider scopes; secret handling. An automation's 运行身份 (Runs as) and 以运行身份的成员发帖 (Post as the person it runs as) can only be turned on by that person or returned to the creator: one person cannot make an automation act or post as someone else. That is an identity boundary, not a question.

## What this removes

- The `ask` tier of the local computer grant (`RunAssignment.localComputer.permission`): the server sends `allow`; an older server's `ask` reads as allow; the daemon's computer broker grants only `allow`.
- The per-run computer approval (`computer_run_bindings."approvedForRun"`, 「本任务内都允许」): nothing writes or reads it. The column stays for older builds and is not a decision.
- The computer approval strings (`Computer.approval.*`).
- The `approval` computer task state and `approvalId` are no longer set; the protocol keeps them for one release until the official UI's computer status stops naming them.

## Consequences

- `AGENTS.md` states the rule beside 1615's.
- A reviewer rejects any PR that asks a person before an agent runs on a device, uses a screen or acts as them.

# No permission approvals: agents run with full access

- Date: 2026-11-27 16:15 UTC
- **Status:** Accepted (Alex, 2026-11-27)
- Source: Alex, 2026-11-27: 「我们不做权限审批。包括连接的 plugin、MCP 之类的东西，你在它的网站上授权了什么，我们就直接用什么，不做第二次审批。……Codex 是直接用 full access，CC 是用 bypass permission。……我们是不允许它去询问权限的呀。」
- Supersedes in part: [2026-11-27-1409-top-products-over-paid-blocks](https://github.com/aspectly-labs/mikka-hosted-ui/blob/main/docs/design/decisions/2026-11-27-1409-top-products-over-paid-blocks.md), only the words "approval/permission cards" in its list of chat surfaces (there are no permission cards); [2026-11-24-1518-design-system-v2-chatgpt-cc-standard](https://github.com/aspectly-labs/mikka-hosted-ui/blob/main/docs/design/decisions/2026-11-24-1518-design-system-v2-chatgpt-cc-standard.md), only "permission" and "write approval" in its single-bottom-slot priority.
- Restates, as one rule: the harness flags in [2026-11-01-2335-e2b-official-templates](2026-11-01-2335-e2b-official-templates.md), `docs/design/orchestration.md`, `docs/design/unattended-sandbox.md`, `docs/factory/execution-route-v1.md`, the "zero tool-approval waits" acceptance in `docs/operations/epic3076-e2e-acceptance.md`, and [authorized MCP connections](2026-11-19-native-mcp-authorization.md) (R-77).

## Why this record exists

The rule was already true in pieces: every harness launches with full access, and authorized connections run without a second decision. But no top-level rule said it, and living docs still described permission cards and write approvals as product features (R-10's bottom slot, the `TakeoverCard` catalogue entry, R-74's "approval requirements"). Agents reading those kept building, restyling and extending permission prompts. This record states the rule once, at the top, so nobody adds one again.

## Decision

1. **Agents never ask a human for permission.** Every agent on every route — cloud/E2B, the local daemon, Desktop, subagents and independent checks — runs with full access:
   - Claude Code: `permissionMode: "bypassPermissions"` with `allowDangerouslySkipPermissions: true`;
   - Codex: `approvalPolicy: "never"` with `sandbox: "danger-full-access"`;
   - any other Agent: its equivalent no-approval, full-access mode.
2. **Connected apps, plugins and MCP servers** use exactly what the person authorized on the provider's site. Mikka adds no second approval, no per-call Allow/Ask/Deny, and no "remember this approval" rules.
3. **No permission prompts anywhere in the product:** no run question of kind `permission`, no pending-action or write-approval card, no "approve / always approve" UI, no settings page for approval policies. Code that makes a run stop and wait for a human's permission is a bug to remove, not a feature to improve.
4. **What stays — these are not permission approvals:**
   - questions an agent asks to decide *what* to do (a choice, a clarification, missing information), and logins/credentials the person must supply;
   - security boundaries: tenant and workspace isolation, authentication, connection ownership and sharing, provider scopes, secret handling and masking, paid-source and licence-key guards;
   - release policy for production deploys (`docs/operations/releases/`), which is a deploy process, not a run-time prompt.
5. **Removing what exists** goes in PR-sized steps (protocol and daemon, then server stores and routes, then the hosted UI), each deleting its tests and fixtures with it. Until a step lands, the remaining code is a known violation of this rule, not a precedent.

## Consequences

- `AGENTS.md` states the rule in its core invariants; `mikka-hosted-ui/docs/design/rules.md` R-10, R-74 and R-77 and the `design-system.md` bottom-slot priority no longer mention permissions or write approvals.
- A reviewer rejects any PR that adds a permission prompt, an approval policy, or an "always approve" path.

# Git author identity, GPG signing boundary, and reviewer boundary

This backend slice (#3110 WS-A, Frame 19) extends the [registered settings backend](registry.md) with inheritable Git commit identity fields, documents the GPG commit-signing security boundary, and records the product decision omitting standalone `reviewRuleSchema` CRUD.

## Git commit author identity

| Key | Scope | Guard | Default |
| --- | --- | --- | --- |
| `gitAuthorName` | `personal`, `workspace` | Trimmed string `<= 100` chars (no control chars or `<>`), or `""` | `""` |
| `gitAuthorEmail` | `personal`, `workspace` | Valid email `<= 254` chars (no control chars or `<>`), or `""` | `""` |

Both keys belong to `group: "git"` and `page: "git"` with `personalContext: "workspace"` and `personalOverride: true`:

- Personal overrides are read and written via `GET / PATCH /api/settings/personal?workspaceId=<uuid>` and reset via `POST /api/settings/personal/reset?workspaceId=<uuid>` (`{"group":"git"}`).
- Workspace defaults are read by workspace members via `GET /api/settings/workspace/<uuid>` and written or reset by workspace administrators via `PATCH /api/settings/workspace/<uuid>` and `POST /api/settings/workspace/<uuid>/reset`.
- Responses carry `{ value, source: "personal" | "workspace" | "default" }`. `null` clears an override to inherit; `""` is an explicit override that restores fallback behavior.

### Daemon delivery and publish fallback order

`readCliRunPolicy(pool, runId, userId, undefined, { includeGitIdentity: true })` resolves non-empty `gitAuthorName` and `gitAuthorEmail` inside the held run-policy transaction when claiming a run and attaches `gitIdentity` to the `POST /v1/devices/:deviceId/runs/:runId/claim` assignment (`RunAssignment.gitIdentity`). Other policy consumers (such as subscription context checks and model admission) omit `includeGitIdentity` so their SQL statement budgets are unchanged.

When `@mikka/daemon` creates commits in `publishRun` or `retainDeliverable` (`packages/daemon/src/agents/publish.ts`), each field (`user.name` and `user.email`) resolves independently in strict priority order:

1. Repository local `git config` (`user.name` / `user.email`, isolated from host global/system gitconfig)
2. Resolved run setting (`gitAuthorName` / `gitAuthorEmail`)
3. `FALLBACK_IDENTITY` (`Mikka Agent <agent@mikka.invalid>`)

## GPG signed commits (`pro:blocked`)

End-to-end GPG commit signing is intentionally not exposed as a setting toggle (`pro:blocked`):

- `publish.ts` (`SAFE_GIT`), `github-runtime.ts:87-88`, and `local-github.ts:62-63` enforce `commit.gpgSign=false` (and `tag.gpgSign=false`) so untrusted worktree config cannot invoke arbitrary `gpg.program` binaries and sandboxed runs do not fail trying to reach unreachable host `gpg-agent` sockets or hardware tokens.
- Exporting long-lived user GPG private keys and passphrases into E2B VMs or local daemons violates the credential exposure boundary (`docs/design/decisions/2026-11-08-0240-credential-exposure-boundary.md`).
- No GPG key custody, remote signing service, or GitHub `/user/gpg_keys` synchronization exists in the platform.

## App Reviewer boundary (`reviewRuleSchema` omitted)

Per product decision (Alex, 2026-11-21), the built-in Software Factory `stage="review"` pipeline is the sole App Reviewer role, and automatic PR review triggers and parameters live in P5 (#2973, `review-repositories` and `codeReview*` registry settings). Standalone `reviewRuleSchema` CRUD endpoints, Desktop RPC methods, and a `workspace_review_rules` table are intentionally omitted.

# Git author identity, GPG signing boundary, and workspace review rules

This backend slice (#3110 WS-A, Frame 19) extends the [registered settings backend](registry.md) with inheritable Git commit identity fields, documents the GPG commit-signing security boundary, and exposes workspace read/write operations for `reviewRuleSchema` (`@mikka/protocol/orchestrator`).

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

`readCliRunPolicy` resolves non-empty `gitAuthorName` and `gitAuthorEmail` inside the held run-policy transaction and attaches `gitIdentity` to the `POST /v1/devices/:deviceId/runs/:runId/claim` assignment (`RunAssignment.gitIdentity`).

When `@mikka/daemon` creates commits in `publishRun` or `retainDeliverable` (`packages/daemon/src/agents/publish.ts`), each field (`user.name` and `user.email`) resolves independently in strict priority order:

1. Repository local `git config` (`user.name` / `user.email`, isolated from host global/system gitconfig)
2. Resolved run setting (`gitAuthorName` / `gitAuthorEmail`)
3. `FALLBACK_IDENTITY` (`Mikka Agent <agent@mikka.invalid>`)

## GPG signed commits (`pro:blocked`)

End-to-end GPG commit signing is intentionally not exposed as a setting toggle (`pro:blocked`):

- `publish.ts` (`SAFE_GIT`), `github-runtime.ts:87-88`, and `local-github.ts:62-63` enforce `commit.gpgSign=false` (and `tag.gpgSign=false`) so untrusted worktree config cannot invoke arbitrary `gpg.program` binaries and sandboxed runs do not fail trying to reach unreachable host `gpg-agent` sockets or hardware tokens.
- Exporting long-lived user GPG private keys and passphrases into E2B VMs or local daemons violates the credential exposure boundary (`docs/design/decisions/2026-11-08-0240-credential-exposure-boundary.md`).
- No GPG key custody, remote signing service, or GitHub `/user/gpg_keys` synchronization exists in the platform.

## Workspace review rules (`reviewRuleSchema`)

`drizzle/20261122004735_workspace_review_rules.sql` creates `workspace_review_rules` (`PRIMARY KEY ("workspaceId", "repoKey")`) backing `reviewRuleSchema`:

| Method | Path | Access | Body |
| --- | --- | --- | --- |
| `GET` | `/api/settings/workspace/<uuid>/review-rules` | Active workspace member | None |
| `PATCH` | `/api/settings/workspace/<uuid>/review-rules` | Active workspace admin | `{ "repoKey"?: string \| null, "rule": ReviewRuleInput }` |
| `DELETE` | `/api/settings/workspace/<uuid>/review-rules` | Active workspace admin | `{ "repoKey"?: string \| null }` (or empty body) |

Desktop RPC methods:

- `review-rule-settings.getWorkspaceReviewRules` (`[workspaceId]`)
- `review-rule-settings.saveWorkspaceReviewRule` (`[workspaceId, { repoKey?, rule }]`)
- `review-rule-settings.deleteWorkspaceReviewRule` (`[workspaceId, { repoKey? }?]`)

Response shape:

```json
{
  "workspaceId": "00000000-0000-4000-8000-000000000001",
  "rule": {
    "value": {
      "requirePullRequest": true,
      "requireCi": true,
      "checkHarness": null,
      "branchTemplate": "mikka/{team}-{number}",
      "prBodyTemplate": null
    },
    "source": "default",
    "updatedAt": null
  },
  "overrides": [
    {
      "repoKey": "github.com/acme/app",
      "rule": {
        "requirePullRequest": true,
        "requireCi": true,
        "checkHarness": "codex",
        "branchTemplate": "acme/{number}",
        "prBodyTemplate": null
      },
      "source": "repository",
      "updatedAt": "2026-11-22T00:00:00.000Z"
    }
  ]
}
```

`rule.source` is `"workspace"` when saved for the workspace (`repoKey = ""`) and `"default"` otherwise; per-repository overrides added via "+" normalize clone URLs or `host/owner/name` via `normalizeRepoKey` and report `source: "repository"`.

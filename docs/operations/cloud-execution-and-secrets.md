# Cloud execution authority, secrets, and E2B templates

**Audience:** Engineers and coding agents modifying task execution, model egress, MCP configuration, credential delivery, or E2B worker templates across `aspectly-labs/Mikka` and `packages/daemon`.
**Scope:** Execution isolation, LiteLLM-only managed model egress, task Secret boundaries, native Task MCP delivery, additive E2B releases, and isolated test cleanup.
**Out of scope:** Secret values, cloud vaults, staging/production cutover, and company smoke accounts (see private [`mikka-cloud/AGENTS.md`](https://github.com/alexj11324/mikka-cloud/blob/main/AGENTS.md) and [`mikka-cloud/docs/operations/README.md`](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/README.md)).

## Cloud execution authority and task Secret exposure

Cloud execution authority stays on the task's machine ([2026-11-06-1800](../design/decisions/2026-11-06-1800-machine-is-the-execution-boundary.md)), while user and workspace third-party API Secrets remain isolated from Agent-readable environment variables ([2026-11-08-0240](../design/decisions/2026-11-08-0240-credential-exposure-boundary.md)):

- **One task per E2B VM:** Official Claude Code and Codex CLIs keep their ordinary `HOME`, environment, and Git configuration. Deliver the short-lived Mikka model gateway token and any authorized GitHub credential needed by the run.
- **No control-plane execution proxies:** Do not reintroduce shadow Git, isolated CLI `HOME` directories, or per-tool control-plane authorization proxies.
- **Model egress** uses LiteLLM for BYOK and Managed Model requests. Official Claude Code and Codex subscriptions use the independent CPA worker. Native Threads authenticate with the run-bound gateway token. [Subscription inference decision](../design/decisions/2026-11-27-2304-official-subscription-cpa-egress.md)
- API and Eve releases bundle the compatible CPA executable. Roll back the application and its worker as one release. Install the matching executable before selecting a custom worker path.
- **Protected third-party Secrets:** Do not inject unrelated user, workspace, or repository third-party API Secrets into Agent-readable environment variables or files. Protected Secrets use run-scoped sealed grants and non-readable egress/tool handling where supported; explicit direct delivery stays compatibility-only for existing env-dependent SDKs.
- **Revocation and local daemon boundaries:** Revocation pushes stop and reclaim affected VMs while natural token renewal runs in the background. Local daemon safeguards preserve unrelated files on the host machine.

### Subscription chat release prerequisites

Pair the Business API, Eve and private CPA worker at the candidate revision.
On staging, verify both provider streams and the corresponding subscription
usage receipts. Keep the signed private callback and LiteLLM pass-through
bindings available for earlier application versions during the rollout.
The production promotion follows the authorized release window. [Release coordination](https://github.com/aspectly-labs/Mikka/issues/1954)

## Native Task MCP delivery

Task MCP uses native CLI configuration and credential delivery ([2026-11-11-0534](../design/decisions/2026-11-11-0534-eve-and-native-mcp.md)):

- Deliver selected HTTP endpoints/headers and STDIO command/environment configuration directly to the task's official CLI (the task can read those configured MCP credentials).
- Keep Composio service credentials with the provider and preserve the exposure boundary for unrelated Secrets.
- Do not build a second generic MCP client or approval loop alongside Eve and native CLI clients.
- Workspace MCP servers ([2026-11-27-1705](../design/decisions/2026-11-27-1705-workspace-mcp-servers-like-capy.md)) follow Capy's organization servers: any active member manages them; a run uses the workspace's servers plus its starter's own (the starter's own wins a key clash); `shared` uses the workspace's one account, `member` only the run requester's own account; the claim fence includes the exported tool switches.

## Derived E2B template releases

Derived E2B releases are additive and gated ([2026-11-03-1430](../design/decisions/2026-11-03-1430-official-e2b-templates-unchanged.md)):

- Build on top of E2B's official `claude`, `codex`, and `desktop` templates, installing Mikka software strictly under `/opt/mikka` without deleting or overwriting any original files.
- Keep reusable templates free of task credentials or user identities.
- CI verifies original-file conservation and template build readiness before publication (`#2789`, without a live subscription gate).
- Retain previously published templates and immutable release receipts for rollback; a partial configuration write cannot replace the last valid release. See [`docs/dev-workflow.md#7-e2b-templates`](../dev-workflow.md#7-e2b-templates) and [`.github/workflows/README.md#cloud-worker-template-release`](../../.github/workflows/README.md#cloud-worker-template-release).

## Secret hygiene and isolated test cleanup

Mikka Cloud uses its deployment E2B key. Before the cutover, a personal E2B
account may have created a sandbox or snapshot. Migration records preserve that
owner and account scope. During account deletion, proven external resources
stay with their E2B account and the deletion receipt discloses their custody.
Mikka removes local access through account deletion.

- Store credential values strictly in the deployment's secret manager and established workload delivery. Never commit values, write them to local environment files, or print them in terminal output, screenshots, or reports.
- Running an authorized test includes setting up and cleaning up only the disposable fixtures, schemas, and temporary files created by that test in an isolated target. Verify target isolation first, never extend cleanup to shared or production data, and honor any explicit preservation hold.

### Portable task workspaces

The Environment record in Mikka PostgreSQL is the definition. It names the portable Mikka runtime base, the approved install and maintenance commands, plain variables, and encrypted secret references. The E2B image is a rebuildable cache for that revision. A provider cache miss invalidates the image and queues a replacement through the existing Environment snapshot workflow. The replacement task still uses the saved definition.

When a writable E2B task reaches a confirmed native exit, Mikka saves the tracked working tree and ordinary untracked files to the Mikka task-workspace bucket. The archive is a checksummed `tar.zst` in the `task-workspaces/v1/` namespace also used by the Cloudflare task machine. A PostgreSQL receipt binds the immutable object to the owner, Workspace, task, repository, exact writer attempt, and Git commit. No Git private metadata, process state, platform credentials, or managed secret values belong in the archive. Mikka validates the sealed archive before uploading it and publishes the receipt before confirming park. The existing recovery cron removes expired objects that have no published receipt.

A cold E2B machine stages the verified archive and supplies its receipt to the authenticated worker claim. The daemon uses the recorded Git base when the authorized clone can prove it is an ancestor. When a shallow clone or rewritten branch lacks that commit, the daemon rebuilds the full archived tree on the current authorized commit. Local-only commits remain as file changes. The daemon replaces the working files atomically and keeps the new Git linkage. A failed upload leaves the last published object intact, and a newer unfinished capture blocks cold restoration from that older object. Changes from a writer that never reaches a safe point may still exist on its original machine. The server cannot certify those changes as retained in Mikka storage.

On R2 the default bucket is `mikka-task-workspaces`. The API can use separately scoped task-workspace R2 credentials, or an installation's existing S3-compatible storage configuration. Provider selection and the Cloudflare machine's existing backup remain in place.

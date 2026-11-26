# Cloud execution authority, secrets, and E2B templates

**Audience:** Engineers and coding agents modifying task execution, model egress, MCP configuration, credential delivery, or E2B worker templates across `aspectly-labs/Mikka` and `packages/daemon`.
**Scope:** Execution isolation, LiteLLM-only managed model egress, task Secret boundaries, native Task MCP delivery, additive E2B releases, and isolated test cleanup.
**Out of scope:** Secret values, cloud vaults, staging/production cutover, and company smoke accounts (see private [`mikka-cloud/AGENTS.md`](https://github.com/alexj11324/mikka-cloud/blob/main/AGENTS.md) and [`mikka-cloud/docs/operations/README.md`](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/README.md)).

## Cloud execution authority and task Secret exposure

Cloud execution authority stays on the task's machine ([2026-11-06-1800](https://github.com/aspectly-labs/mikka-hosted-ui/blob/main/docs/design/decisions/2026-11-06-1800-machine-is-the-execution-boundary.md)), while user and workspace third-party API Secrets remain isolated from Agent-readable environment variables ([2026-11-08-0240](https://github.com/aspectly-labs/mikka-hosted-ui/blob/main/docs/design/decisions/2026-11-08-0240-credential-exposure-boundary.md)):

- **One task per E2B VM:** Official Claude Code and Codex CLIs keep their ordinary `HOME`, environment, and Git configuration. Deliver only the run's selected CLI subscription OAuth (or short-lived Mikka model gateway token) and authorized GitHub credential when needed.
- **No control-plane execution proxies:** Do not reintroduce shadow Git, isolated CLI `HOME` directories, or per-tool control-plane authorization proxies.
- **LiteLLM-only managed model egress ([2026-11-20-0530](https://github.com/aspectly-labs/mikka-hosted-ui/blob/main/docs/design/decisions/2026-11-20-0530-litellm-only-model-egress.md)):** Every Mikka-managed model request — including credits, daemon BYOK, and self-hosted API-key paths — routes through the backend LiteLLM gateway with no direct-provider fallback. The execution machine holds only a short-lived gateway token. Official subscription OAuth CLIs remain independent pending `#2869`.
- **Protected third-party Secrets:** Do not inject unrelated user, workspace, or repository third-party API Secrets into Agent-readable environment variables or files. Protected Secrets use run-scoped sealed grants and non-readable egress/tool handling where supported; explicit direct delivery stays compatibility-only for existing env-dependent SDKs.
- **Revocation and local daemon boundaries:** Revocation pushes stop and reclaim affected VMs while natural token renewal runs in the background. Local daemon safeguards preserve unrelated files on the host machine.

## Native Task MCP delivery

Task MCP uses native CLI configuration and credential delivery ([2026-11-11-0534](https://github.com/aspectly-labs/mikka-hosted-ui/blob/main/docs/design/decisions/2026-11-11-0534-eve-and-native-mcp.md)):

- Deliver selected HTTP endpoints/headers and STDIO command/environment configuration directly to the task's official CLI (the task can read those configured MCP credentials).
- Keep Composio service credentials with the provider and preserve the exposure boundary for unrelated Secrets.
- Do not build a second generic MCP client or approval loop alongside Eve and native CLI clients.

## Derived E2B template releases

Derived E2B releases are additive and gated ([2026-11-03-1430](https://github.com/aspectly-labs/mikka-hosted-ui/blob/main/docs/design/decisions/2026-11-03-1430-official-e2b-templates-unchanged.md)):

- Build on top of E2B's official `claude`, `codex`, and `desktop` templates, installing Mikka software strictly under `/opt/mikka` without deleting or overwriting any original files.
- Keep reusable templates free of task credentials or user identities.
- CI verifies original-file conservation and template build readiness before publication (`#2789`, without a live subscription gate).
- Retain previously published templates and immutable release receipts for rollback; a partial configuration write cannot replace the last valid release. See [`docs/dev-workflow.md#7-e2b-templates`](../dev-workflow.md#7-e2b-templates) and [`.github/workflows/README.md#cloud-worker-template-release`](../../.github/workflows/README.md#cloud-worker-template-release).

## Secret hygiene and isolated test cleanup

- Store credential values strictly in the deployment's secret manager and established workload delivery. Never commit values, write them to local environment files, or print them in terminal output, screenshots, or reports.
- Running an authorized test includes setting up and cleaning up only the disposable fixtures, schemas, and temporary files created by that test in an isolated target. Verify target isolation first, never extend cleanup to shared or production data, and honor any explicit preservation hold.

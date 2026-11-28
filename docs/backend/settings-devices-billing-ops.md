# Settings Backend: Device Policy, Repositories, Billing, Ops Metrics & Usage Environment

This document covers the Stream WS-G backend contracts (#3110, #2957) across Frames 15/44–46 (Devices), Frame 26 (Billing), Frame 30 (Ops Metrics), Frame 27 (Usage Export & Environment dimension), and Frame 18 (Subagent Nesting Depth). All HTTP responses set `Cache-Control: private, no-store`.

## 1. Device Policy & Cross-Device Migration Capability (Frames 15 / 44–46)

### Endpoints & Desktop RPC

- `GET /api/devices/:deviceId/policy?workspaceId=<optional-uuid>`
- `PATCH /api/devices/:deviceId/policy?workspaceId=<optional-uuid>`
- Desktop RPC: `devices.getPolicy(deviceId, workspaceId?)`, `devices.updatePolicy(deviceId, input, workspaceId?)`

### Authorization

- **Device owner** (`devices.ownerId === caller`): permitted directly; if `workspaceId` is supplied, active membership in that workspace is verified.
- **Workspace admin**: permitted only when `workspaceId` is supplied, the caller is an active `admin` of `workspaceId`, the device owner is an active member of `workspaceId`, and the device is bound to `workspaceId` via `device_project_checkouts`, `thread_machines`, or `cloud_machines`. Admins of unrelated workspaces (including workspaces shared with the owner where that personal device has no binding) receive `403 workspaceAccessDenied`.

### Policy Fields & Runtime Enforcement

- `schedulingEnabled` (`devices.enabled`, boolean): controls whether the orchestrator dispatches runs to this device.
- `computerUseEnabled` (`devices."computerUseEnabled"`, boolean `NOT NULL DEFAULT true`): binary `allow` / `deny` switch only (`computerUse.mode: 'allow' | 'deny'`; there is no `ask` tier).
  - Enforced on run claim (`app/v1/devices/[deviceId]/runs/[runId]/claim/route.ts`, `lib/computer/claim.ts`) and local computer authority (`lib/computer/local-authority.ts`).
  - Turning `computerUseEnabled` from `true` to `false` revokes active machine-authority runs on that device via `stopRunsForPolicyChange`.
- `source: 'device'`: distinguishes per-device policy from workspace settings inheritance.
- `migration` (`pro:blocked` on `#2936` item 7):
  ```json
  {
    "available": false,
    "reason": "machine_migration_not_supported",
    "preserves": ["repository_checkpoint"],
    "excludes": ["process_memory", "native_session", "ignored_files", "credentials"]
  }
  ```
  Repository checkpoints and single-task cloud snapshots exist for recovery, but live cross-device VM/daemon runtime transfer is owned by `#2936` item 7 and is not faked as an active toggle.

## 2. Device Repository Scope CRUD (Frames 15 / 44–46)

### Endpoints & Desktop RPC

- `GET /api/devices/:deviceId/repositories`
- `PUT /api/devices/:deviceId/repositories`
- `PATCH /api/devices/:deviceId/repositories`
- `DELETE /api/devices/:deviceId/repositories`
- Desktop RPC: `devices.listRepositories`, `devices.upsertRepository`, `devices.patchRepository`, `devices.deleteRepository`

### Authorization & Semantics

- Strictly **device-owner-only** (`devices.ownerId === caller`, non-PAT session); non-owners and workspace admins receive `403 workspaceAccessDenied`.
- Manages `device_repos` (`repoKey` / canonical `repoPath`, `remoteUrl`, `localPath`, `baseBranch`, `verifyCommand`).
- Deleting a repository referenced by an active thread run or non-ended thread machine returns `409 deviceHasActiveRuns`.

## 3. Billing Auto-Recharge & Financial Receipt Ownership (Frame 26)

### Endpoints & Desktop RPC

- `GET /api/workspaces/:workspaceId/billing/settings`
- `PUT /api/workspaces/:workspaceId/billing/settings` (alias `PATCH`)
- Also surfaced on `GET /api/workspaces/:workspaceId/billing` (`BillingView.receipts` & `BillingView.autoRecharge`)
- Desktop RPC: `billing.getBillingSettings(workspaceId?)`, `billing.saveAutoRechargePolicy(policy, workspaceId?)`

### Constraints & Ownership Verdicts

- **Auto-Recharge (`pro:blocked` on Stripe Managed Payments)**:
  - Validates `{ enabled, consent, expectedRevision, thresholdPoints, amountPoints: 1000 | 2500 | 5000, monthlyCapPoints }`.
  - Saving thresholds/caps with `enabled: false` succeeds for the billing account owner and records `billing.auto_recharge_changed`.
  - Requesting `enabled: true` returns `409` `{ error: "billingAutoRechargeUnavailable", state: "provider_unsupported", provider: "stripe_managed_payments" }` because Stripe Managed Payments (Merchant of Record) supports hosted Checkout/Payment Links only, not off-session `PaymentIntent` charging (`https://docs.stripe.com/payments/managed-payments#unsupported-integrations`).
- **Financial Email Receipts**:
  - `drizzle/20261110150012_billing_financial_receipts.sql` defines `billing_refund_receipts` for Stripe webhook refund reconciliation only; Mikka has zero receipt mailer.
  - Billing email delivery and invoice/receipt downloads are owned by Stripe Customer Portal / Stripe MoR (`lib/billing/management.ts`).
  - Billing settings expose `{ receiptsManagedBy: "stripe_portal", source: "provider" }` rather than storing an inert database toggle.

## 4. Workspace Ops Metrics Read Model (Frame 30)

- `GET /api/workspaces/:workspaceId/ops-metrics`
- Desktop RPC: `ops-metrics.getWorkspaceOpsMetrics(workspaceId?)`
- **Authorization**: active workspace `admin` only (`403` for members, suspended users, or cross-workspace callers).
- **Tenant-scoped payload** (never queries global `pg_database_size`):
  - `channels`: `onlineDevices`, `boundDevices` (devices bound to `workspaceId` via `device_project_checkouts`, `cloud_machines`, or live `thread_machines`), `slackInstallations`, `slackBindings`, `telegramBindings` (task threads bound to `workspaceId`), `activeBots`.
  - `storage`: `artifacts` (`count`, `versions`, `bytes` from `artifacts` + `artifact_versions`), `checkpoints` (`count`, `bytes` via `octet_length(run_checkpoints.patch)` joined to workspace `agent_runs`), `totalBytes`.
  - `queues`: `queuedRuns`, `runningRuns`, `pendingPublications`, `pendingScheduleOccurrences`, `queuedSubagents`, `runningSubagents`.

## 5. Usage Export & Environment Dimension (Frame 27)

- `GET /api/workspaces/:workspaceId/governance/usage?groupBy=environment` (JSON and `&format=csv`)
- Per `#2956` domain naming, Capy's "project" maps to Mikka **Environment** (`workspace_environments`), never a separate usage project concept.
- `USAGE_GROUP_BY` is `['day', 'model', 'member', 'repository', 'environment']` and `USAGE_SUBDIVISIONS` is `['member', 'repository', 'environment']`.
- Grouping by `environment` resolves `environmentId` from the run's frozen `projectExecution.environment.id` or `bots.environmentId` and hydrates `environmentName` from `workspace_environments` in the workspace database. Unattributed calls retain `environmentId: null, environmentName: null` so settled spend totals remain exact.
- `format=csv` includes `environmentId,environmentName` columns when `groupBy=environment` and omits unrequested subdivision columns otherwise.

## 6. Subagent Nesting Depth (Frame 18)

- Subagent nesting depth is **由执行端决定 (determined by execution runtime)** — there is no user/workspace configurable database setting:
  - Browser subagents (`lib/cloud-computer/subagents.ts`) operate as a 1-level `Bot -> bot_subagents` dispatch queue (up to 6 concurrent active browser slots per owner/workspace).
  - Thread run chains (`lib/run-chain.ts:25`) enforce the fixed recursion ceiling `RUN_CHAIN_MAX_DEPTH = 64`.
  - CLI harnesses (`claude_code`, `codex`, `cursor`) govern their own internal tool/subagent recursion inside the leased run boundary.

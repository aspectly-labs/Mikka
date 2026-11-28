# Epic #3076 real E2E acceptance plan (issue #3085, chain F)

Status: **preparation only**. The implementation PRs for epic #3076 (zero
residency chains A–E plus #3087, #3089, #3082, #3083, #3084) are still in
flight. Nothing on this page runs against staging yet; it maps every #3085
requirement to the lane that proves it, records the commands and receipt
formats, and lists the harness gaps that must exist before the acceptance
window opens.

Boundaries that apply to every row below:

- #1954 is the only production cutover, retirement and customer-data owner.
  This plan produces evidence and checklists; the owner executes and signs.
- #1934 owns provider billing and quota evidence. Billing API 401/403/delay is
  recorded as `unverified` with the time and endpoint, never filled with zero
  (per the 2026-11-11 #1954 decision).
- Company staging, production credentials and hosted runner enrollment live in
  the private mikka-cloud runbooks. This public page names interfaces only.
- Acceptance credentials stay in the secret store; probe values are read in
  process and never printed or committed (`scripts/ops/cf-zero-instance-probe.mjs`).

## Proof lanes

| Lane | What it is | Trust |
|---|---|---|
| (a) Engineering sandbox | `gh workflow run engineering-sandbox.yml --repo aspectly-labs/Mikka --ref main -f issue=3085 -f workload=<suite> -f sha=<40-hex>` on a committed main SHA. Immutable source fetch, isolated Cloudflare Container, OIDC-authenticated, artifact receipt retained 7 days. Suites: `factory-handoff`, `startup-timing`, `postgres-policy`. | Independent hosted run of the exact SHA |
| (b) Staging API/CLI | Real staging deployment exercised through the public API and CLI the same way `pnpm test:local-loop` drives the local stack (`scripts/dev-local/acceptance.mjs`, 11 items over HTTP + real daemon + scripted test model). Production/staging variants already exist under `scripts/acceptance/` (`*-production.mjs`, `team-workspace.mjs`, `cloud-lease-audit.mjs`, `work-domain-production.mjs`, `auth-audit-production.mjs`). | Real deployed behavior |
| (c) Gap | No existing harness; a new script, fixture or scheduled run is required before the window. Listed in [Gaps](#gaps). | — |

Evidence format for every row: a JSON receipt plus a short note committed to
`docs/operations/evidence/3085-<check>-<yyyymmdd>.{json,md}` containing
`{issue:3085, sha, runUrl|command, window:{from,to}, result, violations,
unverified}`. UI rows also attach local production-build screenshots per
`AGENTS.md` ("How changes are tested").

## Tooling delivered with this plan

`scripts/ops/cf-zero-instance-probe.mjs` — read-only Cloudflare container
residency probe (Node stdlib only).

```sh
# One-shot: per-app running counts, exit 1 on any non-exempt running/unverified app
node scripts/ops/cf-zero-instance-probe.mjs \
  --manifest cloudflare/zero-residency/manifest.json \
  [--secrets-file <json with CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID>] \
  [--out receipt.json] [--allow 'glob,...']

# Watch: JSONL evidence file, one sample per interval plus a window summary line
node scripts/ops/cf-zero-instance-probe.mjs --watch --interval 5 --duration 60 \
  --manifest cloudflare/zero-residency/manifest.json --out e2e/idle-window-<ts>.jsonl
```

- Credentials come from `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` in the
  environment or `--secrets-file`; the token is never printed. Application
  `configuration` (image, environment variables) is deliberately dropped — only
  allowlisted fields (`name`, `id`, `schedulingPolicy`, `maxInstances`,
  `running`, `runningBreakdown`, `placements`, `healthSummary`, `updatedAt`)
  reach the report.
- `running` sums the runtime-reported health counts (`active` + `assigned` +
  `starting`), which is the honest "container process is up" signal; the
  top-level `instances` placement count is kept separately because a sleeping
  placement outlives its container (this is why the CF0 capture counted 29
  "running" while the runtime probe sees them asleep).
- Manifest classification: `always-on-tracked` declarations (`mikka-eve-*`)
  and `--allow` globs are exempt; `undeclared` applications are counted and
  fail the gate when running. Any non-exempt app with `running>0` — or whose
  count cannot be verified — exits non-zero.
- `--watch` writes one `{type:"sample"}` JSONL line per interval and a
  `{type:"window"}` trailer with `samples`, `flaggedSamples`, `clean`.

First baseline (2026-11-21T23:12Z, read-only, this token/account): 31
applications, **27 at running=0**, 4 at running=1 — `mikka-api-{8a079f179722,
9bbe245ca19d,b53e8f369ff2}-…-businessapi` (production releases) and
`mikka-cloud-services-cloudservices`; zero undeclared, zero unverified.
Receipt: `/home/ubuntu/epic3076/e2e/zero-instance-baseline-20261121T231212Z.json`
(sanitized, not committed — it lives outside the repo; copy into
`docs/operations/evidence/` at acceptance time).

## Requirement → lane mapping

### R1 · Idle zero (`必测矩阵` 1)

Prove that with no work, no long-lived lease and all containers stopped,
Eve + API + Task compute reports running=0 over a continuous window.

| Step | Lane | Command / entry | Receipt |
|---|---|---|---|
| Confirm staging quiesced (no open runs/leases) | (b) | Staging API: list runs/tasks with active leases; `scripts/acceptance/cloud-lease-audit.mjs` pattern against the staging origin | lease-audit JSON: zero open leases |
| Continuous zero-instance window | (c→delivered) | `cf-zero-instance-probe.mjs --watch --interval 5 --duration <window> --out 3085-idle-<ts>.jsonl`; for a staging-scoped window, `--allow 'mikka-api-*,mikka-litellm,mikka-credential-broker-*,mikka-cloud-services-cloudservices'` exempts the production-serving names and still gates every staging/undeclared app | JSONL samples + `{type:"window",clean:true}` |
| Resource/billing over the same window | (b)+(c) | Cloudflare Analytics `containersUsageAdaptiveGroups` / `containersMetricsAdaptiveGroups` GraphQL for the window (query shape in [engineering-sandbox.md §Match a run to provider usage](engineering-sandbox.md)); Neon/R2/Queue metrics from provider dashboards | GraphQL JSON saved; `unverified` items listed when the analytics token is unavailable |
| Error/request metrics | (b) | `scripts/ops/monitor.mjs` SLI read + Workers observability events per app | zero unexpected 5xx/invocations during window |

Workers, Durable Objects, Queues, R2 and Neon are exempt managed/event
infrastructure (manifest `exempt` block), matching the #3085 definition —
"zero" applies to application container compute.

### R2 · Wake paths (`必测矩阵` 2) — each trigger must start compute and release it after completion

| Trigger | Lane | Entry | Gap |
|---|---|---|---|
| New Bot chat → reply | (b) | Staging API create thread + post message → reply observed; probe before/after | — |
| Continue existing thread | (b) | Same staging API on a parked thread | — |
| Cron schedule occurrence | (b)+(c) | `lib/schedules` contract + `cloudflare/suggestions-cron` worker; create a schedule on staging and observe `schedule_occurrences` claim → completion | G2: staging recipe for waiting a real cron window |
| Future timer (one-shot) | (b) | Due-timer workflow path (already event-driven, no resident consumer needed) | — |
| GitHub CI success/failure | (b)+(c) | `CI_WORKFLOW_RESULTS` queue + #1935 edge worker (HMAC verify + filters + DLQ, proven idempotent by chain-E #3098 PG tests 36/36); needs a real `workflow_run` delivery against a fixture repo on staging | G3: fixture repo + signed delivery recipe |
| Custom webhook | (b) | `lib/schedules` webhook endpoint on staging | — |
| Manual approval receipt | (b) | Existing approval endpoints; local coverage via `scripts/dev-local/factory-handoff-acceptance.mjs` + watchdog; staging run of the same flow | — |
| Provider/model retry | (b) | LiteLLM path wakes its managed container; observe queue retry → reply | — |
| Slack / Linear channel | (b)+(c) | `cloudflare/linear-sync` worker (exempt); Slack signed callback endpoint | G4: no scripted staging Slack/Linear round-trip today |
| Owned-device failover/recovery | (a) | `workload=factory-handoff` on the candidate SHA | — |

Every wake case ends with the same probe re-check that compute returned to
zero — the JSONL window doubles as the "released after completion" receipt.

### R3 · Five harness paths, factory mode + direct-mode regression (`必测矩阵` 3 + 2026-11-21 additions)

| Path | Local proof (lane a/b) | Staging proof (lane b) | Gaps |
|---|---|---|---|
| Cloud + Claude Code | `pnpm test:local-loop` items; `workload=startup-timing` for dispatch/CLI timing evidence on the exact SHA | Create task `cloud` + `claude_code` on staging → real branch, CLI/SDK fingerprint, tests, independent Review, CI, controlled PR, artifact; verify `permissionMode:"bypassPermissions"` + `allowDangerouslySkipPermissions` startup flags produce **zero tool-approval waits** end-to-end | G6: no single staging matrix driver |
| Cloud + Codex | same local lanes | Same flow with `codex`; verify `approvalPolicy:"never"` + `sandbox:"danger-full-access"`, zero approvals incl. Factory review-fix cycles | G6 |
| Device + Claude Code | `workload=factory-handoff` (device failover/recovery), daemon acceptance items | Enrolled real device on staging daemon channel; run factory task on-device; verify identical native flags and resume across disconnect | G7: staging device enrollment recipe + subscription custody is owned by the native gates (`e2b-official-runtime.yml` subscription tasks), not this plan |
| Device + Codex | same | same, Codex App Server flags | G7 |
| Third-party Eve factory | chain-A1 `EVE_WAKE` buffer tests (37/37), adapter contract tests once #3082 merges | Factory task routed `factory-eve`/third-party provider → Foreman classify→analyse→implement→independent-review against the real CF sandbox; reviewer rejection → original implementer fix → re-review on new SHA; verifier/approval/publish stay Mikka-owned | G8: staging third-party provider credential via Credential Broker + adapter not merged; Eve CF residency still `always-on-tracked` until #3078 deploys |

Reviewer rejection→fix→re-review and CI-failure→wake-same-thread are explicit
#3085 requirements; they run once per path on staging, plus the negative cases
(cross-workspace/repo denial, reviewer may not merge, revoked task identity —
the #3089 Capy-parity additions).

### R4 · Failure matrix (`必测矩阵` 4)

| Case | Lane | Entry |
|---|---|---|
| Cold-start jitter / dispatch timing | (a) | `workload=startup-timing` — dispatch, runtime and native CLI timing evidence on the exact SHA |
| Migration/CLI policy rollback | (a) | `workload=postgres-policy` — fresh PG17 cluster, real migration, trigger + rollback verification |
| 50/100 concurrent requests | (c) | G9: staging load harness; task-sandbox `TaskCapacity`/`WORKSPACE_MACHINES` admission tests exist — the live 50/100 burst against staging needs a scripted driver and ops sign-off |
| Work queue redelivery / dup | (a)+(b) | #3098 idempotency PG suite (36/36); DLQ replay on staging | G10: DLQ replay is an ops action, needs authorized window |
| Neon/Queue short outage | (b)+(c) | `scripts/ops/recovery-failures.test.mjs` covers classification; live fault injection on staging needs the private ops runbook | G11 |
| Container force-kill mid-run | (b)+(c) | Stopping a CF instance is a write — allowed only inside the declared acceptance window; lease/alarm recovery proven by task-sandbox unit+`factory-handoff` | G12 |
| R2 snapshot lost/expired | (b)+(c) | Snapshot TTL/restore tests exist in task-sandbox; destructive loss drill needs fixtures + authority | G12 |
| Eve version upgrade | (b)+(c) | #3078 deploy sequence (PR #3103 stacked on #3068 eve-1.3.0); upgrade-interleave run needs two deployed releases | G13 |
| Old/new release interleave | (b) | Already observable: three production `businessapi` releases report running=1 today; the matrix requires a defined current+previous pair, not residue | — |

No session loss, no double-write, no cross-tenant bleed is asserted by the
existing idempotency/ACL suites; live re-verification rides on each case above.

### R5 · Billing (`必测矩阵` 5)

| Item | Lane | Entry |
|---|---|---|
| Per-run container CPU/RAM/disk | (a) receipt + (b) analytics | Engineering-sandbox artifact (`providerInstanceId`, `requestedAt→stoppedAt`, cgroup counters) joined to `containersUsageAdaptiveGroups` |
| Request/CPU, Queue, DO, R2, Neon | (b)+(c) | Provider analytics/dashboard export; `scripts/ops/migration-usage.mjs` processes FOCUS-style billing rows when an export exists |
| Model cost per factory run | (b) | Model-gateway ledger (`lib/model-gateway/ledger.ts`) usage rows per run |
| "No task → no container compute charge" | (b) | Zero-instance window receipt joined to the same billing window — proves container line drops to zero while Workers/Neon/R2 baseline persists |
| Oracle + old-Vercel baseline compare | (b)+(c) | Existing baselines: `cloudflare/zero-residency/baseline-2026-11-21.json` (CF), Oracle `docker ps` capture, Vercel per #1951 | G14: Vercel/CF billing export access; unverifiable items recorded, not zeroed |

### R6 · Security (`必测矩阵` 6)

| Item | Lane | Entry |
|---|---|---|
| Credential broker / scoped secrets | (b) | Existing broker suites + `scripts/acceptance/task-secrets-*.mjs`; run-scoped grant seal per AGENTS.md credential boundary |
| Tenant/repo ACL | (a)+(b) | `factory-handoff` + ACL suites; staging cross-workspace negative probes (`auth-audit-production.mjs` pattern) |
| CI webhook raw signature | (a)+(b) | #3098 HMAC verification tests; live signed delivery via G3 fixture |
| Idempotency / replay | (a)+(b) | #3098 PG idempotency proof; replayed deliveries → dedupe → DLQ |
| No secrets in logs | (b)+(c) | Probe/report formats keep allowlists; G15: staging log scan for secret patterns across the run receipts |
| Production cutover/signing/customer data | out of scope here | #1954 owner only |

### R7 · UI evidence (issue #3084, feeds #3085)

| Item | Lane | Entry |
|---|---|---|
| One-UI factory thread: stage track, evidence, reviewer verdict, cost, PR, approval action | (b) local | After #3084 merges: `pnpm build && pnpm start` local production build; API/CLI click→ACK→read-back over a real factory thread; screenshots attached to the PR per AGENTS.md |
| Cross-device/narrow/empty/failure states | (b) local | Screenshot matrix incl. dark/light + keyboard/screen-reader pass |
| Zero tool-approval UI | (b) | Assert no permission card/sheet state exists on native paths (source check + real run) |

### R8 · Safe retirement (issue #3085 交付 + 验收)

| Item | Lane | Entry |
|---|---|---|
| Oracle Eve relay / VM | (b)+(c) | Checklist: `docker ps` on the Oracle host (`mikka-eve-prod` :8081, `mikka-eve-staging` :8080), cloudflared tunnel → `mikka-eve-relay-prod`, Graphile shared-PG consumers must show zero Mikka consumers before power-down | G16: retirement itself is #1954-executed |
| Old release-pinned CF apps | (b) | Manifest `retire-under-#1954` entries; probe receipts + serving-release verification before owner retires each | #1954 executes |
| Rollback drill | (b)+(c) | Re-point staging to previous release inside the window; record manifest/SHA/actions-run/deployment/rollback lines per protected release | G17 |
| 24h/7d monitoring | (c) | Scheduled probe `--watch` runs post-window; **7-day data is claimed only after 7 real days** | — |

## Gaps

- **G1** `eve-host-build` is documented in engineering-sandbox.md but is **not**
  in `jobs.mjs` or the `workflow_dispatch` choice list on main — only
  `factory-handoff`, `startup-timing`, `postgres-policy` dispatch today.
  Either the hosted worker is newer (verify with private ops) or the workload
  is not dispatchable from this repo.
- **G2** Staging cron/timer wait recipe (real occurrence window, not mocked).
- **G3** GitHub `workflow_run` fixture repo + real signed delivery on staging
  for CI success/failure wake.
- **G4** Scripted Slack/Linear staging round-trip.
- **G5** `ENGINEERING_SANDBOX_URL` is not set as a repo Actions variable on
  `aspectly-labs/Mikka` (checked 2026-11-21; org scope not enumerable). A
  dispatch today would run `test`/`postgres_image` then fail `run` at endpoint
  parsing. Hosted enrollment is owned by private ops — confirm/set before the
  window.
- **G6** Staging harness-path matrix driver: one command that runs the five
  paths and emits the coverage-matrix receipt does not exist yet.
- **G7** Staging device enrollment + subscription custody for local-harness
  acceptance; native subscription gates (`e2b-official-runtime.yml`) own the
  custody rules — coordinate, do not duplicate.
- **G8** Third-party provider credential for the Eve factory staging path via
  Credential Broker; also blocked on #3082 merge.
- **G9** Staging concurrency load driver (50/100) + ops sign-off.
- **G10** Authorized DLQ replay window.
- **G11** Staging fault-injection authority (Neon/Queue brownout).
- **G12** Container force-kill / R2-loss destructive drills — write actions,
  inside the declared window only.
- **G13** Eve upgrade interleave needs two deployed releases (#3078 deploy).
- **G14** Vercel/CF billing export access for the cost comparison; record
  `unverified` on 401/403.
- **G15** Staging secret-in-logs scan across receipts.
- **G16** Oracle retirement execution — checklist only; #1954 owner executes.
- **G17** Rollback drill window inside the acceptance schedule.

## Engineering sandbox dispatch readiness (dry-checked 2026-11-21, not dispatched)

- Workflow `Cloudflare engineering sandbox` exists on `aspectly-labs/Mikka`,
  id `414964162`, state `active`; `workflow_dispatch` inputs `issue`
  (number), `sha` (40-hex), `workload` (choice).
- `gh` token holds the `workflow` scope; the workflow file pins
  `contents:read` + `id-token:write` and the run job refuses non-main refs and
  non-dispatch events.
- Not dispatchable to a successful run today: see G5 (missing
  `ENGINEERING_SANDBOX_URL`) — private ops owns the hosted endpoint per
  [engineering-sandbox.md](engineering-sandbox.md) and the private runbook.

## Execution order when the window opens

1. Merge record: exact SHAs of every epic child PR + actions runs (R-evidence).
2. Local gates green: `pnpm test:local-loop`, sandbox dispatches for
   `factory-handoff`, `startup-timing`, `postgres-policy` on the candidate SHA.
3. Staging deploy of the candidate; `cloud-lease-audit` + first probe → idle
   pre-check.
4. `--watch` idle window (R1) → wake-trigger matrix (R2) → five-path matrix
   (R3) → failure cases (R4) → billing join (R5) → security negatives (R6).
5. UI evidence (R7) → retirement checklist + rollback drill (R8) →
   post-window 24h/7d probes.

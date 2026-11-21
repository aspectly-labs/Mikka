# CF0 零常驻运行态基线（#3077）

Evidence: Cloudflare API read-only snapshot, account `d8f6630c…`, taken 2026-11-21T22:40Z by Devin. Machine-readable twin: `cloudflare/zero-compute/baseline.json`; replayable guard: `scripts/cf-baseline-check.mjs`. Numbers marked **UNVERIFIED** were not observable via the API (billing/dashboard-only). Exact per-release instance names and placements are deliberately kept out of product source (company-hosted operations are private, AGENTS.md); the manifest owns the fleet by naming patterns + counts instead.

## 1. 服务矩阵（service × release × env × status × data authority × wake entry × idle policy × owner）

| Service | Release model | Env | Instances at snapshot | Data authority | Wake entry | Idle policy (code-verified) | Owner / next issue |
|---|---|---|---|---|---|---|---|
| mikka-api-* (10 prod / 14 staging workers + container apps) | release-per-worker + container app per release | prod/staging | **9 prod + 10 staging containers warm** | Neon PG via API | HTTP via mikka-app-gateway + workers domains | `BusinessApi.sleepAfter='5m'` (`cloudflare/api/ingress/worker.mjs:12`) — sleeps when idle; snapshot warmth ≠ always-on | CF1 #3078 / CF2 #3079 |
| mikka-app-release-* (20 prod / 12 staging) | release-per-worker | prod/staging | worker only | static/release assets | HTTP | event-driven worker — already scale-to-zero | none |
| mikka-eve-* (9 prod / 2 staging) | worker + DO world + Oracle-side eve-runtime | prod | worker only on CF | DO namespaces + queues; Oracle Eve via mikka-eve-relay-prod | HTTP/queue | CF side event-driven; **Oracle eve-runtime host never idles** — `onActivityExpired(){}` no-op, `onStop` auto-restarts unless release-pinned `stopForOwner` flag (`cloudflare/eve-runtime/src/index.mjs`) | CF1 #3078 (links #1918/#1946) |
| mikka-business-world / mikka-eve-world | worker + DO (Authority/Stream/QueueClaim) + events queues | prod/staging | worker only | DO + queues mikka-*-world-events/-control/-dead | queue + HTTP | event-driven | CF1 #3078 |
| mikka-cloud-services | worker + DO + container app + outbox queue | prod | **1 container warm** (sjc01) | DO CloudServices + outbox queue | HTTP + queue consumer | **UNVERIFIED** — container class source is in the service repo, not this one; warm at snapshot | CF2 #3079 |
| mikka-task-sandbox | worker + container app + TaskMachine/TaskCapacity DO | prod/staging | **0 instances** — already idle-zero | DO + sandbox R2 | HTTP/grant path | per-task lifecycle | reuse in CF3 #3080 (proves pattern exists) |
| mikka-litellm | worker + container app | prod/staging | **1 prod + 1 staging warm** | none (proxy) | HTTP | `LiteLlm.sleepAfter='5m'` (`cloudflare/litellm/worker.mjs:10`) — sleeps when idle | CF2 #3079 (wake latency on model calls) |
| mikka-credential-broker | worker + container app + DO | prod/preview | 0 instances | DO | HTTP | idle-zero already | none |
| mikka-device-gateway | worker + DeviceSession DO | prod | worker only | DO | WS via DO | event-driven | none |
| mikka-suggestions-cron | worker | prod | worker only | cron schedule | Cron | event-driven | CF6 #3083 |
| mikka-ci-* | worker + events queue | prod/staging | worker only | queue | GitHub webhook | event-driven | CF6 #3083 (links #1935) |
| mikka-linear-sync | worker | prod/preview | worker only | Linear webhook | HTTP | event-driven | none |
| mikka-marketing*, mikka-hosted-ui, mikka-cloud, mikka-app-gateway, mikka-legacy-301, aspectlylabs-proxy, orvilo-* | workers | prod/preview | worker only | — | HTTP | event-driven | mikka-legacy-301 retire decision → CF2 #3079 (safe-drain owner) |

## 2. 活跃/孤儿消费者

- All live `*-events`/`-control`/`-outbox` queues: exactly 1 consumer, 1 producer; all `*-dead`/`-dlq` queues: 0 consumers. **No orphan consumers found.**
- 22 container instances were warm at snapshot: 9 prod `mikka-api`, 10 staging `mikka-api`, `mikka-litellm` prod+staging, `mikka-cloud-services` prod. Each maps to an existing release — none unattributed. Because `BusinessApi`/`LiteLlm` declare `sleepAfter='5m'`, warm-at-snapshot does **not** prove they stay up while idle; the only code-proven never-idle runtime is the Oracle-side `eve-runtime` host (§4).
- Several staging `mikka-api` apps and both `mikka-task-sandbox`/`mikka-credential-broker` apps have applications with 0 instances (already drained or never placed).

## 3. 负载/成本基线

- Container fleet: 31 applications, 22 with ≥1 warm instance at snapshot. Per-instance class **UNVERIFIED**.
- Billing (memory/CPU/disk $, per-day request/wake frequency): **UNVERIFIED — not exposed via the API paths used**; needs Cloudflare dashboard/billing export or GraphQL analytics. Zero is not claimed anywhere.
- Residual idle cost risk today concentrates in the Oracle-side `eve-runtime` host (never idles) and `mikka-cloud-services` (idle policy unverified); CF container classes already sleep after 5 idle minutes by declaration.

## 4. 零常驻障碍 → 子 issue 归属

1. `cloudflare/eve-runtime/src/index.mjs` — `onActivityExpired(){}` is an intentional no-op ("Postgres queue workers need the server while no HTTP requests arrive"), and `onStop()` restarts the server unless `storage.stopped` was set through release-pinned `stopForOwner`. This runtime backs the `eve` service (`config/service-build-inputs.json` → `services/eve`) on Oracle-side infrastructure, fronted by `mikka-eve-relay-*`. → CF1 #3078 (wake/recover contract), CF2 #3079 (stop on completion).
2. Release-per-container fleet: each `mikka-api` release spawns an application; declared `sleepAfter='5m'` bounds idle cost, but safe-drain/retirement of old releases stays with the release pipeline (#1954). → CF2 #3079.
3. mikka-cloud-services container idle policy unverified + its outbox queue consumer. → CF2 #3079.
4. API/Better Auth/stream entry points not yet scale-to-zero-safe (wake path design needed). → CF1 #3078 contract, CF2 #3079 ingress.
5. mikka-task-sandbox and credential-broker already demonstrate idle-zero (0 instances) — pattern to reuse, not rework (links #1936, CF3 #3080).

## 5. Guard

`scripts/cf-baseline-check.mjs` replays the inventory: `--offline` validates manifest integrity (ownership patterns compile, warm-instance breakdown sums to its declared total); live mode (CF_API_TOKEN, paginated) fails on any container application or queue not matching the manifest's ownership patterns, and on a live queue with no consumer. Wire into release CI so a future release cannot add an unattributed always-on instance.

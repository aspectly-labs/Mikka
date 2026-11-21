# CF0 零常驻运行态基线（#3077）

Evidence: Cloudflare API read-only snapshot, account `d8f6630c…`, taken 2026-11-21T22:40Z by Devin. Machine-readable twin: `cloudflare/zero-compute/baseline.json`; replayable guard: `scripts/cf-baseline-check.mjs`. Numbers marked **UNVERIFIED** were not observable via the API (billing/dashboard-only).

## 1. 服务矩阵（service × release × env × status × data authority × wake entry × stop condition × owner）

| Service | Release model | Env | Live instances | Data authority | Wake entry | Stop condition today | Owner / next issue |
|---|---|---|---|---|---|---|---|
| mikka-api-* (10 prod / 14 staging workers + container apps) | release-per-worker + container app per release | prod/staging | **9 prod + 11 staging containers running** | Neon PG via API | HTTP via mikka-app-gateway + workers domains | `onActivityExpired(){}` no-op — never idles; `onStop` auto-restarts unless `stopForOwner` flag set | CF1 #3078 / CF2 #3079 |
| mikka-app-release-* (20 prod / 12 staging) | release-per-worker | prod/staging | worker only (no container app) | static/release assets | HTTP | event-driven worker — already scale-to-zero | none |
| mikka-eve-* (9 prod / 2 staging) | worker + DO world | prod | worker only | DO namespaces + queues | HTTP/queue | event-driven | CF1 #3078 (links #1918/#1946) |
| mikka-eve-relay-prod/staging | worker pair | prod/staging | worker only | Oracle Eve relay | HTTP | event-driven; relay upstream UNVERIFIED | CF1 #3078 |
| mikka-business-world / mikka-eve-world | worker + DO (Authority/Stream/QueueClaim) + events queues | prod/staging | worker only | DO + queues mikka-*-world-events/-control/-dead | queue + HTTP | event-driven | CF1 #3078 |
| mikka-cloud-services | worker + DO + container app + outbox queue | prod | **1 container running** (sjc01) | DO CloudServices + outbox queue | HTTP + queue consumer | always-on container | CF2 #3079 |
| mikka-task-sandbox | worker + container app + TaskMachine/TaskCapacity DO | prod/staging | **0 instances** — already idle-zero | DO + sandbox R2 | HTTP/grant path | per-task lifecycle | reuse in CF3 #3080 (proves pattern exists) |
| mikka-litellm | worker + container app | prod/staging | **1+1 running** | none (proxy) | HTTP | always-on | CF2 #3079 (wake latency on model calls) |
| mikka-credential-broker | worker + container app + DO | prod/preview | 0 instances | DO | HTTP | idle-zero already | none |
| mikka-device-gateway | worker + DeviceSession DO | prod | worker only | DO | WS via DO | event-driven | none |
| mikka-suggestions-cron | worker | prod | worker only | cron schedule | Cron | event-driven | CF6 #3083 |
| mikka-ci-* | worker + events queue | prod/staging | worker only | queue | GitHub webhook | event-driven | CF6 #3083 (links #1935) |
| mikka-linear-sync | worker | prod/preview | worker only | Linear webhook | HTTP | event-driven | none |
| mikka-marketing*, mikka-hosted-ui, mikka-cloud, mikka-app-gateway, mikka-legacy-301, aspectlylabs-proxy, orvilo-* | workers | prod/preview | worker only | — | HTTP | event-driven | mikka-legacy-301 retire decision → CF2 #3079 (safe-drain owner) |

## 2. 活跃/孤儿消费者

- All live `*-events`/`-control`/`-outbox` queues: exactly 1 consumer, 1 producer; all `*-dead`/`-dlq` queues: 0 consumers. **No orphan consumers found.**
- 22 running container instances total at evidence time: 9 prod `mikka-api`, 11 staging `mikka-api`, `mikka-litellm` prod+staging, `mikka-cloud-services` prod. Each maps to an existing release — none unattributed, but **none is zero**: `eve-runtime` keeps them alive deliberately (see §4). Old releases' instances count as serving only via their own release routes; retire owner = release pipeline (#1954), not this audit.
- `mikka-api-603d1d95f026` prod and 4 staging apps have applications with 0 instances (already drained or never placed).

## 3. 负载/成本基线

- Container fleet: 30 applications, 22 with ≥1 instance at snapshot. Per-instance class **UNVERIFIED** (needs `containers/applications/{id}` detail per app — recorded per-app only where location returned).
- Billing (memory/CPU/disk $, per-day request/wake frequency): **UNVERIFIED — not exposed via the API paths used**; needs Cloudflare dashboard/billing export or GraphQL analytics. Zero is not claimed anywhere.
- Idle cost floor today: every running `mikka-api`/`litellm`/`cloud-services` instance bills while idle because nothing ever stops it.

## 4. 零常驻障碍 → 子 issue 归属

1. `cloudflare/eve-runtime/src/index.mjs` — `onActivityExpired(){}` is an intentional no-op ("Postgres queue workers need the server while no HTTP requests arrive"), and `onStop()` restarts the server unless `storage.stopped` was set through release-pinned `stopForOwner`. Postgres Graphile Worker + queue consumers keep containers live. → CF1 #3078 (wake/recover contract), CF2 #3079 (stop on completion).
2. Release-per-container fleet: each `mikka-api` release spawns an application that stays up forever; safe-drain path is `stopForOwner` + release retirement, owned by the release pipeline (#1954). → CF2 #3079.
3. mikka-cloud-services + mikka-litellm singleton containers always on. → CF2 #3079.
4. API/Better Auth/stream entry points not yet scale-to-zero-safe (wake path design needed). → CF1 #3078 contract, CF2 #3079 ingress.
5. mikka-task-sandbox and credential-broker already demonstrate idle-zero (0 instances) — pattern to reuse, not rework (links #1936, CF3 #3080).

## 5. Guard

`scripts/cf-baseline-check.mjs` replays the inventory: `--offline` validates manifest integrity; live mode (CF_API_TOKEN) fails on any container application or queue not owned by `baseline.json`, and on a live queue with no consumer. Wire into release CI so a future release cannot add an unattributed always-on instance.

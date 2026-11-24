# Zero-residency baseline (CF0, issue #3077)

Point-in-time inventory of Mikka-owned compute residency for epic #3076
(Cloudflare zero-residency + Eve Software Factory). Captured 2026-11-21 by a
read-only Cloudflare API application list
(`GET /client/v4/accounts/{account}/containers/applications`) plus an
`ssh`/`docker ps` observation of the Oracle host on the same day. No
application was written, stopped or deleted; secret values were not retained.

Machine-readable form: [`cloudflare/zero-residency/manifest.json`](../../cloudflare/zero-residency/manifest.json)
with the sanitized capture in
[`baseline-2026-11-21.json`](../../cloudflare/zero-residency/baseline-2026-11-21.json).
The contract check `pnpm test:zero-residency`
(`cd cloudflare/zero-residency && npx vitest run`) fails when a container
declaration appears without an owned manifest entry.

## Findings

- 31 Cloudflare container applications exist; 29 use the `default` scheduling
  policy and 2 (`mikka-task-sandbox`, `mikka-task-sandbox-staging`) use
  `durable_object` and are already on-demand.
- 29 applications reported one running instance at capture. Per-app running
  fields were dropped during sanitization; which releases were awake for
  traffic vs. residue is **unverified**.
- Every `default`-policy business container class already sets
  `sleepAfter = '5m'` (BusinessApi, LiteLlm, CredentialBrokerRuntime — verified
  in source; Cloud Services lives in the private repository, unverified).
  Sleeping instances do not retire the per-release application objects: 23
  release-pinned `mikka-api-*-businessapi` applications across 13 releases are
  retained residue.
- The CF `EveRuntime` container is always-on by code:
  `onActivityExpired(){}` and `onStop()` restarts it
  (`cloudflare/eve-runtime/src/index.mjs`). No `mikka-eve-*` application was in
  the inventory; production Eve is the Oracle VM behind
  `mikka-eve-relay-prod`, reached through the cloudflared tunnel to
  `pdf.nebula-spaces.com`.
- API→Eve deliveries (`MIKKA_EVE_ORIGIN`) have no wake path; the Graphile
  PostgreSQL queue consumer needs a live Node process. #3078 owns the
  event-driven adapter (existing business-world queue,
  `BusinessWorkflowDelivery`, due-timer workflows and the
  `CI_WORKFLOW_RESULTS` queue are the available machinery).
- Workers, Durable Objects, Queues, R2 buckets and Neon PostgreSQL are managed
  event/persistence services — the zero-residency target is application
  container compute, not this layer.

## Matrix

Mode values come from the manifest: `on-demand`, `managed` (sleepAfter),
`retire-under-#1954`, `always-on-tracked`, `event-infra`.

### Release-pinned API applications (23 apps, `default` policy, max 1)

Owner: #3079 (on-demand API hosting); retirement executed only by #1954. Each
keeps Neon as data authority; wake entry is its ingress Worker / Durable
Object; instance stops 5m after last activity; the application object persists
until the release owner retires it.

| Application | Release | Env | Status | Mode |
|---|---|---|---|---|
| mikka-api-9bbe245ca19d-44834900850-1-businessapi | 9bbe245ca19d | production | running=1 at capture | retire-under-#1954 (unless current serving release — unverified) |
| mikka-api-staging-9bbe245ca19d-44834900850-1-businessapi | 9bbe245ca19d | staging | running=1 at capture | retire-under-#1954 |
| mikka-api-staging-603d1d95f026-44824274619-1-businessapi | 603d1d95f026 | staging | running=1 at capture | retire-under-#1954 |
| mikka-api-514b921155ad-44716198689-1-businessapi | 514b921155ad | production | running=1 at capture | retire-under-#1954 |
| mikka-api-staging-514b921155ad-44716198689-1-businessapi | 514b921155ad | staging | running=1 at capture | retire-under-#1954 |
| mikka-api-staging-db3a09d802a6-44082264453-1-businessapi | db3a09d802a6 | staging | running=1 at capture | retire-under-#1954 |
| mikka-api-b53e8f369ff2-44044113013-2-businessapi | b53e8f369ff2 | production | running=1 at capture | retire-under-#1954 |
| mikka-api-staging-b53e8f369ff2-44044113013-2-businessapi | b53e8f369ff2 | staging | running=1 at capture | retire-under-#1954 |
| mikka-api-staging-b53e8f369ff2-44044113013-1-businessapi | b53e8f369ff2 | staging | running=1 at capture | retire-under-#1954 |
| mikka-api-2f673b389adc-44023934484-2-businessapi | 2f673b389adc | production | running=1 at capture | retire-under-#1954 |
| mikka-api-staging-2f673b389adc-44023934484-2-businessapi | 2f673b389adc | staging | running=1 at capture | retire-under-#1954 |
| mikka-api-9a655d49e2ef-43951706221-1-businessapi | 9a655d49e2ef | production | running=1 at capture | retire-under-#1954 |
| mikka-api-staging-9a655d49e2ef-43951706221-1-businessapi | 9a655d49e2ef | staging | running=1 at capture | retire-under-#1954 |
| mikka-api-3f7eaa6042d0-43798137072-6-businessapi | 3f7eaa6042d0 | production | running=1 at capture | retire-under-#1954 |
| mikka-api-staging-3f7eaa6042d0-43798137072-6-businessapi | 3f7eaa6042d0 | staging | running=1 at capture | retire-under-#1954 |
| mikka-api-d59c85cb321b-43659450248-1-businessapi | d59c85cb321b | production | running=1 at capture | retire-under-#1954 |
| mikka-api-staging-d59c85cb321b-43659450248-1-businessapi | d59c85cb321b | staging | running=1 at capture | retire-under-#1954 |
| mikka-api-ac9013c6d7e1-43574093174-1-businessapi | ac9013c6d7e1 | production | running=1 at capture | retire-under-#1954 |
| mikka-api-staging-ac9013c6d7e1-43574093174-1-businessapi | ac9013c6d7e1 | staging | running=1 at capture | retire-under-#1954 |
| mikka-api-staging-ae2060e75032-43527060735-1-businessapi | ae2060e75032 | staging | running=1 at capture | retire-under-#1954 |
| mikka-api-8a079f179722-43403712785-1-businessapi | 8a079f179722 | production | running=1 at capture | retire-under-#1954 |
| mikka-api-staging-8a079f179722-43403712785-1-businessapi | 8a079f179722 | staging | running=1 at capture | retire-under-#1954 |
| mikka-api-staging-d8b0f3ff8dd4-43368604374-1-businessapi | d8b0f3ff8dd4 | staging | running=1 at capture | retire-under-#1954 |

Which single release currently serves production is an unverified private
operations fact; the current serving release stays `managed` until #3079 and
is excluded from retirement.

### Service applications (6 apps, `default` policy, max 1)

| Application | Env | Status | Data authority | Wake entry | Stop condition | Mode | Owner |
|---|---|---|---|---|---|---|---|
| mikka-litellm | production | running=1 at capture | none (stateless gateway) | LITELLM service binding / DO | sleepAfter 5m | managed | #3079 |
| mikka-litellm-staging | staging | running=1 at capture | none | same | sleepAfter 5m | managed | #3079 |
| mikka-cloud-services-cloudservices | production | running=1 at capture | private services | private deployer | sleepAfter (unverified) | managed | #3079 + private ops |
| mikka-cloud-services-staging-cloudservices | staging | running=1 at capture | private services | private deployer | sleepAfter (unverified) | managed | #3079 + private ops |
| mikka-credential-broker-credentialbrokerruntime | production | running=1 at capture | credential identity (private) | CREDENTIAL_BROKER service binding | sleepAfter 5m | managed | #3079 |
| mikka-credential-broker-preview-credentialbrokerruntime | preview | running=1 at capture | credential identity (private) | CREDENTIAL_BROKER service binding | sleepAfter 5m | managed | #3079 |

### On-demand applications (2 apps, `durable_object` policy)

| Application | Env | Data authority | Wake entry | Stop condition | Mode | Owner |
|---|---|---|---|---|---|---|
| mikka-task-sandbox | production | R2 `mikka-task-workspaces` + DO storage | TaskMachine DO alarm / claim | lease expiry, machine stop, alarm sweep | on-demand | #3080 |
| mikka-task-sandbox-staging | staging | same | same | same | on-demand | #3080 |

### In-repo declarations without a deployed app at capture

| Declaration | Class | Mode | Owner | Evidence |
|---|---|---|---|---|
| cloudflare/eve-runtime/wrangler.jsonc | EveRuntime | always-on-tracked | #3078 | `onActivityExpired(){}`, `onStop` restarts (src/index.mjs); in-flight candidate behind PR #3068 |
| cloudflare/engineering-sandbox/wrangler.jsonc | EngineeringRun | on-demand | #1948 | `durable_object` policy; runs only during authorized engineering acceptance |

### Oracle host (this machine), observed 2026-11-21

| Container | Port | Status | Data authority | Wake entry | Stop condition | Owner |
|---|---|---|---|---|---|---|
| mikka-eve-prod | 127.0.0.1:8081->8080 | always-on, 0.00% CPU idle, ~288MiB RSS, ~20s PostgreSQL queue poll, 2 DB connections | Neon (Eve World/queue) | none — requires live process; #3078 wake path | retirement only by #1954 after #3078 cutover | #3078 / #1954 |
| mikka-eve-staging | 127.0.0.1:8080->8080 | always-on, 0.00% CPU idle, ~186MiB RSS | Neon | none | same | #3078 / #1954 |
| cloudflared tunnel | — | always-on | — | n/a | retired with the relay by #1954 | #1954 |

### Event/persistence layer (exempt, `event-infra`)

| Service | Role |
|---|---|
| packages/eve-cloudflare-world (`mikka-eve-world`) | Eve World authority/stream Durable Objects; no containers[] |
| cloudflare/device-gateway | Worker + DOs, device signalling |
| cloudflare/linear-sync (retired 2026-11-24) | Worker, Linear webhooks |
| cloudflare/suggestions-cron | Worker Cron |
| business-world queue, CI_WORKFLOW_RESULTS queue, due-timer workflows | existing event-driven wake machinery reused by #3078/#3083 |
| R2 `mikka-task-workspaces` | task sandbox persistence |
| Neon PostgreSQL | system data authority; not application compute |

## Gaps handed to follow-up issues

| Gap | Owner |
|---|---|
| No wake path for API→Eve deliveries; Graphile consumer requires live Node | #3078 |
| CF EveRuntime always-on by code; keepalive removal behind PR #3068 | #3078 (coordinate, do not parallel-edit) |
| 23 release-pinned API applications are residue; safe drain + retirement | #3079 design, #1954 execution |
| Cold-start SLO for BusinessApi / LiteLlm / broker paths | #3079 |
| Per-app running instances and billing were sanitized out of the capture; a fresh metered read is needed for cost numbers | #3085 (unverified here) |
| The plaintext-secret incident in the first capture was sanitized 2026-11-21; rotation review tracked here | #3077 matrix |

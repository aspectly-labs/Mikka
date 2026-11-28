# Cloudflare Eve host

The Node 24 image runs the Nitro server produced by Eve `1.3.0` from
`apps/eve`. The agent selects `@workflow/world-postgres` `5.4.1` when
`WORKFLOW_TARGET_WORLD=@workflow/world-postgres`. PostgreSQL stores sessions and Graphile
Worker processes their queued work inside the Eve server. Task sandbox ownership
and reclamation belong to the Sandbox Provider.

## Build and initialize

In cloud Linux with Docker, Node 24 and frozen dependencies installed, run:

```sh
pnpm check:eve-image
```

The same command runs in the existing Eve pull request image job. It checks the
model, Stop and packaging contracts before compilation, builds Eve and its shared
resources once with network access disabled, then builds a local Docker image.
It verifies that exact image ID against the resource manifest, source and
Postgres World metadata, its non-root startup configuration and entry syntax.
It sends no provider request and does not publish an image. Starting the real
server and its health route requires an isolated PostgreSQL World; this command
does not establish live model or Stop acceptance.

Use the protected public GitHub Actions Eve image workflow for publication. Its
Node build selects `NITRO_PRESET=node-server` and
`WORKFLOW_TARGET_WORLD=@workflow/world-postgres`, then packages the compiled output with
`node scripts/package-cf-eve-host.mjs`. The image starts that output with
`node eve/server/index.mjs` on port `8080`.

Before the first start and each Postgres World package upgrade, run the official
bootstrap command from the installed application workspace with the target
`WORKFLOW_POSTGRES_URL` supplied by the deployment secret manager.

```sh
pnpm --filter @mikka/eve exec bootstrap
```

Bootstrap installs the workflow schema and Graphile Worker migrations. The
command needs the installed package, including its `src/drizzle/migrations`
assets. The application image contains the compiled server output.

## Configure runtime delivery

The Container receives deployment settings through the existing `EVE_ENV_`
configuration mapping. Supply `EVE_ENV_WORKFLOW_POSTGRES_URL` for its workflow
database. The package also supports `DATABASE_URL`. Continue supplying the
existing application database, authentication and provider settings through the
same secret delivery path.

The official package supports `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` and
`WORKFLOW_POSTGRES_MAX_POOL_SIZE`. Its documented defaults are `50` workers and
`10` pool connections. Size the pool for the selected concurrency and database
connection limit. Eve's guide recommends at least concurrency plus two
connections.

The repository pins a Graphile Worker patch that disables idle job-claim polling
for `pollInterval: 0`: workers wake on `LISTEN/NOTIFY`, schedule an in-memory
timer for the next durable `run_at`, and reconcile queued jobs after listener
reconnect. The Postgres World integration defaults to that mode; legacy
`EVE_ENV_WORKFLOW_POSTGRES_POLL_INTERVAL_MS` overrides are intentionally ignored.
Keep the concurrency at 50: the package documents a deadlock at 10.

## Host residency

`MIKKA_EVE_HOST_RESIDENCY` selects the lifecycle, defaulting to `resident`:

- `resident` (default): the Containers SDK keepalive stays exactly as shipped —
  `onActivityExpired` never fires while work exists, and `onStop` restarts the
  server through `startAndWaitForPorts`. This mode is required while
  `WORKFLOW_TARGET_WORLD=@workflow/world-postgres`: the Postgres World's
  Graphile worker owns due-job delivery inside the live process, so a sleeping
  host would stall timers, retries and queued turns. External hosts behind the
  relay keep their own residency; this flag only covers this worker's
  container.
- `on-demand`: the container sleeps after `MIKKA_EVE_IDLE_TIMEOUT` (default
  `15m`) once the SDK reports no in-flight request, stream or WebSocket.
  `onStop` never self-restarts; the next request or queued delivery starts the
  container through `containerFetch`. It is honored **only when the configured
  World delivers through the native queues** (the
  `@mikka/eve-cloudflare-world` transport); with the Postgres World the flag is
  refused (`CF_EVE_RESIDENCY_REQUIRES_QUEUE_WORLD`) and the host stays
  resident. Waiting states — approvals, human input, hooks, sleep-until — then
  live in the queues and World storage, so no Linux container is held while a
  run waits.

## Durable wake delivery

Two deliveries land durably before compute, and each is release/version bound:

- `EVE_WAKE` (native queue, private binding + consumer in this worker):
  `EveService` forwards `POST /eve/v1/mikka/events` to the container as usual,
  and buffers the exact call into `EVE_WAKE` only when the host answers 503.
  The product outbox (`coordinator_events.deliveredAt IS NULL`) remains the
  claim authority and sweep fallback; the queue copy just recovers faster.
  `consumeEveWake` re-delivers by event name, dedupes by `eventId` inside a
  batch, acks only an accepted delivery and retries everything else with
  bounded backoff into the configured dead-letter queue. Wider duplicates land
  on Eve's `mikka-event:<id>` session idempotency and `markEventAccepted`, so
  double delivery can never double-run a turn. A queue has exactly one
  consumer worker, so the private release deployment provisions one queue pair
  (`mikka-eve-wake-<release>` plus its DLQ) per release and keeps both until
  the release's retained messages drain.
- `EveWorkflowDelivery` (named entrypoint): the
  `@mikka/eve-cloudflare-world` queue consumer posts each retained release's
  queue messages to `https://eve.internal/.well-known/workflow/v1/flow`. The
  entrypoint requires the release, retry-count, queue-time and signature
  headers — the Node executor inside the container authenticates the signature
  over the original bytes and echoes the release — then delivers through the
  release-named container, which starts on demand.

Each release runs its own Eve Container, and a resident host never sleeps.
Stop a release's Container with `stopForOwner` once no gateway release serves
it, otherwise every release keeps polling the database.

The named service `EveService` forwards the native protocol at
`https://eve.internal/eve/v1/*`. Postgres queue delivery stays inside the
Container. The ingress blocks external workflow queue callbacks, as required by
the Postgres World's security guidance. Keep queue delivery on its default
loopback origin.

The Containers SDK keeps a resident server active through its documented
`onActivityExpired` override and restarts it through `startAndWaitForPorts`
after an exit. Explicit operator cleanup persists the stopped state through
`stopForOwner`. A per-Container capability and an exact-host TLS intercept protect
the existing `product.internal` business API transport.

Follow the official configuration and operational guidance in
[Eve self-hosting](https://eve.dev/docs/guides/deployment/self-hosting),
[Eve Workflow worlds](https://eve.dev/docs/guides/deployment/workflow-worlds), and
the [Postgres World package](https://www.npmjs.com/package/@workflow/world-postgres).

# Official build ownership and Cloudflare release

**Current architectural decision (Alex, 2026-11-13): GitHub Actions builds from public Mikka; Cloudflare deploys the verified artifacts.** The repository containing a source file is not necessarily the CI trigger repository, and the CI provider is not the source of truth. This page supersedes conflicting *instructions* in historical notes, but does not rewrite release evidence.

## One supported product architecture

| Responsibility | Owner | Boundary |
| --- | --- | --- |
| Product source, Node API, Eve, Task runtime, official Web/Desktop build root | [public Mikka](https://github.com/alexj11324/Mikka) | Official build starts from a pinned public commit |
| Paid UI source and official slot implementations | private `mikka-hosted-ui` | Checked out **read-only**, by exact approved SHA, into ignored `.hosted-ui/` in the public workspace |
| CI execution and product compilation | Public Mikka GitHub Actions | Pin source and original successful run, artifact ID and digest; use the existing public runners |
| Production hosting and image Registry | Cloudflare Workers / Containers | Deploy the verified artifacts through the existing publisher |
| Company deployment, secrets, staging, cutover and rollback | private `mikka-cloud`, issues #1953 and #1954 | Only the release owner promotes a verified immutable artifact; no private code committed to the public repository |

Public/Fork PRs build the public server and compatibility contracts only. Never supply paid UI checkout credentials, production database URLs, or deployment privileges to arbitrary PR code. The official client is assembled from one public source SHA and one private UI SHA; there is **no second community UI**.

## Actual migration state versus target

The original official release workflow `.github/workflows/web-deploy.yml` used a **public-root** checkout, then obtained `HOSTED_UI_READ_KEY` through a trusted identity and installed the private UI under `.hosted-ui/`. That source boundary was correct.

The temporary private-UI Cloudflare-native builder is retired. Its old `publication=none` receipts and historical OCI issuer instructions do not authorize a release.

The supported flow is public Mikka GitHub Actions → pinned, read-only private UI checkout when required → immutable Web/API/Eve/Task/World artifacts → the existing private operations publisher → Cloudflare staging and production. Keep the original source pins, customer secret isolation, authenticated Registry digest, database/Workflow recovery and rollback checks. Respect active release windows.

Protected API, Eve, Task and Cloud Services publishers use the existing Cloudflare workload identity to request a 15-minute Registry credential from Cloudflare's Containers API immediately before reading or publishing images. Read phases request only pull access; publication requests push and pull. Eve and Task publication replace the earlier pull-only Docker login with this fresh publication credential before pushing the verified image. Credentials stay in the consuming step, outside compiler environments. The compiler does not depend on a copied Registry password stored in GitHub Secrets. The existing Cloudflare identity needs Containers Edit for this API and container deployment.

A build keeps its original reviewed source pair when later main merges arrive. The actual main workflow authenticates the public revision; the selected UI revision must belong to its main history. Compilation and publication recheck the original checkouts and receipt, without replacing their bytes or requiring a moving branch to remain unchanged.

For a shared World authority hotfix, `.github/workflows/cloudflare-world-deploy.yml` retrieves the successful original public build artifact on the GitHub runner, verifies its digest and source, and invokes the pinned private operations publisher. It uses prebuilt modules without compiling the product again. The deployment does not depend on a Codex workspace downloading a build artifact. The private operations release plan pins both previous World versions and preserves their signing identity and physical storage.

Backend-only work (Eve / Task) should not import paid UI source unless a reviewed, independently testable build dependency truly requires it. Docker must send only required build context, not the entire dependency or Git-history tree.

## Service builds and release manifests

`cloudflare-api-image.yml` is the public content-addressed producer for an actual
`push` to `main` by the release owner. It does not manufacture a manual-dispatch
event. The existing `cloudflare-runtime-release` protection rejects PR merge
refs, including the owner's same-repository PRs. That rule remains intact: PRs
run the existing credential-free image qualifications, and Registry publication
starts after merging into main. Pre-merge Registry publication is therefore
blocked by the current environment policy, not verified acceptance. Forks
receive no Registry, Cloudflare or private UI credentials. The old
manual publishers remain available for release-owner operations already in
progress; they are not the automatic build path.

The producer reads `docs/operations/releases/deploy-build-inputs.json` from a
fixed read-only operations checkout. Its exact schema is `version: 1` and
`overlaySource`, a lowercase 40-character commit SHA. The independent build input
selects the reviewed UI for upcoming builds; serving release requests retain
their original source pair and migration baseline. Missing or invalid build
input stops the plan without falling back to a serving release request. Only
API and Web check out that exact UI commit and verify its membership in the UI
repository's main history. Every required official provider must be present.
Compilers receive a filtered environment without checkout, Registry or
deployment credentials.

`config/service-build-inputs.json` records the six service input boundaries.
`scripts/release/service-builds.mjs` hashes sorted file names, file bytes, file
type, executable permission and declared build parameters. A new Git commit or
run ID alone does not change a context. Import-closure checks reject omitted
public source dependencies. Database migrations have a separate identity covering
both SQL and the code and runtime that check and execute it.

| Service | Actual input boundary | Output |
| --- | --- | --- |
| Web | Frontend, shared client/server contracts, public build settings and pinned official UI | Worker plus `web.tar.gz` containing `site/` and `proof/renderer-manifest.json` |
| API | Node API, shared application code, runtime resources, World business adapter, and the frontend shell currently embedded by the API compiler | OCI image, ingress Worker and the generated `routes.json` |
| Eve | Eve application and shared server code/resources; the standalone resource packager removes the former API/frontend compilation prerequisite | OCI image and runtime Worker |
| Task | Daemon/protocol sources, pinned CLI harness, task runtime, sandbox Dockerfile and image qualification inputs | OCI image and machine Worker |
| World | Cloudflare World source and its shared deployment/session-control contracts | Original World module archive format |
| LiteLLM | Proxy image/configuration, Worker and its shared protocol-fields module | OCI image and runtime Worker |

Shared code is an explicit dependency, not an assumption that all six services
are independent. In particular, the API still embeds the frontend shell and the
LiteLLM protocol gate executes the application's gateway handler. That gate is
separate from image content: every trusted candidate runs it, using the cached
immutable image when the proxy inputs are unchanged. A change
confined to `deploy/litellm` leaves the other five contexts unchanged. Task sends
only its selected files to Docker; API, Eve and LiteLLM retain their narrow image
contexts.

Before building, `service-plan` queries the Cloudflare OCI manifest endpoint for
each container's context tag. Only HTTP 404 means an absent image. Reuse requires
the original successful service job and its unexpired artifact; a tag without
that proof is rebuilt and qualified. Authentication or digest failures stop the
run. Service/cache artifacts are retained for 90 days; expiration never permits
unproved reuse. New publication verifies the Registry manifest digest
against Docker's published digest and records the local image ID for the private
publisher's independent platform-image check. Release decisions use immutable
digests, never a mutable tag.

### Qualification ownership

Main builds use `service-build (<service>)` in the unified producer. The legacy
automatic image jobs still qualify every PR without credentials; their manual
publication jobs remain unchanged. These are moved
gates, not deleted gates:

| Existing gate | Unified producer execution |
| --- | --- |
| Task Node contract tests and Python native-history test | `TASK_TESTS` and `TASK_HISTORY` in `Build and verify service` |
| Task Dockerfile's standard device-handoff test and pinned CLI installation | The same Task Dockerfile, built from the declared minimal context |
| Task offline non-root capability checks and review-listener isolation | `scripts/release/verify-task-image.sh`, preserving both original Docker commands |
| LiteLLM Worker cold-start budget and request cancellation | `cloudflare/litellm/worker.test.mjs` before new publication and during cached-image qualification |
| LiteLLM offline health/master-key guard | The unchanged `deploy/litellm/offline-check.sh` |
| Both CLI protocols through LiteLLM and a local fake provider; seven passes and zero skips | The unchanged `deploy/litellm/conversion-check.sh` before new publication, or `litellm-qualification` after independently pulling and checking the cached platform image |
| Eve network-isolated compilation and portable Node image | The same `build-cloudflare-eve-image.sh` with standalone resource packaging, followed by the same Eve Dockerfile |
| World authority dry-run bundle and module checksums | `service-build (world)`, preserving `modules/**`, `source.txt` and `SHA256SUMS` |
| API image self-verification | The existing `start.mjs verify-image` command, explicitly under BuildKit `--network=none` |

### Consumer contract

Each built service uploads `service-<service>-<runId>-<attempt>` with
`service-receipt.json`. Artifact paths are relative to that original GitHub
artifact archive. API uses keys `ingress` and `routes`; Web uses `assets`,
`worker` and `gateway`; Eve, Task and LiteLLM use `worker`. World uses `worker` with the path
`SHA256SUMS`; the checksum list verifies every module and `source.txt`. World's
only additional archive member is `service-receipt.json`.

After the service upload succeeds, a small
`service-cache-<service>-<context digest without sha256:>` artifact records its
original artifact ID. Cache lookup verifies this archive's GitHub digest, the
original service job and all its build/publication/upload steps. Another service
may have failed in that older run; this does not discard a separately successful
service build. Cancelled or incomplete workflows cannot supply release artifacts.
A full retry writes `service-build-plan-<runId>-<attempt>` and consumers use
the actual planning job's artifact ID. A failed-job retry retains that earlier
plan and successful services from their original attempts; the final collector
verifies each original job and selects only its successful full artifact. Only the small discovery cache pointer may be replaced during
that retry; the original service archives and final manifests remain immutable.
The final candidate manifest's workflow must still succeed in full, including
the latest LiteLLM qualification.

Job `release-manifest` verifies these artifact digests and uploads
`release-manifest-<runId>-<attempt>` with member `release-manifest.json` in its
`Upload release manifest` step. Every service carries its own original
`sourceCommit`, `overlayCommit`, `release` and
`build: {runId, runAttempt, artifactId, workflow}`. Container services also carry
`localImageId`, `imageDigest` and a digest-pinned `image`. API and Web retain their
original UI SHA; services without UI use `null`. Reuse preserves this metadata
and all artifact bytes; it does not relabel an old build as a new run.

A service's deployment digest covers its image digest and named artifact
digests. It excludes the newer candidate's commit, run ID and `reused` marker.
The private publisher verifies the original workflow/job/upload step and archive
before using any service. It then compares the candidate with the deployed
manifest, rather than treating every main merge as a six-service deployment.
Build success alone does not authorize production promotion.

### Migration identity and admission

New release candidates require `migrations.version: 3`. `migrations.files` stays
the complete, sorted SQL snapshot under `drizzle/`. The separate
`migrations.execution` object contains exactly `entrypoint`, `files`, `runtime`
and `contextDigest`; its entrypoint is `scripts/migrate.mjs`.

`scripts/release/migration-inputs.mjs` follows the existing migrator's static
imports, re-exports and literal dynamic imports. The fixed roots also include
`scripts/check-migrations.mjs` and `scripts/migration-steps.mjs`, which the private
publisher imports during admission, and every tracked pnpm hook
(`pnpmfile.cjs|mjs|js`, with or without a leading dot). Hook module dependencies
follow the same closure rules. A module may import Node builtins, exact tracked
relative `.mjs`/`.js` files and the bare package `pg`; anything else stops
planning. `execution.files` is that module closure plus every tracked `.npmrc`.

The identity is narrowed to the migrator's own runtime. It does not hash
`package.json` files, `pnpm-workspace.yaml`, `patches/` or `pnpm-lock.yaml` as
whole files, so adding an unrelated UI dependency leaves it unchanged.
`execution.runtime` records instead, with keys in this order:

- `imports`: for each bare package the closure imports, `{importer, key, name}`.
  The importer is the module's nearest ancestor directory listed in the
  lockfile's `importers` (the repository root is `.`), which must declare the
  package exactly once among `dependencies`, `devDependencies` and
  `optionalDependencies`. `key` is pnpm's resolved snapshot key, so a version,
  peer or `(patch_hash=…)` change changes it. Sorted by importer, then name.
- `lockfileVersion`: `'9.0'`; any other lockfile format stops planning.
- `nodeMajor`: the major of `.node-version` (`24`, `v24`, `24.11` and `24.11.1`
  are all `24`). A minor or patch change keeps the identity.
- `packages`: the transitive closure of those keys through each snapshot's
  `dependencies` and `optionalDependencies`, one
  `{dependencies, integrity, key, optionalDependencies}` per snapshot key, sorted
  by key. Edges are `[name, key]` pairs sorted by name. `integrity` is the
  package's `resolution.integrity`, which must be the resolution's only field
  and a SHA-512 SRI value.

A reference is resolved by pnpm's rule: a bare version belongs to the
dependency's own name, and a reference carrying its own name is an npm alias.
Any reference with a protocol (`link:`, `workspace:`, `file:`, git or tarball
URLs), a missing snapshot or package entry, a resolution other than integrity
alone, a non-SHA-512 integrity or an unknown snapshot field stops planning, as
does a closure of more than 256 packages.

The builder runs in credential-bearing release jobs without installing
dependencies, so it reads the lockfile with a dependency-free reader of the exact
subset pnpm writes for lockfile v9: two-space block mappings, one-line block
sequence items and one-line flow collections of plain or single-quoted scalars,
every value a string as in YAML's failsafe schema. Anchors, aliases, tags,
comments, multi-line or double-quoted scalars, tabs, carriage returns and
duplicate keys stop planning. The private verifier parses the same Git bytes with
a full YAML parser, so a misreading here can only make the two identities differ.

The scanner parses source without linking or evaluating it. Computed imports,
import attributes, alternate module loaders, missing dependencies, file symlinks
and symlinked parent directories stop planning. Node 22's parser metadata is
accepted only with its existing import-attribute information; unsupported older
metadata is rejected. The parser host's version is never part of a digest.

The independent private verifier reproduces each digest from the fixed source's
Git bytes and file modes. Files are sorted and unique. SHA-256 starts with UTF-8
`JSON.stringify(parameters)` followed by a NUL byte; each file adds
`JSON.stringify([path, 'file', executable, byteLength])`, a NUL byte and its exact
bytes. Git mode `100644` maps to executable `0`, and `100755` maps to `73`.
Execution parameters, in that property order, are
`{version: 3, kind: 'migration-execution', entrypoint: 'scripts/migrate.mjs', runtime}`
with `runtime` as above. The aggregate applies the same algorithm to the SQL
files with `{version: 3, kind: 'migrations', execution: execution.contextDigest}`.

Identity format versions: a change to what the identity covers or how it is
hashed gets a new `version`. Only the newest version admits a new candidate.
Older receipts stay readable as recorded: version 2 (which hashed `.node-version`,
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, workspace manifests,
`patches/`, `.npmrc` and hooks whole beside the module closure, with parameters
`{version: 2, kind, entrypoint}`) and the SQL-only receipt without a version. The
service plan treats a previous manifest of an older version as a migration
change. The private publisher recomputes the authenticated baseline in the new
version from that baseline's own source, so a format change alone is not an
executor change.

Every forward candidate path requires the complete v3 contract. The historical
reader retains older receipts for baseline evidence or rollback without
rewriting them or treating them as execution authorization. A private publisher must
independently reconstruct the baseline from its authenticated source and compare
the execution inputs before importing candidate checkers, planning or obtaining
deployment/database credentials. Execution changes require independent review;
unchanged execution still must pass the original SQL admission rules. Neither a
changed digest nor an already-applied database ledger grants migration permission.

For development diagnosis, keep five different facts separate: the committed
SQL snapshot, the migration executor and its import/runtime inputs, backfills,
the database's historical migration ledger, and that database's actual pending
set. A source-only comparison can detect executor incompatibility and pin SQL,
executor and backfill code identities. It does not prove backfill business safety
or results, historical ledger state, or the pending set without inspecting the
intended isolated database. Never
replace an authenticated deployed baseline with the PR base, latest main or an
unrelated Desktop release. Use the existing private
[deployment runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/deploy-pipeline.md)
and verifier, preserving source pins and the distinction between a committed
bootstrap selection and a previous published manifest. A local diagnostic does
not authorize deployment or migrate a shared database. Production migration
and promotion remain with #2897/#1954.

## Production promotion switch

**Paused: production promotion, Desktop publication and production mobile OTA
need a human (Alex, 2026-11-27).** Staging still deploys every merge to `main`.

Why: from about 18:00 UTC on 2026-11-26, every merge to `main` staged, then
promoted production (`pipeline-production`), and that promotion started a
Desktop release by itself; the overlay-sync bot also moved the hosted UI build
pin off the frozen `2ca0b543`. The gates did not catch a broken Desktop: hosted
CI became browser-free (hosted #385) and the Desktop route-allowlist guard skips
when it has no hosted checkout. Desktop `2026.10000.1939` shipped broken to every
user. Continuous deployment comes back once the gates listed below exist.

**The switches** are two fields of one reviewed file, private `mikka-cloud`
`docs/operations/releases/deploy-pipeline.json` on `main`: `autoProduction` for
production and Desktop, `mobileProduction` for the mobile OTA. Both are `false`
now. There is no public switch.

| `autoProduction` | Staging | Production | Desktop |
| --- | --- | --- | --- |
| `true` | every merge | promoted after staging passes | built after that promotion |
| `false` (current) | every merge | only the owner's dispatch of `pipeline-promote` | only the owner's dispatch of `desktop-release.yml` |

It fails closed. `cloudflare-app-deploy.yml` promotes automatically only when
it reads exactly `version: 1` and `autoProduction: true`; a missing, unreadable
or different policy counts as `false`, and staging continues. The private
publisher refuses an automatic (`workflow_run`) promotion unless
`autoProduction` is `true`, and before every production write it re-reads the
policy on private `main`: any change to the file stops a running promotion.

While paused, these do not move production:

- `deploy-build-inputs.json` `overlaySource` (the overlay-sync bot's PRs)
  selects the hosted UI for upcoming builds, which is what staging receives.
  Production serves the overlay in its promoted manifest and changes only
  with a promotion. A promotion also requires the candidate's overlay to equal
  the current `overlaySource`, so after the pin moves, stage again first.
- `integration-to-main-promotion.yml` runs only on `workflow_dispatch`
  (`dry_run` by default, #3363). Merging into `main` only stages.
- Desktop never starts by itself from an owner deployment dispatch, including
  the legacy `gateway-observe` and a manual `pipeline-promote`: the trigger
  ignores them and a chained Desktop run refuses their receipts. Only an
  automatic `pipeline-production` promotion (`autoProduction: true`) chains
  Desktop; otherwise the owner dispatches `desktop-release.yml`.

Production at the pause is deployment run 45913824441 (`main` `0e259f65f`,
services built at `01a4a7dcd076`, UI overlay `24d3aa2a`). It was not rolled back.

### Promote while paused

1. Pick a successful merge-triggered run of `cloudflare-app-deploy.yml` whose
   `pipeline` job staged the candidate (`pipeline-production` shows skipped),
   and the commit it staged (the run's head SHA, also `sourceCommit` in its
   `deploy-pipeline-*` artifact). Check staging yourself.
2. As the owner, dispatch `cloudflare-app-deploy.yml` on `main` with
   `phase: pipeline-promote`, `pipeline_run: <staging run id>`,
   `promote_source: <commit>` and `cloud_source_sha: <current mikka-cloud main>`.
   The form also requires `qualification_run` and `qualification_artifact`;
   `pipeline-*` phases ignore them and find the qualification themselves.

   ```sh
   gh workflow run cloudflare-app-deploy.yml --repo aspectly-labs/Mikka --ref main \
     -f phase=pipeline-promote -f pipeline_run=<run> -f promote_source=<commit> \
     -f cloud_source_sha=<mikka-cloud main> -f qualification_run=0 -f qualification_artifact=0
   ```

3. `pipeline-production` refuses any other actor or phase; a staging run that
   was not merge-triggered, failed, was rolled back or staged another commit;
   a `cloud_source_sha` that is not current private `main`; and a commit that
   does not contain what production serves (no downgrade). The private
   publisher checks the staging evidence again before any write. Production
   verification failures restore production as before.
4. After production is verified, release Desktop by dispatching
   `desktop-release.yml` on `main` with
   `cloudflare_receipt: pipeline:<promotion run id>:<attempt>`. A manual
   promotion never starts Desktop by itself, and a chained Desktop run refuses
   its receipt.

The Desktop and runtime verifiers read `https://app.aspectlylabs.com/mikka/api/version`.
It is a known flake: on 2026-11-27 it briefly answered
`{"error":"deploymentVersionUnavailable"}` (HTTP 200) before answering build
`01a4a7dcd076`, overlay `24d3aa2a` again. The verifier
(`readProductionVersion` in `scripts/release/cloudflare-promoted-web.mjs`)
retries only that unavailability or a non-200, four reads with 2, 4 and 8
second backoff, then fails closed; an answer that names a build is final.

### Before setting `autoProduction` back to `true`

Each of these must exist and pass, with its evidence linked in the
`mikka-cloud` PR that flips the flag:

- the Desktop route-allowlist guard runs in release CI with the hosted checkout
  and fails when that checkout is missing;
- browser end-to-end tests run on hosted UI pull requests;
- a smoke test of the signed Desktop build runs before publication;
- a Desktop beta channel with staged rollout.

### Mobile OTA while paused

`mobile-next-update.yml` (dispatch only) has three phases. It reads
`mobileProduction` the same fail-closed way, with a read-only `mikka-cloud`
contents token, right before it reads `EXPO_TOKEN`:

| Phase | Who | Needs | Publishes to |
| --- | --- | --- | --- |
| `stage` (default) | any repository writer | nothing from the policy | EAS branch `next-staging`, which neither the `next` nor the `production` channel may serve; uploads `mobile-ota-stage-<run>-<attempt>` |
| `publish` | any repository writer | `mobileProduction: true` | `next` users directly; refused now |
| `promote` | the owner only | a readable policy and a successful `stage` run | republishes that run's exact update group to `next` |

To ship an OTA while paused:

1. Dispatch `phase: stage` with `hosted_ui_ref: <exact mikka-hosted-ui main SHA>`.
   The run verifies the app config, typecheck and tests as before, publishes to
   `next-staging` and records the update group in its stage receipt. Check the
   staged update yourself.
2. As the owner, dispatch `phase: promote`, `stage_run: <that run id>` and the
   same `hosted_ui_ref`. The job refuses any other actor; a stage run that is
   not a successful dispatch of this workflow on `main`; a receipt that is
   missing, for another run, branch, platform or runtime, or for another commit;
   and an unreadable policy. It re-verifies that app revision, then runs
   `eas update:republish --group <staged group> --destination-branch <next branch>`.

Before setting `mobileProduction` back to `true`, these must exist and pass,
with evidence linked in the `mikka-cloud` PR that flips it:

- an end-to-end mobile smoke test on the release build, run against the staged
  update before it reaches `next`;
- a staged OTA rollout channel (`--rollout-percentage` on the `next` channel, or
  an equivalent staged channel) with a documented stop/rollback step.

## What current docs are authoritative?

Read in this order for an active engineering operation: `AGENTS.md`, [documentation index](../README.md), this page, relevant active design/operations references, and **latest main source plus the actual current #1953/#1954 release selection**. Dated audits, archived screenshots, older handoffs and `docs/design/decisions.md` are historical context only. Remove obsolete records once their active references are replaced; preserve current security, migration, recovery and release evidence.

**Repo size caveat:** Removing tracked history documents reduces a working tree or checkout size, but does not erase prior Git objects or necessarily reduce the repository size reported by GitHub. Never force-push rewritten shared Git history just to shrink it.

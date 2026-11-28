# Service manifest deployment contract

The public build workflow produces a verified release manifest for every main
push, including commits that reuse all six services. The application deployment
workflow consumes the successful producer through its actual `workflow_run`
event. It keeps the existing public driver and private operations entry point.
Company environment maps, migration execution, service writers and rollback
receipts belong to the private operations repository.

## Selection and ordering

The deployment workflow holds the existing
`cloudflare-application-deployment` concurrency group for the complete run.
`queue: max` preserves pending manual releases; cancellation is disabled. Once
the run acquires its turn, it reads main again. An older producer is recorded as
superseded and performs no writes. The latest main build starts its own run.
Superseded runs are not successful deployment evidence.

The public selector pins the private operations commit, the original producer
run/attempt/artifact and the previous verified staging manifest. The private
publisher independently checks source ancestry, original jobs, artifact upload
logs, archive digests and member digests before any writer runs. Existing Cloud
Services qualification remains required. A missing or expired qualification
receipt stops the run; the reviewed qualification workflow must be run again.

The service diff compares deployment digests, then deploys changed services in
dependency order: World, Task, LiteLLM, Eve, API, Web. Unchanged services retain
their original source and artifacts. Additive migrations are checked separately
and run before service updates. A first release uses an explicit null baseline;
the publisher must capture real existing versions and images before that first
write. A partial or completed pipeline marker prevents a second bootstrap.

## Verification and recovery

The Web version document keeps `build` and `overlaySha` tied to its own assets.
It reads `apiBuild` and `apiOverlaySha` from the current API binding on each
request, so a warm Web instance observes an API-only update or rollback without
being replaced. The upstream API still has its exact five-field document; this
identity separation does not introduce the client protocol changes from #2896
or satisfy that issue's production promotion gate.

Staging runs the existing authenticated feature smoke and the anonymous
[API route registration probe](route-probe.md). The route inventory must come
from the actual API artifact, even when a newer release reuses that API. A
verification failure leaves the candidate in staging, prevents production
promotion, and creates or updates a failure issue with the run link and failed
checks. The next automatic writer refuses an unresolved failed deployment.

`pipeline-rollback` uses an authenticated recorded run, its candidate and
previous manifests, plus the provider's captured immutable versions. It restores
the changed services in reverse order, verifies the restored state and retains
additive database schema. A completed rollback makes the previous manifest the
next release's baseline; it never claims that the rolled-back candidate is
still serving. `pipeline-stage` supports an emergency replay of a successful
main producer. Existing reviewed manual phases remain available for the release
already in progress during migration to this workflow.

The manual `pipeline-stage` phase has a `staging_failure_drill=route-404`
acceptance option, disabled by default. It sends one anonymous registration
probe to a fixed missing path through the same staging API binding. The original
route inventory and verification assertions remain unchanged, so the actual
404 fails the release. This option is rejected for automatic runs, rollback and
production. Its failed run must leave a failure record and require recovery;
it never counts toward the three successful automatic staging releases.

Public evidence uses `deploy-pipeline-<runId>-<attempt>` with
`pipeline-summary.json`, `release-manifest.json` and, when present,
`previous-manifest.json`. Full provider receipts stay private. The record job
has GitHub deployment/issue write permission and no runtime credential. It
records the completed result and reports failures under the deployment issue.

Never re-run a deployment run whose Deploy step ran, whether through "Re-run
all jobs" or "Re-run failed jobs". Full workflow reruns can make earlier original
artifacts unreadable; retention periods and attempt-specific names don't
guarantee preservation. The exact rerun mode and deletion cause of
[run #709](https://github.com/aspectly-labs/Mikka/actions/runs/46150675123)'s
missing archive remain unconfirmed. When a rerun's earlier Deploy receipt is
missing, the current run fails closed with `pipeline_rerun_after_deploy_refused`;
later selections report `pipeline_rerun_erased_receipt_requires_recovery`.
Logs or cached copies cannot replace the original artifact.

Follow the [reviewed private receipt and resource recovery contract](https://github.com/aspectly-labs/mikka-cloud/blob/4fb3c85ab635bd3c137bb372771c512647eb0e6c/docs/operations/deploy-pipeline.md#回执保留与预发恢复2026-11-28).
Authenticate the original manifests, qualification, execution source and actual
resource ancestry before using the existing protected `pipeline-rollback`
path. Keep its preflight and probes, and verify that the recovery run's own
original artifact can be downloaded. Stop when any required evidence is
missing. `stage-all` requires a reviewed plan matching the actual resources;
it isn't a general or sole receipt-recovery path.

After verified recovery, use a new successful main producer's fresh
`workflow_run` staging run. Do not establish that baseline by retrying an
earlier-created run. Manual `pipeline-stage` is not promotion evidence.
[Recovery #712](https://github.com/aspectly-labs/Mikka/actions/runs/46153661413/attempts/1)
demonstrated the protected rollback path. The later execution of
[#711 attempt 2](https://github.com/aspectly-labs/Mikka/actions/runs/46153558280/attempts/2)
and the refusal in [#714](https://github.com/aspectly-labs/Mikka/actions/runs/46154833179/attempts/1)
expose the separate baseline-ordering defect tracked in [#3453](https://github.com/aspectly-labs/Mikka/issues/3453).
Keep the actual deployment failures and recovery results in [#3133](https://github.com/aspectly-labs/Mikka/issues/3133).

Selection takes the baseline from the writing attempt that started last, not the
run created last, so a re-run that deployed after a later rollback is the
baseline; a run that failed before its first write sets no baseline.

## Production activation

Production promotion is disabled in the initial reviewed private policy. It
requires a valid release owner window, the compatibility change merged into
main, at least three successful automatic staging releases and a verified
current staging result. Production and staging use distinct previous manifests.
Enabling this path is a separate reviewed operations change; merging product
code does not by itself enable production. The Mobile OTA owner-window guard
belongs to the separate compatibility change in #2896. This staging rollout
does not change mobile or protocol inputs or authorize an OTA publication.

The current registry publication environment permits main only. Trusted PRs
still run the original credential-free image qualification gates, but cannot
pre-publish registry images under that environment policy. This is an explicit
remaining constraint; no skipped publication job counts as registry reuse proof.

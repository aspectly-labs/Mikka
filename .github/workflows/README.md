# CI workflow strategy

This guide maps required pull-request checks, release jobs and their source
bindings. Current workflow files define the triggers and selected coverage.

## Pull requests and merge candidates

Every ordinary PR push can trigger up to three workflows: CI, Browser gate,
and Cloudflare API source qualification for PRs targeting main. CI runs
affected source, unit and daemon checks on Node 24 only
([2026-11-22-1430](../../docs/design/decisions/2026-11-22-1430-ci-node24-only.md)).
PRs targeting dev, which has no merge queue, retain selected acceptance in the
protected UI check.

Merge queue autopilot checks the PR head after CI or Browser gate completes.
It adds an eligible same-repository PR to the end of the queue once all required
checks pass. Stacks and PRs included in an open batch follow their owner's merge
flow. The GitHub App installation token lets queue candidates trigger CI.

GitHub requires `UI policy (strict)`, `Production build and browser interactions`
and `Browser tests (before merge)` on both the PR and its queue candidate.
Draft PRs fail the first two gates until marked Ready. On PRs targeting main, the database gate
checks that trusted selection succeeded and the deferred DB jobs skipped.

On `merge_group`, CI retains the full Node 24 unit and PG17 shard matrices. Selected Analytics, Workspace Governance and specialty acceptance
must pass before the required checks succeed. The specialty selector reads path
policy from the candidate's immutable base and selects all checks if that base
predates the policy. The Node.js compatibility candidate workflow keeps its real
App, Eve and local-device build and startup on Node 24.

The specialty checks cover app icon compilation, cloud computer, coding
workspace, credential isolation, E2B subscription custody, Read Cache, Site
Search, SSH, unattended sandbox and credential-free Cloudflare image builds.
Use `workflow_dispatch` in the individual workflow where it is available to
request its evidence before queueing.

Mark a same-repository mobile PR Ready or apply the `mobile-preview` label to
publish a preview of the current PR to its `pr-<n>` EAS branch. Remove and reapply the
label to publish a newer head. Production OTA still runs on its main push or
existing manual dispatch.

## Main pushes

CI retains the existing postmerge checks for each distinct main commit.
Device Gateway, Minute Worker, Engineering Sandbox and E2B offline release
validation use their existing main workflows. Production Readiness, Read Cache
Production, Cloud Core and Task Attachment offline guards run on relevant
main pushes. Their production acceptance entry points retain their existing
dispatch and authorization conditions. The unified protected Cloudflare
publisher continues to own main image builds.

See [test ownership and CI cost](../../docs/ci/test-ownership.md) before adding
or duplicating suites.

## Cloud worker template release

`e2b-official-runtime.yml` is the template publication coordinator. It checks
the immutable worker digest and failed runtime input fingerprints before entering
the publication queue. Its reusable `e2b-runtime-release.yml` holds that queue
through validation, publication and cleanup, and calls `e2b-template.yml` to build unique
candidates from the official `desktop`, `claude` and `codex` bases. The builder
executes the existing additive installer beneath `/opt/mikka`, leaving an
anonymous worker preloaded at E2B's ready checkpoint. No runtime credential or
user data enters the template.

Publication requires original-file conservation and candidate build-time
readiness: the template builds, both official CLIs start and the execution
fence opens. Original files retain their SHA-256, type, mode, owner and link
target. E2B uses the user's own key, so live subscription execution is not a
template-publication gate
([#2789](https://github.com/alexj11324/Mikka/pull/2789)). Runtime acceptance
retains its own criteria; build-time readiness does not prove a completed
subscription task. Each release records original CLI paths and hashes in its
own manifest; production, probing and acceptance use the same resolver,
without an acceptance-only binary override.
Installation preserves every original persistent entry exactly. E2B's final
boot and a disposable fresh instance are checked separately against the
recorded exact-path provider-runtime policy; original CLI/software bytes and
all other fields remain protected. File-scan verification instances are never
reused as cold-start performance samples.
The finalizer always closes instances labelled with this exact source, run and
attempt. It also removes this run's exact named private candidates and verifies their
absence. Public images and previous releases remain available. Cleanup receipts
are artifacts; a cleanup error fails the workflow. An eligible candidate-build
failure on current main records a fingerprint of the declared runtime inputs
in an Actions artifact for 90 days. `scripts/e2b/runtime-inputs.mjs` verifies
the original failed step and current attempt before an automatic input decision
can skip matching failed inputs. The queue checks again after entry. Obsolete
sources, cancellations, Web failures and cleanup-only failures do not create
failure fingerprints.

A push only compares the worker inputs and builds no candidate. When they
changed, its run summary says so. The release starts by itself when the
Cloudflare deployment workflow's serving-release observation identifies the
eligible current-main source and the existing input checks select a release. A
dispatch of **E2B additive runtime release** on current main with `reason` and
`cloudflare_receipt` also starts it; a dispatch without a receipt fails before
any template builder starts. Initial automatic runtime selection binds the
observed product to current main and the consumer run's recorded source.
Subsequent gates recheck the original receipt, live serving identity and the
served commit's membership in main's history. Later merges neither replace
that source nor block its publication
([#2699](https://github.com/alexj11324/Mikka/pull/2699)). A manual dispatch may
therefore build an earlier still-served commit from main's history, never the
newer dispatch commit in its place. Respect release windows explicitly declared
by the #1752/#1954 owner; an offline push run itself holds no publication window.

The previous published worker source comes from the successful publication's
`e2b-release-evidence-RUN-ATTEMPT` artifact. The reader recognizes `templates`
and historical `subscriptions` jobs, verifies their original attempt and report,
and compares the report's `sourceCommit`: a later workflow head can publish an
earlier served commit. It reuses the official repository identity and downloads
by immutable repository ID, retaining the report's original recorded identity.
Missing, expired or inconsistent publication evidence
fails the automatic comparison before a paid builder starts. The explicit manual
retry below remains available to the release owner. Source and regression
boundaries are recorded in the [runtime reuse evidence](../../docs/ci/2984-runtime-reuse.json).

The Coding Workspace, Task VM and Task Secret consumers accept this official
producer's `workflow_run` event alongside its retained push/manual events. The
event is only a pointer: their pre-checkout and shared guards confirm the fixed
workflow identity, repository, exact main source and latest attempt through the
GitHub API. Existing source selection, publication evidence and pre-credential
checks still apply. A successful run with skipped publication does not prove a
validated and published runtime. The finite Factory visual-evidence window
below keeps its separate selection rules. The source-bound counterexample and
retained refusal cases are recorded in the [#2984 evidence](../../docs/ci/2984-runtime-consumers.json).

To retry after an external service recovers, dispatch the same way; the Actions
dispatch event records the reason. Manual dispatch always runs validation, even for a matching worker. Changed
runtime inputs produce a new fingerprint. Missing or expired failure artifacts
permit the normal worker comparison; history API errors fail the check. Do not
retry only failed candidate/gate jobs: cleanup has removed their candidates.

After the candidate and receipt checks pass, the workflow makes the candidates
public and keeps the
release report (all three IDs, their official base kinds, worker digest, source
commit and original candidate evidence) as an immutable artifact for the private Cloudflare
API deployment. Old template IDs and aliases are never updated or deleted. A
failure before publication leaves the selected release unchanged. Publication
verifies the candidate's source, run, attempt and report digests. The private
Cloudflare deployment selects the verified IDs under the #1954 release owner;
publishing IDs alone does not change production selection. Rollback follows
that owner's existing procedure and a normal rollback PR when code changes,
preserving matched application/worker sources and the current admission gates.

PR runs use no release credentials. Main builds read the existing `E2B_API_KEY`
from the existing Infisical `prod:/vercel` path. That retained secret location
does not imply a Vercel publisher. Delivery uses the existing GitHub OIDC
identity; credential values never enter reports or logs.

The worker digest excludes unrelated Web lock entries and package scripts.
A main push compares the immutable event's before/after inputs and reports the
result; it never starts candidate builders. Publication and retry use the
serving-observation or authorized-dispatch paths above. The existing
no-new-polling rule and task-owner E2B billing apply. See
[Alex's preservation clarification](../../docs/design/decisions/2026-11-03-1430-official-e2b-templates-unchanged.md).

## Factory visual evidence acceptance

`factory-visual-evidence-acceptance.yml` performs the finite production
acceptance for #1783. Successful Web and E2B completion events enter a read-only
selector. It requires PR #1789's exact merge commit, current main, the serving
Web build, the completed matching runtime release and an active #1752 window
bound to the PR's final head. Web finishing while E2B is still publishing
declines selection; the E2B completion event supplies the next opportunity.
Unrelated deployments do not start model work.

Inside the existing `production-smoke-owner-acceptance` queue, the job checks
these bindings again before reading only `SMOKE_OWNER_EMAIL` and
`SMOKE_OWNER_PASSWORD` through the existing Infisical OIDC identity. Claude
uses the normal `dispatch_bot_computer` path and the published desktop
template. Its submission without captures must persist a blocked visual
evidence gate; a continuation with a real recording and screenshot must
reach independent review and owner acceptance. Codex uses `dispatch_run`
with the test account's already authorized `alexj11324/Mikka-handoff`
repository. It adds one uniquely named text file, passes that repository's
existing checks, and publishes its own unmerged PR for owner review. The
operator separately checks the actual GitHub PR, head, author, marker and
checks before declaring the issue's production acceptance complete. The
workflow's host publication receipt explicitly leaves this direct GitHub
verification pending.

Both cases record the actual browser reading and reloading the delivered
file. Browser dependencies and media remain in the current run's existing
capture temporary directory, outside its Git checkout. The driver downloads
the immutable report and each capture through the activity and report URLs,
compares their bytes, and decodes the media with FFmpeg. It restores its own
temporary credit share and profile changes and ends its runtime resources.
The task, its Bot and its artifacts remain available for inspection. After
recording the Codex handoff, normal cleanup cancels that test task and verifies
its stored report and media remain readable with unchanged identities and
bytes. Cancellation itself is not evidence that handoff succeeded.

The driver discovers the test account's actual GitHub repository access and
shared model subscriptions before starting a task. Missing authorization or a
subscription keeps that case failed with a closed diagnostic code. It does
not borrow another user's GitHub identity, insert a database fixture or change
Infisical trust. See the [#1783 production procedure](../../docs/acceptance/issue-1783/production.md)
for the release-window marker and receipt checklist.

The two subscription cases report independently. A failed case or cleanup
keeps the workflow red even when the other case succeeds. A retry reuses only
the successful native case step from the same source and exact run attempt;
it never treats selection, a skipped step or a failed case as acceptance.
Automatic attempts are bounded to two per subscription, with an explicit
dispatch allowing a third. Safe receipts, actual media and reports are
retained as workflow artifacts; credentials and raw task logs are excluded.

## GitHub branch protection (separate repository setting)

Keep the existing protection and required checks. Read the effective repository
settings; workflow YAML and a permission-denied administration API cannot
establish them. Do not change protection to shorten a validation cycle. Follow
the single [merge procedure](../../docs/dev-workflow.md#5-ownership-and-merging):
normally integrate `main` when protection requires it, a conflict exists or a
relevant landed change requires verification, then validate that candidate.
An unrelated main change does not justify a rebase or an invented up-to-date
requirement. Missing external-check evidence is not a successful check or an
exemption from its existing requirement.

Do not skip the required gates, silently accept failed/skipped dependencies or
publish from a red PR. The workflows bootstrap the trusted Nx selector from
`origin/main` and the immutable base; documentation-only PRs still publish their required gate names.
CI source changes are not classified as documentation-only.

## Protected Cloudflare operations

`cloudflare-operations.yml` is the public protected entry for existing private
operator capabilities. It verifies the actual main workflow, owner and OIDC
claims before source credential access, then verifies the selected private
checkout belongs to canonical operations main before installing or importing it.
The private driver independently checks source and original Cloud Services
qualification before selecting provider credentials and the fixed operation.
The three marketing emergency recovery actions instead require authenticated
original resource or permit evidence before any resource write.

The entry uses `cloudflare-runtime-release`, read-only repository-scoped source
App tokens and a separate public Actions token. Marketing uses its own website
token, selected independently of operations ownership. Provider locators, fixed
request documents, raw reports and recovery records stay private. Public output contains
the operation status and a checksum for evidence retained and read back from the
existing private storage. The original private workflows and prior receipts stay
intact during the transition; source checks do not establish runtime acceptance.

Public operator drivers are checked out at immutable approved source revisions
before installing their locked dependencies. Canary and daemon revisions come
from fixed reviewed private request files; an absent canary request refuses the
operation. Manual observation is separate from the original scheduled observer
and private JIT runner; admitting one does not prove the others work.

## Official UI overlay

There is one UI ([decision](../../docs/design/decisions/2026-11-08-2133-one-ui.md)).
Public and fork PRs build without the private repository, and that build only
has to compile; no workflow screenshots it. (`community-settings-ui.yml`,
which captured that build's settings pages, was removed on 2026-11-08.)

`cloudflare-api-image.yml` and `desktop-release.yml` alone read the private UI, with the
GitHub read-only deploy key `HOSTED_UI_READ_KEY` on `alexj11324/mikka-hosted-ui` only. They set
`MIKKA_UI_OVERLAY_DIR` and record `MIKKA_UI_OVERLAY_SHA`; public and fork PRs still build with the
default slots without either variable or any private secret.

Web verifies `/mikka/api/version`'s `build` and `overlaySha`. Desktop uses the
existing matching-Web source gate and checks out **that Web overlay SHA**, then
verifies equality again before publishing. A newer preflight supersedes older waits for the same ref and release path.
An ordinary push and a dispatch carrying Cloudflare promotion evidence use separate preflight groups. The macOS job finishes its active signing/notarization work and keeps
only the latest pending candidate; new main pushes do not cancel a signed build
in progress. Before publication, an overlay that no longer matches production is
rejected, and the existing proven-Web-descendant and sealed-candidate checks still
apply.
Desktop seals, verifies and publishes from one macOS job with no public Actions
artifact upload. Release assets include the sealed `mikka-ui-overlay.json`.
Official compiler logs stay on the ephemeral runner, and both distributable
static output and the complete signed ASAR are audited for source maps.
See [the deployment runbook](../../docs/operations/web-deploy.md#official-private-ui-overlay)
for identities, rollout, source exposure boundaries and recovery.

## Dependency-aware selection

`ci-selection.yml` supplies the same trusted decision to CI, Analytics SSR,
and Desktop. Nx Core follows explicit root-file, workspace,
source-contract and DB feature-marker edges; candidate code is parsed, not
executed during classification. Source/security policies stay enabled, and
unmapped/unsafe/global inputs expand coverage. Core/integration commands are
scheduled by Nx; the existing strict database runner owns selected PG17 suites.
When the immutable base predates the selector, full blocking coverage and
shadow selection apply. A selector absent from that base cannot authorize a skip. Manual dispatch
and Monday 03:23 UTC run complete CI. No Nx Cloud, remote test cache, browser E2E
or release credentials are added. See [policy and commands](../../docs/ci/incremental.md)
and [measured results](../../docs/ci/1699-results.md).

Selected reusable jobs consume CI's trusted decision without running another
selector. The Analytics conclusion contributes to `UI policy (strict)`.
The actual Analytics build, SSR checks and browser run own the `analytics-ssr`
check name; no second runner summarizes that job. An absent or invalid trusted
selection fails before setup, and the parent gate rejects selected runs that
fail, cancel or skip. See the [measured queue samples](../../docs/ci/2984-analytics-baseline.json).
Independent dispatches still classify their changes.
Desktop checks and Electron acceptance run on Linux. Mac packaged acceptance,
local-driver permission probes and installer acceptance are removed from CI;
the standalone acceptance drivers remain available for explicit local runs.
Official macOS signing, notarization, package integrity and publication remain
in `desktop-release.yml`. The shared pnpm action restores exact installed dependencies or runs
a frozen install on a miss. PRs do not upload dependency caches. See
[cache boundaries and performance evidence](../../docs/ci/1765-optimizations.md).
`ci-dependencies.yml` warms Desktop's Linux dependency key when install
inputs change on main; dispatch it to repopulate evicted or changed-image keys.

## Engineering sandbox

`engineering-sandbox.yml` authenticates explicitly dispatched main jobs to the configured engineering Worker and runs the Factory handoff, startup-timing and isolated PostgreSQL 17 policy-migration suites there. External agents can dispatch a supported suite on a committed source SHA using the [engineering runner instructions](../../docs/operations/engineering-sandbox.md).

# CI workflow strategy

This guide maps required pull-request checks, release jobs and their source
bindings. Current workflow files define the triggers and selected coverage.

## Pull requests: blocking checks

Every ordinary PR push can trigger up to three workflows: CI, Browser gate,
and Cloudflare API source qualification for PRs targeting main. CI runs
affected source, unit and daemon checks on Node 24 only
([2026-11-22-1430](../../docs/design/decisions/2026-11-22-1430-ci-node24-only.md)).
PRs targeting dev, which has no merge queue, retain selected acceptance in the
protected UI check.

- `ui-policy.yml` runs for `pull_request` and `merge_group`, not for each
  same-repository branch push. Actions' default PR checkout runs GitHub's
  synthetic merge commit, including the PR together with its target branch at
  the time of the check. A changed PR head gets a new check run.
- Keep `UI policy (strict)` and `Production build and browser interactions`
  successful for non-documentation PRs; the latter gates the selected isolated PostgreSQL suites across 1–4 dynamic
  shards. Full inventory validation runs even when DB execution is skipped. Despite its name, CI
  does not build the production Web release artifact. The retired Vercel
  `web-deploy.yml` workflow was removed on 2026-11-17.
  Current Cloudflare native CI and the transitionary private-triggered OCI issuer
  are **different** operations; neither changes long-term public build ownership.
  See [build-source-of-truth.md](../../docs/operations/build-source-of-truth.md).
- Ordinary acceptance uses API/CLI flows under decision 2026-11-01-1520.
  Targeted Desktop and Analytics jobs retain their selected browser
  checks. `browser-gate.yml` only keeps the protected check name
  `Browser tests (before merge)` and passes at once; delete it once that name
  is removed from the required checks in the repository settings.
- `GitGuardian Security Checks` is a separate external required check.
- The protected `UI policy (strict)` source stage also runs the waiting-issue check, so `waiting-issues.yml` only reopens a waited issue on `issues: closed`.
- **`CI OK`** (job `ci-ok` in `ui-policy.yml`) is the single aggregate, as in
  Orca: it needs every CI job (except `nightly-journey` until its first green run), runs on pull requests, merge groups, main pushes
  and the daily schedule, and fails if any needed job failed or was cancelled.
  A skipped job passes only where its own `if:` (trusted selection and event)
  left it out; each `CI_OK_EXPECT_*` is that `if:` (`scripts/ci/ci-ok.mjs`,
  compared by `scripts/ci/ci-ok.test.mjs`). The job runs main's copy of the
  script, as the selector runs main's bootstrap, so a pull request cannot
  change how its own results are judged. Draft PRs fail it until Ready.
- All four existing required names remain intact until branch protection
  requires `CI OK` instead ([GitHub branch protection](#github-branch-protection-separate-repository-setting)).

`local-device-node22.yml` now runs an actual app/Eve build and startup smoke
on Node 24, retaining the daemon and installer tests. The core,
integration and PG17 database jobs above also run the selected suites on
Node 24 only ([2026-11-22-1430](../../docs/design/decisions/2026-11-22-1430-ci-node24-only.md));
the original Node 24 protected-check names stay unchanged.

## Focused governance acceptance and superseded PR runs
Merge queue autopilot checks the PR head after CI or Browser gate completes.
It adds an eligible same-repository PR to the end of the queue once all required
checks pass. Stacks and PRs included in an open batch follow their owner's merge
flow. The GitHub App installation token lets queue candidates trigger CI.

A pull request that changes the interface must include a screenshot or
recording in its description. `UI policy (strict)` requires it, and
`frontend-screenshots.yml` reruns that check on PR description edits (`edited`)
without rerunning the suite. Neither job launches a browser.

GitHub requires `UI policy (strict)`, `Production build and browser interactions`
and `Browser tests (before merge)` on both the PR and its queue candidate.
Draft PRs fail the first two gates until marked Ready. On PRs targeting main, the database gate
checks that trusted selection succeeded and the deferred DB jobs skipped, with a visible
“Database checks deferred to merge queue” summary and check notice when DB suites are selected.

On `merge_group`, CI retains the full Node 24 unit and PG17 shard matrices. Selected Analytics, Workspace Governance and specialty acceptance
must pass before the required checks succeed. The specialty selector reads path
policy from the candidate's immutable base and selects all checks if that base
predates the policy. The Node.js compatibility candidate workflow keeps its real
App, Eve and local-device build and startup on Node 24.

- `Workspace governance HTTP (Item 11)` now runs as a reusable job of
  `ui-policy.yml` for PRs and merge groups that the trusted Nx selector
  classifies as database-affecting. Global, permission, auth, schema,
  workflow and unknown inputs expand coverage rather than silently skip it.
  The required `UI policy (strict)` gate checks the selected job's actual
  conclusion, and requires an intentional skip when unselected. Unrelated
  UI PRs do not allocate an extra PostgreSQL-backed governance workflow.
  On every `main` push, independent postmerge governance acceptance remains.
- Browser compatibility, E2B PR runtime, E2B BYOS and SSH device workflows
  cancel obsolete **same-PR** attempts. They never cancel main or manually
  dispatched production publication or recovery.
- All protected check names remain stable. In particular,
  `Browser tests (before merge)` must remain until GitHub branch protection
  is read and migrated; a read-only connector's 403 is not authorization
  to remove it.

See [test ownership and CI cost](../../docs/ci/test-ownership.md) before
adding or duplicating regression suites.

The active iOS app lives in the private `mikka-hosted-ui` repository
(`mobile-next/apps/mobile/`). Native iOS builds (`mobile-next-ios.yml`) and OTA
updates (`mobile-next-update.yml`) are dispatched from `main` against a
reviewed `mikka-hosted-ui` commit. Legacy 1.x `apps/mobile/**`,
`mobile-update.yml`, `mobile-native.yml`, and `mobile-screenshots.yml` were
deleted on 2026-11-25.

## Draft pull requests

`pr-acceptance.yml` separately checks the PR's `## Acceptance` declaration on
open, edit, synchronize, reopen, ready and draft transitions. It executes only
the default branch's reviewed checker, reads all changed filenames through
GitHub, and publishes the **`PR acceptance`** commit status on the PR head.
Missing evidence adds `acceptance:missing`; a corrected declaration removes it.
Drafts are not evaluated and retain a pending status, which is not acceptance.
The existing required source/security checks still run on drafts.

After this workflow is merged, Alex enables **`PR acceptance`** as an additional
required status check for `main` in GitHub branch protection. The job name
`Inspect PR acceptance` is not the head status to require. Workflow YAML does
not change that repository setting. Declaration checks establish that the PR
names its evidence; independent review still decides whether it proves the
change. The checker never calls a model or runs PR-provided code.

To inspect a PR with the same checker, run:

```sh
node scripts/ci/pr-acceptance-github.mjs --repo alexj11324/Mikka --pr PR_NUMBER
```

Replace `PR_NUMBER` with its number. For an authorized live admission rehearsal,
add `--publish` with the existing `GITHUB_TOKEN` credential delivery; never put
the token in command arguments. This updates the same status and label. The
trusted workflow itself starts automatically only after it exists on `main`.

There are two intentionally different classes of PR checks:

- **Required check names never become false green on drafts**: in the main `CI`
  workflow, the lightweight selector and required aggregators (`UI policy
  (strict)`, `Production build and browser interactions`) run on Draft PRs;
  those aggregators explicitly **fail** until the PR is Ready. Core, Integration,
  Source, Daemon, Analytics, Governance and DB runner-heavy jobs are deferred.
  `ready_for_review` re-runs the complete applicable protected verification
  even if the commit SHA has not changed. `Browser tests (before merge)` and
  external GitGuardian retain their original workflows. A skipped required
  job can be reported successful by GitHub; these named aggregators must never
  skip or accept the draft as complete.
- **Non-required specialized acceptances** (`E2B additive runtime release`
  offline PR test, E2B subscription custody, Read cache API acceptance,
  SSH device backend, Site search read contract and Unattended sandbox
  acceptance) skip their runner jobs while the PR is a draft. Each workflow
  explicitly handles `ready_for_review` to execute its real proof on the
  same code even without an extra commit. On `converted_to_draft`, the
  six jobs skip. The E2B offline job cancels an older eligible check when its
  replacement enters the same PR group. An already running E2B check may
  finish after conversion to draft.
- Mobile OTA preview publication remains available on drafts for UI evidence
  and TestFlight-oriented review. Other specialized evidence may have its
  own intentional manual or source-version trigger.

This reduces runner allocation during the local red→green cycle without
mistaking a draft-only skipped result for proof that a Ready PR is safe to
merge. Draft check failure means "not yet a merge candidate," not an ordinary
product regression. Main pushes and merge groups continue normal full coverage.

## Main pushes: postmerge checks

- A push to `main` triggers the required `ui-policy.yml` checks again. Daemon
  and desktop releases wait for that exact commit
  (`scripts/release/ci-gate.mjs`). Production acceptance workflows have their
  own successful-Web triggers and account queues.
- The special suites (`analytics-ssr`, `cloud-computer`, `desktop`,
  `e2b-byos`, `site-search`, `ssh-device-backend`, `unattended-sandbox`) run on
  pull requests only, selected by trusted dependencies or their existing path filters; each can still be run
  by hand (`workflow_dispatch`). CI calls `desktop.yml` on ready PRs, merge
  groups and the daily full run when the selector reports `desktop` (routed on
  PRs, broad on merge groups); a main
  push relies on the merge-queue run of the same commit. Production Web is promoted through the
  Cloudflare deployment workflow; Vercel publication was removed on 2026-11-17.
- `publish-daemon.yml` uses daemon/package-input path filters. A push publishes to the npm `next` dist-tag only; `latest` moves only when a promoter dispatches it with a successful `staged_run` whose daemon inputs match main.
  `desktop-release.yml` also watches the shared frontend, UI and API inputs.
  On a push it builds nothing and leaves a note in the run summary. The
  installer is built by itself only after an automatic `pipeline-production`
  promotion that serves current main, or from a dispatch carrying
  `cloudflare_receipt` (an owner `gateway-observe` or `pipeline-promote`
  dispatch never starts it). While production promotion
  is paused (private `deploy-pipeline.json` `autoProduction: false`), a promoter
  (`config/release-promoters.json`) promotes with a `pipeline-promote` dispatch and then dispatches Desktop by
  hand ([promotion switch](../../docs/operations/build-source-of-truth.md#production-promotion-switch)). A Markdown file under a
  watched directory still matches those release filters. Read the exact
  workflow paths before predicting release work.
- The run-dispatch and Controlled Skill improvement suites run in the CI
  database shards (`pnpm test:db`); they no longer have workflows of their own.
- The `ui-policy.yml` concurrency key includes `github.run_id` only on `main`.
  This prevents GitHub from evicting an older *pending* main verification,
  in addition to not cancelling a running main job. Superseded PR checks may
  still be cancelled.
- Device Gateway, Minute Worker, Engineering Sandbox and E2B offline release
  validation use their existing main workflows. Production Readiness, Read
  Cache Production, Cloud Core and Task Attachment offline guards run on
  relevant main pushes. Their production acceptance entry points retain
  their existing dispatch and authorization conditions. The unified
  protected Cloudflare publisher continues to own main image builds.

## Production mobile releases

- `mobile-next-ios.yml` (dispatch only, from main) builds the active iOS app from
  `mikka-hosted-ui` `mobile-next` at an exact `overlay_sha` that is already on its `main`, on the `xcode-27` runner (iOS 27 SDK), signs it
  manually with one persistent Apple Distribution identity (`APPLE_IOS_DISTRIBUTION_P12_BASE64`, `APPLE_IOS_DISTRIBUTION_P12_PASSWORD` in Infisical `prod:/platform`) imported into a temporary runner keychain, reuses or creates only the matching App Store provisioning profile through the existing App Store Connect API key (never creating or revoking certificates), and uploads
  it to TestFlight. It keeps no build artifact (this repository is public) and uses no EAS build; its runtime version
  (`mikka-next-*`) and update channel (`next`) identify the active 2.0 release line.
- `mobile-next-update.yml` (dispatch only, from main on `ubuntu-24.04`) publishes JS/asset EAS Updates
  from `mikka-hosted-ui` `mobile-next` at `hosted_ui_ref` (`main` or an exact 40-char commit SHA verified
  on `mikka-hosted-ui` `main`) to the isolated **`next`** channel (`runtimeVersion: mikka-next-1`,
  `APP_VARIANT=production`, `--platform ios`). It reads only `HOSTED_UI_READ_KEY` and `EXPO_TOKEN` from
  Infisical `prod:/platform` via OIDC, scrubs `HOSTED_UI_READ_KEY` via `scripts/release/hosted-ui.mjs record`
  before installing dependencies, verifying the resolved `APP_VARIANT=production` Expo config and running
  `mobile-next` typecheck/adapter tests, verifies `app.config.ts`, `eas.json`, and the live EAS `next`
  channel→branch mapping before publishing explicitly to that dedicated branch (never `production`), keeps
  private logs in `$RUNNER_TEMP`, and reports only public-safe update metadata (update group ID, runtime
  version, channel, branch, and resolved `mikka-hosted-ui` SHA).
  It has three phases: `stage` (default) publishes only to the `next-staging` branch and uploads a stage
  receipt; `publish` (a promoter) goes straight to `next` and needs private `mobileProduction: true`; `promote` lets a
  promoter republish a promoter's successful stage run's update group to `next`. While mobile OTA is paused
  (`mobileProduction: false`), only `stage` then a promoter's `promote` reach users
  ([promotion switch](../../docs/operations/build-source-of-truth.md#mobile-ota-while-paused)).

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
establish them.

Moving to the single aggregate is one settings change on the `main` ruleset (or
classic branch protection), made by Alex or a promoter after `CI OK` has passed
on a Ready PR and a merge group:

1. Add the required status check **`CI OK`** (source: GitHub Actions).
2. Remove **`UI policy (strict)`**, **`Production build and browser
   interactions`** and **`Browser tests (before merge)`**. Keep **`GitGuardian
   Security Checks`** and **`PR acceptance`** where they are required.
3. In a follow-up PR, delete `browser-gate.yml` and the two legacy aggregate
   jobs (`ui-policy`, `browser-tests`) once no ruleset names them. Move the
   rule-as-code, Engineering Handbook and timing-summary steps of `ui-policy`
   into a job `ci-ok` needs, and drop the two jobs from `ci-ok`'s `needs` and
   expectations in the same PR. Do not change protection to shorten a validation cycle. Follow
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

`cloudflare-api-image.yml`, `desktop-release.yml`, `mobile-next-ios.yml` and `mobile-next-update.yml` read the private UI, with the
GitHub read-only deploy key `HOSTED_UI_READ_KEY` on `alexj11324/mikka-hosted-ui` only. They set
`MIKKA_UI_OVERLAY_DIR` and record `MIKKA_UI_OVERLAY_SHA`; public and fork PRs still build with the
default slots without either variable or any private secret. No other workflow reads the private UI.

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
and the daily 03:23 UTC schedule run complete CI. No Nx Cloud, remote test cache, browser E2E
or release credentials are added. See [policy and commands](../../docs/ci/incremental.md)
and [measured results](../../docs/ci/1699-results.md).

Selected reusable jobs consume CI's trusted decision without running another
selector, as Orca routes its checks by path. On a pull request the selector
reports `desktop` only for a change that can reach the Desktop suite:
`apps/desktop/**`, `packages/protocol/**`, `desktop.yml`, any file in the Nx
closure of `@mikka/desktop` and of the files `desktop.yml` runs directly
(`test:platform`, its `node` scripts), `pnpm-workspace.yaml`/`nx.json`, and a
`pnpm-lock.yaml` or root `package.json` change that alters Desktop's
dependency closure or a root script it runs (`scripts/ci/desktop-inputs.mjs`).
A global input alone (`scripts/`, other workflows, configs) does not select it.
Merge groups and the daily run keep the broad rule, so a merge still runs
Desktop for every global input. CI's `desktop-checks` job then calls
`desktop.yml` with `selected: true` (`scripts/ci/select.test.mjs` dry-runs
this route). The Analytics and Desktop
conclusions contribute to `UI policy (strict)` and `CI OK`.
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

## Scheduled offline journeys and deployment route probes

`nightly-journey.yml` runs `pnpm test:e2e:mvp --grep @journey` in the daily
full CI run (03:23 UTC, `ui-policy.yml` job `nightly-journey`) and on manual
dispatch, on `main` of the canonical repository only. `CI OK` does not require
it yet: the journeys have never passed, so it joins `ci-ok`'s `needs` after the
first green scheduled run. Both guards use the repository id (`1427517699`), which survived the move
from `alexj11324/Mikka`; the former name guard skipped every scheduled run. It uses a fresh local PostgreSQL 17
`mikka_e2e` service and scripted LiteLLM, E2B, Slack and GitHub boundaries.
It does not read model keys or create a preview database. The `@p0` tag
identifies core journeys; it does not add browser execution to pull-request CI.

The nightly job restores the official compiled renderer from the successful
public service producer for its exact main source, using the normal Actions
artifact token only during that read. It verifies the original web build and
archive, compiles the local API/Eve, and reports the tested source separately
from the actual reused web source and private overlay SHA. Missing exact-source
publication fails the job. The evidence audit must pass before reports upload.
This proves the local scripted composition, not a live model or deployment.

`production-smoke.yml` runs daily at 14:17 UTC, on dispatch and after each
`Cloudflare application deployment` run (`workflow_run`) whose
`pipeline-production` job succeeded, that is, a run that promoted production;
it no longer wakes for every `deployment_status` event. It resolves the API's serving source through the anonymous
version endpoint and reads that immutable main commit's generated route list.
Its route probe uses undeclared methods, checking dispatch status and `Allow`
without credentials or business handlers; a missing route or 5xx fails before
the existing account sign-in and capability-read smoke. Internal production
rollout and flag deadlines follow the [production acceptance decision](../../docs/design/decisions/2026-11-20-1905-internal-production-acceptance.md).

## Engineering sandbox

`engineering-sandbox.yml` authenticates explicitly dispatched main jobs to the configured engineering Worker and runs the Factory handoff, startup-timing and isolated PostgreSQL 17 policy-migration suites there. External agents can dispatch a supported suite on a committed source SHA using the [engineering runner instructions](../../docs/operations/engineering-sandbox.md).

## On-demand integration-to-main promotion & overlay probe

`integration-to-main-promotion.yml` runs on manual `workflow_dispatch` on `main` (no background `schedule` cron), defaulting to read-only `dry_run=true` so operators and local agent automations can invoke the cross-repo compatibility probe without Actions noise or concurrent PR races, and opt into live sync/promotion with `-f dry_run=false`. It is split into four isolated jobs (`plan`, `auto-sync`, `verify-overlay-pairing`, and `promote`) coordinated by `scripts/ci/integration-promotion-probe.mjs`:

1. **`plan` (read-only metadata)**: Resolves the exact integration branch tip (`vars.MIKKA_INTEGRATION_BRANCH`, default `claude/affectionate-einstein-s235cb`) via `branches/<ref>`, checks ahead/behind counts and Ready child PRs (verifying any open `chore/auto-sync-main-*` PR includes both current `main` and the current integration base tip), reads the current approved `overlaySource` pin from `mikka-cloud/main` (`docs/operations/releases/deploy-build-inputs.json`) via the existing read-only source App, and checks whether a coordinated Ready integration PR exists on `mikka-hosted-ui`.
2. **`auto-sync` (conflict-free `main` back-merge)**: Whenever the integration branch has commits ahead of `main` (`ahead_by > 0`), is behind `main` (`behind_by > 0`), and has zero open Ready feature child PRs, opens or forward-merges a clean `chore/auto-sync-main-*` PR targeting the non-`main` integration branch (never force-pushing, `-c core.hooksPath=/dev/null --no-verify`, refreshing both `main` and the integration base if either advanced, replacing a stale sync PR cleanly if only the stale intermediate sync tree conflicts while the live tips merge cleanly, and aborting cleanly on genuine live-tip conflicts), records verified `CI` evidence once aggregator checks pass, re-verifies live base-tip identity immediately before writing, and merges via a normal merge commit (`--merge --delete-branch --match-head-commit`).
3. **`verify-overlay-pairing` (network-isolated cross-repo compatibility probe)**: Stages `integration-promotion-probe.mjs` strictly from `main`, scrubs all App/OIDC credentials, pre-installs separate `integration/` and `main/` checkouts (`--frozen-lockfile --ignore-scripts`), stages each candidate overlay as an independent local Git checkout in `integration/.hosted-ui` installed with `--prod --ignore-scripts --frozen-lockfile` (matching `scripts/release/service-build-ci.mjs`), and executes the official Web build (`apps/frontend/scripts/build.mjs web`), UI action/read-cache contract, release audit (`scripts/release/hosted-ui.mjs audit`), and zero-regression `tsrs --noEmit --incremental false` delta against the separate read-only `main/` checkout inside a digest-pinned `node:24.22.1-trixie` container (`--network none --cap-drop ALL --security-opt no-new-privileges`, read-only `.git` mounts, allowlist-only environment with zero `GITHUB_*`, `ACTIONS_*`, or `RUNNER_*` access). Emits strictly public-safe booleans, counts, and TS error codes — zero private overlay paths or source lines — and deletes `.hosted-ui` and build output in `always()`.
4. **`promote` (clean metadata-only merge-queue promotion)**: `merge-queue-autopilot.yml` explicitly excludes the configured integration branch so `integration-to-main-promotion.yml` is the sole automated enqueue path. Only a compatible approved `pinned_overlay` (`deploy-build-inputs.json`) authorizes creating or enqueueing a `main` promotion PR by default (a passing `coordinated_ui_pr` is reported as readiness evidence only unless explicitly authorized via `vars.MIKKA_INTEGRATION_ALLOW_COORDINATED_UNPINNED_PROMOTE=true`; an explicit probe bypass requires `vars.MIKKA_INTEGRATION_SKIP_OVERLAY_PROBE=true`, never legacy `MIKKA_INTEGRATION_PROMOTE_TO_MAIN`; emergency pause uses `vars.MIKKA_INTEGRATION_PROMOTE_FREEZE=true`). Immediately before `create_pr` and `enqueue_pr`, `promote` re-verifies that live `main`, the integration branch tip, `behind_by == 0`, and open Ready child PR count did not drift during the overlay probe, then enqueues strictly via `enqueuePullRequest` (preserving full `merge_group` PostgreSQL coverage).


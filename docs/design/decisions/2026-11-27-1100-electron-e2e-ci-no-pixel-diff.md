# Hosted-UI CI runs targeted Electron e2e per PR and a nightly full suite, with no pixel comparison

- Date: 2026-11-27
- **Status:** Accepted
- Source: Alex, 2026-11-27 (lane B of the CI overhaul): follow Orca and run end-to-end tests in Electron, path-routed on PRs and in full nightly; a browser matrix on every PR is too slow. No screenshot or pixel comparison in CI, nightly or PR, as LobeHub and Orca do; screenshots only as failure artifacts.
- Rule: `mikka-hosted-ui/AGENTS.md` Tier 3 and "Visual verification (hard UI PR merge gate)"; runbook `mikka-cloud/docs/operations/hosted-ui-ci.md`
- Paths: code and script paths are in the private `mikka-hosted-ui` unless prefixed `mikka-cloud/` or public `aspectly-labs/Mikka`. The same record is kept in `mikka-hosted-ui/docs/design/decisions/`.
- Supersedes: [2026-11-26-0645-local-ui-visual-verification-no-ci-screenshots.md](2026-11-26-0645-local-ui-visual-verification-no-ci-screenshots.md) (browser-free hosted-UI CI). [2026-11-01-1520-no-browser-tests-in-ci.md](2026-11-01-1520-no-browser-tests-in-ci.md) still governs public Mikka's own CI.

## Decision

Hosted-UI CI (`mikka-cloud/cloudflare/hosted-ui-ci`, one Cloudflare Container per run) runs end-to-end tests in the real Electron app (Playwright `_electron` under Xvfb, Fixture Mode renderer, `e2e/electron/`), not a browser matrix. Assertions are DOM and behaviour only.

| When | What runs | Check (each says only what ran) |
| --- | --- | --- |
| Every Ready PR and `main` push | Phase 1: installs, builds, static policy, non-browser tests (`scripts/cloudflare-ci.mjs stages`, the same stage list Workers Builds runs) | `Cloudflare UI Fast Gate`, `Cloudflare UI Policy` (browser-free; the overlay promotion gate reads them) |
| Ready PR | The Electron specs `e2e/electron/routes.json` routes the change to: a changed spec runs itself, a harness or shared/global path runs every spec, no match runs none | `Cloudflare Electron E2E`: `success`, `failure`, `skipped` when nothing is routed (the summary says why), `neutral` when the trigger policy is `manual` (not run) |
| `main` push | The golden smoke (`@smoke` tests) | `Cloudflare Desktop Golden Smoke` |
| Nightly (`mikka-ops-scheduler`, 18:35 UTC) | Phase 1, every Electron spec, then the DOM layout audit (`scripts/nightly-layout-audit.mjs`: `universal-layout-audit.mjs` and the `real-ui-visual-evidence.mjs` DOM geometry ratchet with `REAL_UI_DOM_ONLY=1`; overflow, collisions, clipping, tab `×`/label collision, false overflow chevron, mobile drawer width) | `Cloudflare UI Nightly`, plus one tracking issue |

- No step in CI takes a screenshot of a passing view or compares pixels. `scripts/visual-pixel-diff.mjs` (the diff against a `main` baseline) is removed from CI: from the Worker, from the manual `ui-policy.yml` fallback and from `scripts/cloudflare-playwright-ci.mjs`. The Worker no longer runs the Playwright screenshot sweep at all, keeps no R2 baseline and posts no screenshot comments.
- A failing Electron test keeps a trace and a screenshot, and a failing layout view keeps a screenshot; both go to private R2 only (`<sha>/<run>/electron/…`, `…/layout/…`).
- A gate that did not run never reports `success`: the browser-free gates keep their names, and Electron results report only under the Electron check names above.
- The human-written `## Visual comparison` / `## 视觉对照` section in a UI PR stays: it is a review requirement, checked for presence by `scripts/pr-visual-evidence-check.mjs`, not a CI pixel comparison. Local `pnpm visual:local` stays the way to produce it.

## Golden persistence journeys (designed, not yet landed)

Load-and-click specs do not prove a setting is saved. Desktop writes go through the main-process proxy, so the suite also gets golden persistence journeys, after Orca's `golden-file-open-edit-save.spec.ts` (which does the same on disk):

1. change a value through the UI and wait for the write to succeed;
2. reload the window, then quit and relaunch Electron with the same user data directory, and check the value is still set;
3. read it back from the local API or store, not only from the DOM.

Plus one failure-path journey: the server answers 500 to a save, and the UI shows an error and reverts the control, never a false success.

- Specs: `e2e/electron/journey-*.spec.mjs`, tagged `@journey`. A small set (one per settings area the proxy carries, plus the 500 path) is picked from the pre-release Settings round-trip sweep (a Playwright `_electron` script written separately), not copied wholesale.
- Harness needs before they land: a fixture that relaunches the app on the same `userData` (today each test gets a fresh one), a Fixture store that survives a relaunch, a read-back hook for the local API/store, and per-route fault injection (one save answered with 500).
- When they run: every journey nightly (`--all`); on a PR, `routes.json` routes them to changes in the settings slots, bindings and pages (`slots/settings-*`, `lib/settings-*`, `lib/{general,models,notifications,preferences,secrets,security,members}/**`, `web/components/settings/**`) and in the renderer's RPC/proxy client (`core/lib/client-runtime/**`, `core/renderer/**`). Changes to the proxy and RPC on the public side are not in a hosted PR's diff; the nightly covers them until public CI can trigger hosted Electron runs.

## Why

- **Orca** ([stablyai/orca](https://github.com/stablyai/orca)), an Electron app like Mikka's desktop: PR e2e is path-routed to the specs a change touches and reported as one aggregate check; the full suite runs daily; a golden e2e runs on 3 OSes.
- **LobeHub** ([lobehub/lobe-chat](https://github.com/lobehub/lobe-chat), `.github/workflows/e2e.yml`): Cucumber + Playwright on Chromium on PR and push, screenshots uploaded only on failure, no visual diff and no nightly run.
- The full Playwright sweep that ran before 2026-11-26 took 11–37 minutes per run and timed out under contention; most of it was screenshot capture and pixel diffing, which caught no behaviour the DOM assertions miss and produced noise on every font or animation change. Targeted Electron specs take about a minute on a PR that touches a covered flow and nothing on one that does not.
- 2026-11-26-0645 turned hosted browser CI off entirely, which left no automatic end-to-end signal and let a gate report success without its browser stage. This record restores behaviour tests where they pay (Electron, routed) and keeps 0645's point that CI must not spend time on screenshots.

## Related

- The desktop route guard (public `apps/desktop/src/main/bundled-routes.test.ts`) needs the official UI, so it runs in hosted CI (`scripts/core-ui.test.mjs`) with `MIKKA_REQUIRE_OFFICIAL_UI=1`, which makes a skip a failure.

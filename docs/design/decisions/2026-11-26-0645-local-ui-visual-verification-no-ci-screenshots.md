# Local UI visual verification and browser-free hosted-UI CI

- Date: 2026-11-26
- **Status:** Superseded by [2026-11-27-1100-electron-e2e-ci-no-pixel-diff](2026-11-27-1100-electron-e2e-ci-no-pixel-diff.md)
- Source: Alex, 2026-11-26: 「你的意思是，我们现在截图走的是 CI 吗？我突然发现这个问题，这好像是错误的做法吧。我一直的要求是在本机真实去跑呀，怎么能够用 CI 去截图呢？这很浪费啊。」「选择方案A，立刻另开PR把这套机制改掉」
- Rule: —
- Aligns with: [2026-11-01-1520-no-browser-tests-in-ci.md](2026-11-01-1520-no-browser-tests-in-ci.md), [2026-11-01-1440-dev-workflow-local-first.md](2026-11-01-1440-dev-workflow-local-first.md)

## Decision

Stop running automatic remote browser/Playwright screenshot suites in `mikka-hosted-ui` / `mikka-cloud` CI. Keep hosted-UI CI fast and browser-free, and perform visual verification locally on targeted changed routes in cloud Linux using a real compiled build and local Chrome/Chromium.

## Behavior

1. **Browser-free automatic hosted-UI CI:** `mikka-cloud` (`cloudflare/hosted-ui-ci`) and `mikka-hosted-ui` (`Workers Builds`) execute only fast non-browser checks on Ready PRs and `main` pushes — `paid-overrides`, `pr-visual-evidence-check`, `oxlint` (`pnpm lint`), `frontend-best-practices-policy`, non-browser hosted unit tests, official Web Vite build, and `bundle-budget`. Draft PR webhooks are ignored so Draft checkpoints launch zero CI containers.
2. **Targeted local visual verification (cloud Linux):** Developers and agents verify UI changes locally in cloud Linux with `pnpm --dir mikka-hosted-ui visual:local --target <slug>` (`mikka-hosted-ui/scripts/local-visual-verify.mjs`) against the real compiled app build using local Chrome/Chromium via CDP (no Playwright download required, no 200-route full capture), inspect rendered Desktop (`1440×900`) and Mobile (`390×844`) Light/Dark PNGs directly, and document findings in the PR's `## Visual comparison` / `## 视觉对照` section.
3. **Promotion gate decoupled from CI screenshot archives:** `mikka-cloud/scripts/verify-hosted-ui-gates.mjs` and `overlay-source-sync.mjs` require passing static `Cloudflare UI Policy` and `Cloudflare UI Fast Gate` / `Workers Builds` on `main` without requiring a remote CI-uploaded `ui-visual-evidence.zip` artifact (optional when explicitly requested via `--require-visual-artifact`).
4. **Opt-in full-suite audit only:** Full Playwright visual/E2E/layout scripts (`mikka-hosted-ui/scripts/cloudflare-playwright-ci.mjs`, manual `workflow_dispatch`, or operator `/dispatch` with `runBrowserVisual: true`) remain manual opt-in tools only and never run automatically on PRs or `main` pushes.

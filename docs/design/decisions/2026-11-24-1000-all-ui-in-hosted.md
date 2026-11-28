# All interface code lives in mikka-hosted-ui

**Status:** Accepted (Alex, 2026-11-24: 「主仓库里面的 UI 不是应该全部删掉的吗？」). Completes phase 4 of
[2026-11-22-2205](2026-11-22-2205-headless-public-engine-and-ui-decoupling.md) and supersedes its first point where
it kept public authentication, server-status and connection pages in this repository. Builds on
[2026-11-08-2133](2026-11-08-2133-one-ui.md) (one UI; a build without the private repository only has to compile).

## Decision

1. **This repository carries no web or desktop interface.** Base components (`components/`), interface hooks
   (`hooks/`, and the React hooks only the interface used), the global stylesheet and fonts, the client runtime's
   React pieces (`lib/client-runtime/{dynamic,lazy-dialog,link,localized-navigation,script}.tsx`,
   `lib/presence-gate.tsx`) and the whole client application (`apps/desktop/src/renderer/{app,index,platform,…}.tsx`,
   `apps/frontend/src/web/platform.tsx`) moved to `mikka-hosted-ui`'s `core/` at the same relative paths. The two
   slot contracts moved to its `slots/`. Code the mobile app shares (`lib/hooks/chat-delivery-state.ts`,
   `use-decision-submission.ts`, `use-task-continuation.ts`), API clients and caches stay here.
2. **The build contract is one directory, not slots.** An official build sets `MIKKA_UI_OVERLAY_DIR` (and, for a
   release, `MIKKA_UI_OVERLAY_SHA`); `lib/ui-overlay.mjs` requires the checkout's `core/renderer/` application
   (`index.tsx`, `platform.tsx`, `web/platform.tsx`, `auth-form.tsx`, `styles.css`) and resolves `@hosted/*` into it.
   `@ui-slot/*` is retired for web and desktop (the mobile app keeps its own). The checkout imports this repository's
   runtime through `@/` and never the other way round.
3. **A build without the checkout serves a page that says so.** `apps/frontend/src/headless.ts` is the web page and
   the desktop test renderer. A production desktop build without the checkout refuses
   (`DESKTOP_PRODUCTION_BUILD_REQUIRES_OFFICIAL_UI`). A server built from this repository alone, including a
   self-built Docker image, has the API and no browser pages: the official Web, Desktop and iOS clients sign in to it.
4. **The rules follow the code.** The UI policies here read the checkout through `scripts/official-ui-tree.mjs` and
   skip without it; `mikka-hosted-ui`'s CI runs them, and this repository's web and desktop build tests, against its
   own commit (`scripts/core-ui.test.mjs` there). `scripts/no-public-ui.test.mjs` keeps interface source,
   stylesheets, fonts, `components/`, `hooks/`, `@ui-slot/` imports and paid libraries out of this repository.

## Merge order

The two PRs merge public first, then `mikka-hosted-ui`. Between the two merges an official build of public `main`
with hosted `main` does not compile (hosted `main` still expects the slots); release from `main` waits for both.

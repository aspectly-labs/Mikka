# Headless public engine and standalone UI decoupling

Status: accepted (Alex, 2026-11-22); completed and, where it kept public sign-in and status pages, superseded by [2026-11-24-1000](2026-11-24-1000-all-ui-in-hosted.md). Builds on [2026-11-08-2133](2026-11-08-2133-one-ui.md) and supersedes the long-term overlay direction in [2026-11-06-2000](2026-11-06-2000-hosted-ui-overlay.md). Tracked by [issue #3174](https://github.com/aspectly-labs/Mikka/issues/3174).

## Decision

1. **Move public `Mikka` toward a headless engine and API server.** Over the phased migration in `#3174`, the public repository retains the execution engine, HTTP/RPC APIs, Live push, LiteLLM model gateway, database schema, CLI, `@mikka/protocol`, local `daemon`, and public authentication / server-status / connection pages. The full product Web UI moves into a standalone frontend application inside the private `aspectly-labs/mikka-hosted-ui` repository rather than being injected back into public Vite builds via `@ui-slot/*`.
2. **Decouple UI view models from backend scheduling projections.** UI pages must read and project their own domain view models (for example, an owner's full model catalogue in fixed credential/source order) instead of deriving list structure from backend dispatch/scheduling projections (such as filtered dispatch candidates or routing fallback arrays).
3. **Verify real user workflows with Playwright + PostgreSQL 17 E2E regressions.** UI state changes that compose catalogue state, backend mutations, reloads, and navigation must be verified with Playwright against a real PostgreSQL 17 database and real compiled build (first exercised in `aspectly-labs/mikka-hosted-ui#277`).

## Why

Tight build-time coupling through 54 `@ui-slot/*` overlay bindings across two repositories created cross-repo contract skew (requiring simultaneous matching commits in `Mikka` and `mikka-hosted-ui` just to compile) and caused UI bindings to mirror backend scheduling arrays (`order.data.candidates`), which drop disabled models and alter card/row ordering when toggled.

## Phased Migration (`#3174`)

1. **Phase 1 — Decouple view models & formalize headless contracts:** Ship immediate catalogue/scheduling decoupling (`aspectly-labs/mikka-hosted-ui#277`) and stabilize public HTTP/RPC contracts so UI views never depend on scheduling side effects.
2. **Phase 2 — Build standalone UI in `mikka-hosted-ui`:** Replace bundler slot injection with a standalone UI app consuming Mikka APIs directly, achieving Playwright E2E parity.
3. **Phase 3 — Cut over release pipelines:** Switch Web/Desktop/API/Docker CI and Cloudflare deployment pipelines (`apps/api`, `cloudflare-api-image.yml`, `desktop-release.yml`, `#1954`) to deploy the headless engine alongside the standalone private UI.
4. **Phase 4 — Remove legacy public product Web UI:** Delete obsolete `@ui-slot/*` plumbing and legacy public product UI components after Phases 1–3 complete.

## What this does not change yet

Existing `components/`, `apps/frontend/`, and `@ui-slot/*` slot contracts stay in place and remain active until Phases 1–3 are completed and cut over. Do **not** delete public UI files prematurely before the release pipelines switch away from `MIKKA_UI_OVERLAY_DIR=.hosted-ui`.

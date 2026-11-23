# The iOS app lives in the private UI repository

Status: accepted (Alex, 2026-11-23: 「迁移 mobile app 到私有 hosted UI 仓库，和 web 一样」). Applies [2026-11-22-2205](2026-11-22-2205-headless-public-engine-and-ui-decoupling.md) to the iOS app ahead of the Web cut-over.

## Decision

1. **The Expo app moves whole from `apps/mobile` to `mikka-hosted-ui` `mobile/`.** It already depended on paid beUI React Native sources and on the private paper bot avatar; the public repository no longer carries it, and there is no open-source iOS build.
2. **The engine stays public.** `app/api/mobile/*`, the `lib/` modules the app imports by relative path, `messages/` and `@mikka/protocol` remain here. The app is built from a public checkout with the private repository at `.hosted-ui`, as the Web UI is.
3. **Official workflows stay here.** `mobile-update.yml`, `mobile-native.yml` and `mobile-screenshots.yml` check out the reviewed private revision and work in `.hosted-ui/mobile`. The native EAS upload is rooted at this checkout (`EAS_NO_VCS=1`, `EAS_PROJECT_ROOT`), so the shared engine code travels with the app. Public pull requests publish no mobile previews.
4. **One bot avatar.** iOS and Web draw the same BoardUI paper avatar from one mapping, `botPaper` in the private `components/mikka/bot-paper.ts` (colour, shape, id, Coordinator and mood). The `bot-avatar` mobile slot and its open-source still blob are gone.
5. **Checks follow the code.** The app's tests, its polling and focus-listener allowlists and its i18n baseline run in the private repository (`mobile/scripts/policies.mjs`, with the engine's own checkers). Engine modules whose acceptance tests lived in the app are covered by `lib/shared-client-contracts.test.ts`.

## Consequences

- The production OTA receipt is version 2 (inputs: `packages/protocol` and the private `mobile` tree). A version 1 receipt still serves as the baseline, so the move itself needs no owner bootstrap.
- A native build is always a manual dispatch with `overlay_sha`; there is no path-filtered push trigger.
- The desktop app's `apps/desktop/build/icon.icon` is the public copy of the shared icon; the private app carries the same file.

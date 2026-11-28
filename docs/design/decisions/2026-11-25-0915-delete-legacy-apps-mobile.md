# Delete legacy 1.x `apps/mobile` client from public Mikka

- Date: 2026-11-25
- **Status:** Accepted
- Source: Alex's directive ("旧版iOS客户端直接删掉") and `aspectly-labs/Mikka#3280`
- Supersedes: `aspectly-labs/Mikka#3194` and `aspectly-labs/mikka-hosted-ui#298`

## Decision

1. **Delete legacy 1.x `apps/mobile/**` and its retired 1.x release workflows from public `aspectly-labs/Mikka`:**
   - The active Mikka 2.0 iOS client lives exclusively in private `aspectly-labs/mikka-hosted-ui/mobile-next/apps/mobile` and ships via `.github/workflows/mobile-next-ios.yml` (native TestFlight archive) and `.github/workflows/mobile-next-update.yml` (EAS OTA).
   - Legacy `apps/mobile/**`, `.easignore`, `.github/workflows/{mobile-update,mobile-native,mobile-screenshots}.yml`, and their legacy 1.x release/screenshot scripts are deleted completely.
2. **Preserve all backend mobile APIs and shared contracts:**
   - `app/api/mobile/**`, `lib/mobile-*.ts`, and backend mobile tests (`tests/mobile-*.test.ts`) stay intact because Mikka 2.0 (`mobile-next`) depends on them.
   - Shared engine modules previously exercised only by legacy `apps/mobile/tests/` are verified in `lib/shared-client-contracts.test.ts` (`test:lib-units`) and `lib/chat-failure.test.ts` (`test:mobile`).
3. **Keep `apps/desktop/build/icon.icon` as the public Icon Composer bundle:**
   - `.github/workflows/app-icon.yml` compiles and renders `apps/desktop/build/icon.icon` for both iOS and macOS on `macos-26`.
4. **Enforce zero public UI across the entire public repository:**
   - `scripts/no-public-ui.test.mjs` removes its `apps/mobile/` exemption and asserts that no `apps/mobile/` tree, UI `.tsx`/`.css`, font, or paid library returns to public `aspectly-labs/Mikka`.

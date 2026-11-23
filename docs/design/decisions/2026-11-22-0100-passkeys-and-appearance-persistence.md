# Passkey authentication and appearance persistence boundary

Scope: [settings backend supplement WS-E](https://github.com/aspectly-labs/Mikka/issues/3110),
supporting frames 02 (外观) and 04 (安全) of [#2957](https://github.com/aspectly-labs/Mikka/issues/2957).

## Decision

### 1. Passkey authentication and management (Frame 04, item I.15)

- Enable the official `@better-auth/passkey@1.7.12` plugin on the existing Better
  Auth `1.7.12` server (`lib/auth.ts`) and client (`lib/auth-client.ts`).
- Relying Party identity (`rpID`) and allowed WebAuthn origins (`origin`) derive
  from `authBaseURL` and the configured HTTP(S) `authEffectiveTrustedOrigins`,
  keeping Web, Desktop handoff, preview and self-hosted origins on one source.
- Existing TOTP enrollment, verification, recovery codes and organization
  `requireTwoFactor` session gates (`lib/enterprise/two-factor.ts`,
  [2026-11-20-1900](2026-11-20-1900-settings-organization-security.md)) remain
  unchanged:
  - Enrolling, renaming or deleting a passkey (`/passkey/generate-register-options`,
    `/passkey/verify-registration`, `/passkey/update-passkey`,
    `/passkey/delete-passkey`, `PATCH/DELETE /api/me/passkeys/:passkeyId`, and
    Desktop RPC `passkeys.renamePasskey` / `passkeys.deletePasskey`) enforces
    `assertTwoFactorManagement(userId, sessionId)` so an unverified session on a
    2FA-enrolled account cannot silently register, rename or remove passkeys.
  - Passkey authentication (`/passkey/verify-authentication`) emits durable
    workspace audit intent with `method: 'passkey'` through `auditAuthentication`
    and withholds the new session and cookie journal if audit persistence fails.
  - Organizations enforcing `requireTwoFactor` continue to require an explicit
    TOTP or recovery-code receipt on each human session.
- Provide a safe read/rename/delete management surface (`GET /api/me/passkeys`,
  `PATCH /api/me/passkeys/:passkeyId`, `DELETE /api/me/passkeys/:passkeyId`,
  `GET /api/me/security` `passkeyCount`, and Desktop RPC `passkeys.*`) that
  omits raw `publicKey`, `credentialID` and signature `counter` values while
  exposing `id`, `name`, `providerName`, `deviceType`, `backedUp`, `transports`,
  `createdAt` and `aaguid`.

### 2. Appearance persistence vs client-only state (Frame 02, item H.14)

- Cross-device personal appearance preferences (`appearanceSync`,
  `appearanceColorScheme`, `appearanceTheme`, `appearanceAccentColor`,
  `appearanceBackgroundEffect`, `codeFontSize`, `diffView`, `diffColors`,
  `hiddenFiles`) belong to the P1 typed `SETTINGS_REGISTRY` (`scope: ['personal']`,
  `personalContext: 'account'`, `page: 'appearance'`, persisted in generic
  `personal_setting_values` with `{ value, source: 'personal' | 'default' }` and
  zero dedicated `user_preferences` SQL columns).
- **Pure client-only appearance state** intentionally has no server persistence:
  - Per-device local theme and color-scheme overrides when `appearanceSync === false`
    (stored in browser `next-themes` `localStorage` / local desktop storage so
    turning sync off keeps devices independent).
  - Unsaved custom theme editor drafts before save and local OS/browser media
    queries (`prefers-color-scheme`, `prefers-reduced-motion`).
  - Binary wallpaper/custom asset uploads (not part of the appearance contract).

## HTTP and Desktop RPC contract

| Surface | Authorization | Request / Response |
| --- | --- | --- |
| Native `/api/auth/passkey/*` | Registration/update/delete require active human session + `assertTwoFactorManagement` when 2FA is enabled | Native `@better-auth/passkey` WebAuthn ceremonies |
| `GET /api/me/passkeys` | Fresh human session (`401` unauthenticated, `403` PAT) | `{ passkeys: PasskeySummary[] }` |
| `PATCH /api/me/passkeys/:passkeyId` | Same + same-origin + `assertTwoFactorManagement` (`403` unverified 2FA, `404` non-owner/missing) | `{ name }` -> `{ passkey: PasskeySummary }` |
| `DELETE /api/me/passkeys/:passkeyId` | Same + same-origin + `assertTwoFactorManagement` (`403` unverified 2FA, `404` non-owner/missing) | `{ deleted: true }` |
| `GET /api/me/security` | Fresh human session | Adds `passkeyCount: number` to `PersonalSecurityState` |
| Desktop RPC `passkeys.listPasskeys` / `renamePasskey` / `deletePasskey` | Authenticated Desktop session + `assertTwoFactorManagement` on mutations | Typed `PasskeyActionResult<...>` |

## Persistence and rollback

Additive repeatable migration `20261122005446_passkey_authentication.sql` creates
`"passkey"` in `MIKKA_DATABASE_URL` with `ON DELETE CASCADE` to `"user"(id)`,
unique `"credentialID"`, and `"userId"` index. Cold-start schema validation
remains disabled (`validateSchema: false`). Account deletion removes owned
`"passkey"` rows automatically via `OWNER_COLUMNS` (`"userId"`) and FK cascade.
Rollback retains `"passkey"` data after reverting code.

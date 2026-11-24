# Public configuration rename (NEXT_PUBLIC_* to MIKKA_PUBLIC_*)

Mikka no longer uses Next.js, but its public build settings kept the
framework's `NEXT_PUBLIC_*` prefix. The rename has two phases.

- **Phase 1 (done in code).** Every reader takes the new name first and falls
  back to the legacy one (`lib/public-env.mjs`). Vite and Nitro inline each
  public constant under both names. The Cloudflare API ingress forwards both
  names. The `API_PUBLIC_BUILD_SETTINGS` secret may use either key for each
  setting. Production keeps working with its current configuration.
- **Phase 2 (this checklist).** Rename the configuration, verify production,
  then delete the old names and the fallback.

This page names keys only. Never copy a value into a ticket, log, PR or chat;
copy values inside the secret manager.

## Name map

| New name | Legacy name | Where the repository shows it is set |
| --- | --- | --- |
| `MIKKA_PUBLIC_POSTHOG_KEY` | `NEXT_PUBLIC_POSTHOG_KEY` | Key in the GitHub secret `API_PUBLIC_BUILD_SETTINGS`; Infisical `prod:/vercel` (read by `production-smoke.yml` and `run-trace-acceptance.yml`); Cloudflare API runtime binding; each Linear Worker |
| `MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Key in `API_PUBLIC_BUILD_SETTINGS`; Cloudflare API runtime binding |
| `MIKKA_PUBLIC_TURNSTILE_SITE_KEY` | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Key in `API_PUBLIC_BUILD_SETTINGS` |
| `MIKKA_PUBLIC_COMPUTER_ENABLED` | `NEXT_PUBLIC_COMPUTER_ENABLED` | Key in `API_PUBLIC_BUILD_SETTINGS` |
| `MIKKA_PUBLIC_COMPUTER_ACCEPTANCE` | `NEXT_PUBLIC_COMPUTER_ACCEPTANCE` | Only an isolated Preview, if any (`.env.example`) |
| `MIKKA_PUBLIC_COMPUTER_MOCK` | `NEXT_PUBLIC_COMPUTER_MOCK` | Local development only |
| `MIKKA_PUBLIC_COMPUTER_DEPLOYMENT` | `NEXT_PUBLIC_COMPUTER_DEPLOYMENT` | Not configured; derived from `MIKKA_DEPLOYMENT_STAGE` at build time |
| `MIKKA_PUBLIC_BUILD` | `NEXT_PUBLIC_MIKKA_BUILD` | Not configured; set by `scripts/cloudflare-ci.mjs` and `scripts/cloudflare-runtime-release.mjs` from the commit |
| `POSTHOG_HOST` (existing name) | `NEXT_PUBLIC_POSTHOG_HOST` | Optional; not set by any workflow |
| `MIKKA_DAEMON_PACKAGE_NAME` (existing name) | `NEXT_PUBLIC_MIKKA_DAEMON_PACKAGE_NAME` | Optional; the default package name applies when unset |

No workflow reads a `NEXT_PUBLIC_*` GitHub secret or variable directly
(`secrets.NEXT_PUBLIC_*` or `vars.NEXT_PUBLIC_*`). The public build settings
reach the build only through the JSON secret `API_PUBLIC_BUILD_SETTINGS`
(`cloudflare-api-image.yml`). The private operations repository owns the
Cloudflare Worker secrets and any remaining Vercel project environment; check
there for any other copy of a legacy name.

## Phase 2 checklist

1. **Add the new names.** Copy each value inside its secret manager:
   - [ ] Infisical, project Mikka, `prod:/vercel`: add `MIKKA_PUBLIC_POSTHOG_KEY`
         with the value of `NEXT_PUBLIC_POSTHOG_KEY`. Add a `MIKKA_PUBLIC_*`
         copy of any other `NEXT_PUBLIC_*` key you find there.
   - [ ] GitHub secret `API_PUBLIC_BUILD_SETTINGS`: rewrite its JSON keys to
         `MIKKA_PUBLIC_POSTHOG_KEY`, `MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
         `MIKKA_PUBLIC_TURNSTILE_SITE_KEY` and `MIKKA_PUBLIC_COMPUTER_ENABLED`,
         values unchanged. Phase 1 accepts either key for each setting, but
         never both keys for one setting.
   - [ ] Cloudflare API Worker secrets: add `MIKKA_PUBLIC_POSTHOG_KEY` and
         `MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY`.
   - [ ] Each Linear Worker (and any Vercel project still serving): add
         `MIKKA_PUBLIC_POSTHOG_KEY`.
   - [ ] Workflows: change `secret-name: NEXT_PUBLIC_POSTHOG_KEY` to
         `MIKKA_PUBLIC_POSTHOG_KEY` in `production-smoke.yml` and
         `run-trace-acceptance.yml`, and the pin in
         `scripts/ops/run-trace-benchmark.test.ts`.
   - [ ] The hosted UI layer (`.hosted-ui`): replace every
         `process.env.NEXT_PUBLIC_*` read with the new name. Until then the
         build's legacy aliases keep it working.
2. **Verify production** on a release built after step 1:
   - [ ] `cloudflare-api-image.yml` builds with the rewritten
         `API_PUBLIC_BUILD_SETTINGS`.
   - [ ] The deployed web bundle sends PostHog events, shows the Turnstile
         widget on sign-up, mounts embedded Stripe checkout for a chat top-up,
         and shows the 电脑 tab as before.
   - [ ] `production-smoke.yml` passes, including the egress monitor's
         PostHog publish, and a controlled-failure run of
         `run-trace-acceptance.yml` exports its traces.
   - [ ] Linear sync still reads its flag (it stays off without the token).
3. **Delete the old names.**
   - [ ] Infisical `prod:/vercel`: delete `NEXT_PUBLIC_POSTHOG_KEY` and any
         other `NEXT_PUBLIC_*` key copied in step 1.
   - [ ] Cloudflare API Worker secrets: delete `NEXT_PUBLIC_POSTHOG_KEY` and
         `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.
   - [ ] Linear Workers and any Vercel project: delete `NEXT_PUBLIC_POSTHOG_KEY`.
4. **Delete the fallback** in one PR:
   - [ ] Remove `LEGACY_PUBLIC_ENV` and the legacy branches from
         `lib/public-env.mjs`, its `withLegacyPublicDefines` and
         `withLegacyPublicNames` call sites, and the legacy-key branch of
         `buildEnvironment` in `scripts/cloudflare-native-oci.mjs`.
   - [ ] Make `scripts/next-free-env.test.mjs` allow no `NEXT_PUBLIC_*` name
         outside docs, and drop the "still accepted" lines from `.env.example`
         and the docs.

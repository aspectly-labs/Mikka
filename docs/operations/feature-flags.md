# Feature flags

Flag keys, release flags, production defaults and issue dependencies are generated from `lib/feature-flags.ts`. Edit the source, then run `pnpm docs:generate`.

A release flag stages a risky change (internal, a small percentage, then 100%) and is deleted by its `removeBy` date (at most 60 days after `added`, 14 days after `fullAt`); `pnpm docs:check` warns 7 days before, fails after that date, and fails on a flag read whose key no registry declares (decision `mikka-hosted-ui/docs/design/decisions/2026-11-27-0330-staged-rollout-release-flags.md`, `scripts/feature-flags-policy.mjs`).

<!-- generated:feature-flags -->
Source: `lib/feature-flags.ts`.

| Gated feature | PostHog key | waitsOn |
| --- | --- | --- |
| `cloudComputer` | `mikka-cloud-computer` | — |
| `computerBilling` | `mikka-computer-billing` | — |
| `memory` | `mikka-memory` | — |

No release flags.

| Production default key | Default when PostHog is absent |
| --- | --- |
| `mikka-cloud-computer` | `true` |
| `mikka-computer-billing` | `false` |
| `mikka-memory` | `false` |
| `mikka-byos-subscription-chat` | `true` |
| `mikka-byos-subscription-native` | `true` |
| `mikka-email-sign-in-off` | `false` |
| `mikka-computer-tab-off` | `false` |
| `mikka-proactive-profile` | `false` |
| `mikka-proactive-research` | `false` |
| `mikka-upcoming-product-features` | `false` |
| `mikka-upcoming-integrations` | `false` |
| `mikka-upcoming-administration` | `false` |
| `mikka-upcoming-team-settings` | `false` |
<!-- /generated:feature-flags -->

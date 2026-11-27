# Feature flags

Flag keys, production defaults and issue dependencies are generated from `lib/feature-flags.ts`. Edit the source, then run `pnpm docs:generate`.

<!-- generated:feature-flags -->
Source: `lib/feature-flags.ts`.

| Gated feature | PostHog key | waitsOn |
| --- | --- | --- |
| `cloudComputer` | `mikka-cloud-computer` | — |
| `environmentSnapshots` | `mikka-environment-snapshots` | — |
| `computerBilling` | `mikka-computer-billing` | — |
| `memory` | `mikka-memory` | — |

| Production default key | Default when PostHog is absent |
| --- | --- |
| `mikka-cloud-computer` | `true` |
| `mikka-computer-billing` | `false` |
| `mikka-memory` | `false` |
| `mikka-environment-snapshots` | `false` |
| `mikka-byos-subscription-chat` | `true` |
| `mikka-byos-subscription-native` | `true` |
| `mikka-email-sign-in-off` | `false` |
| `mikka-computer-tab-off` | `false` |
| `mikka-proactive-profile` | `false` |
| `mikka-proactive-research` | `false` |
| `mikka-track-owner-clicks` | `false` |
| `mikka-upcoming-product-features` | `false` |
| `mikka-upcoming-integrations` | `false` |
| `mikka-upcoming-administration` | `false` |
| `mikka-upcoming-team-settings` | `false` |
<!-- /generated:feature-flags -->

# Staged rollout of risky changes behind release flags

- Date: 2026-11-27
- **Status:** Accepted
- Source: Alex, 2026-11-27: risky new features roll out in stages behind remote feature flags, as Codex does.
- Rule: AGENTS.md "Scope, triage & ship-on"; HANDBOOK Stage 5 "Ship features on"; R-76
- Aligns with: [2026-11-02-1700-feature-switches-in-posthog.md](2026-11-02-1700-feature-switches-in-posthog.md) (switches live in PostHog), the frozen 2026-10-30 "Finished features ship enabled" row in [`../decisions.md`](../decisions.md)

## Decision

A finished feature still ships enabled. Flags stay limited to four uses:

1. paid compute or model cost;
2. kill switches;
3. an explicit decision by Alex;
4. **new:** a staged rollout of a risky change.

A change is risky when it adds or replaces a surface that touches any of:

- billing, payment or credits;
- auth, sessions or permissions;
- writes to user data;
- cross-client contracts (Web, Desktop, iOS) or the desktop route allowlist;
- a large UI replacement.

Anything else ships enabled, with no flag.

## Staged rollout

- The change ships behind a PostHog **release flag**, declared in `releaseFlags` in `lib/feature-flags.ts` (PostHog key → `{ owner, description, added, fullAt?, removeBy }`).
- The flag is a gate: the new path runs only while PostHog answers exactly `true` for the person (`releaseFlagEnabled`; the official UI's `useReleaseFlag`).
- It widens in three stages: internal (Alex's account or the internal cohort), then a small percentage, then 100%. A stage moves only once error telemetry for the feature is clean (PostHog error tracking and traces for its routes).
- `owner` moves the stages and deletes the flag. `added` is the day the entry lands. `fullAt` is set the day the flag reaches 100%. `removeBy` is at most 60 days after `added` and at most 14 days after `fullAt`.
- At 100% the flag, its registry entry and the dead branch are deleted in one PR.

## Every flag

- **Fails safe.** Each flag has a documented default, which applies while flags are loading or unreachable and in self-hosted builds with no PostHog key (`PRODUCTION_FLAG_DEFAULTS`, generated into [`feature-flags.md`](../../operations/feature-flags.md)). A release flag's default is always off, which is the previous behaviour. A self-hosted build gets the new path when the flag is deleted.
- **Evaluates the same way on every client.** There is one strict-true evaluation for the signed-in person's distinct id. Every client evaluates release flags through `CLIENT_FLAG_KEYS` in `lib/feature-flags.ts`, the one list of flags clients read: the Web asks PostHog for them in the browser, and Desktop gets them in its bootstrap snapshot, evaluated on the server for the same person. Desktop therefore picks up a flag change at its next bootstrap, not live. iOS reads no PostHog flags today; once it reads any, it reads them the same way, from the server's answer for the same keys.
- **Is enforced on the server when it guards security or billing.** The server checks the same key (`serverFlagEnabled` or `deploymentSwitch`) before it acts. The client copy only decides what the UI shows.

## Enforcement

- **Types.** `FlagKey` (`lib/feature-flags.ts`) is the union of every key the registries declare. The flag readers take only a `FlagKey`: `postHogFlag` (`lib/analytics/posthog.ts`), `serverFlagEnabled` (`lib/posthog-server.ts`), `productionFlagDefault`, and the official UI's hooks, which take a registry name (`GatedFeature`, `UpcomingFeature`, `ReleaseFlag`). An undeclared key, or a wrapper that passes a plain `string`, fails `pnpm typecheck`.
- **Scan.** `scripts/feature-flags-policy.mjs` is the backstop, with counterexamples in `scripts/feature-flags-policy.test.mjs`. It runs in `pnpm docs:check` (protected `UI policy (strict)` CI and `pnpm lint`). In `mikka-hosted-ui`, `pnpm lint` runs it with `--overlay-only` against that checkout (`scripts/feature-flags-check.mjs`), with public main as the parent directory, in both Phase 1 drivers. It fails when:
  - a release flag lacks an owner or a description, has an invalid date, has `added` in the future or after `removeBy`, has `removeBy` more than 60 days after `added` or more than 14 days after `fullAt`, or is past its `removeBy` date. From 7 days before `removeBy` it prints a warning without failing, so the owner acts before CI turns red at 00:00 UTC the day after;
  - a flag read (`postHogFlag`, `serverFlagEnabled`, `productionFlagDefault`, `getFeatureFlag`, `isFeatureEnabled`, `useFeatureFlag*`, or `flags['mikka-…']`) names a key, as a literal or a same-file string constant, that is not declared as a flag in a registry (`FLAG_REGISTRIES`: `lib/feature-flags.ts`, `lib/deployment-switches.ts`, `lib/runtime-config/schema.ts`, `lib/linear-sync/flags.ts`, `lib/subscription-routes.ts`).
- **Gaps the scan does not close.** Keys built in template strings with substitutions, readers reached through computed callees (`client[method](key)`), and bulk reads such as `getAllFlags()`. The types cover the first two for the typed readers; a bulk read must be reviewed by hand.

The registry starts empty. No existing flag is converted.

## Why

- **Practice.** Staged gates are standard practice for large products: a gate opens first to employees, then to a percentage of users, then to everyone, and is rolled back by turning it off, which needs no release. OpenAI announced its acquisition of Statsig, a feature-gate and experimentation platform, in September 2025, saying Statsig "played a central role in how we ship".
- **Evidence this week.** Desktop release 2026.10000.1939 shipped broken panels to every user at once (commit 4acec0b05 records it: its main process refused fourteen routes the renderer needs). A release flag would have limited the break to the internal stage. Turning the flag off would have reverted each desktop at its next bootstrap, without a new desktop build.
- **Cost of flags.** Flags left in place hide finished features and multiply code paths. That is why the 2026-10-30 rule allowed so few. Owners and bounded `removeBy` dates, checked in CI, keep release flags short-lived.

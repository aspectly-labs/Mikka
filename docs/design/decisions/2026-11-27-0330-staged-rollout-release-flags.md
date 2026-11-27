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

- The change ships behind a PostHog **release flag**, declared in `releaseFlags` in `lib/feature-flags.ts` (PostHog key → `{ owner, removeBy, description }`).
- The flag is a gate: the new path runs only while PostHog answers exactly `true` for the person.
- It widens in three stages: internal (Alex's account or the internal cohort), then a small percentage, then 100%. A stage moves only once error telemetry for the feature is clean (PostHog error tracking and traces for its routes).
- `owner` moves the stages and deletes the flag. `removeBy` is a date at most about two weeks after the flag reaches 100%.
- At 100% the flag, its registry entry and the dead branch are deleted in one PR.

## Every flag

- **Fails safe.** Each flag has a documented default, which applies while flags are loading or unreachable and in self-hosted builds with no PostHog key (`PRODUCTION_FLAG_DEFAULTS`, generated into [`feature-flags.md`](../../operations/feature-flags.md)). A release flag's default is always off, which is the previous behaviour. A self-hosted build gets the new path when the flag is deleted.
- **Evaluates the same way on Web, Desktop and iOS.** There is one strict-true evaluation for the signed-in person's distinct id. Desktop and iOS take the server's answer instead of evaluating the flag on their own terms. For Desktop that answer is the bootstrap snapshot in `lib/desktop-rpc/features.ts`, which includes every release flag.
- **Is enforced on the server when it guards security or billing.** The server checks the same key (`serverFlagEnabled` or `deploymentSwitch`) before it acts. The client copy only decides what the UI shows.

## Enforcement

`scripts/feature-flags-policy.mjs` runs in `pnpm docs:check` (protected `UI policy (strict)` CI and `pnpm lint`). Its counterexamples are in `scripts/feature-flags-policy.test.mjs`. It fails when:

- a release flag lacks an owner or a description, has an invalid `removeBy`, or is past its `removeBy` date;
- a flag read (`postHogFlag`, `serverFlagEnabled`, `getFeatureFlag`, `isFeatureEnabled`, `useFeatureFlag*`, `flags['…']`) names a key, as a literal or a same-file string constant, that no flag registry declares (`lib/feature-flags.ts`, `lib/deployment-switches.ts`, `lib/runtime-config/schema.ts`, `lib/linear-sync/flags.ts`, `lib/subscription-routes.ts`).

The registry starts empty. No existing flag is converted.

## Why

- **Practice.** OpenAI ships Codex and ChatGPT features behind Statsig feature gates. OpenAI acquired Statsig in 2025. A gate opens first to employees, then to a percentage of users, then to everyone, and is rolled back by turning it off. Rollback is a flag change and needs no release.
- **Evidence this week.** Desktop release 2026.10000.1939 shipped broken panels to every user at once. A release flag would have limited the break to the internal stage, and turning the flag off would have rolled it back without a new desktop build.
- **Cost of flags.** Flags left in place hide finished features and multiply code paths. That is why the 2026-10-30 rule allowed so few. Owners and `removeBy` dates, checked in CI, keep release flags short-lived.

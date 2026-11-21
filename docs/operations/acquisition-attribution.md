# Acquisition attribution (source → signup)

First-touch acquisition is shared between `aspectlylabs.com` (mikka-web) and
`app.aspectlylabs.com` (this repo) through one bounded cookie and PostHog.

## Data flow

1. **Marketing pageview** — mikka-web sends a sanitized `$pageview` to the same
   PostHog project (`app = mikka-marketing`): host, path, `$referring_domain`
   and bounded `utm_*` labels only. It also writes `mikka_first_touch_v1`
   (`Domain=aspectlylabs.com; SameSite=Lax; Max-Age=30d`) preserving the first
   external touch across internal navigation.
2. **App pageview** — `instrumentation-client.ts` lets the SDK save referrer /
   campaign params; `lib/analytics-policy.ts#source` keeps only bounded
   `utm_*`, `$entry_*` session fields, `$referring_domain` and
   `first_touch_*`. No query strings, fragments or raw URLs leave.
3. **Registration** — the Better Auth `user.create.after` hook captures
   `registration_completed` once per account (email and OAuth alike;
   sign-ins and failed attempts never reach it) with
   `firstTouchProperties(parseFirstTouch(cookie))` plus `test_account` for
   smoke accounts. `lib/first-touch.ts` re-validates every field server-side.

## Source → signup breakdown (PostHog)

Create a PostHog **Funnel**: `$pageview` (filter `app = mikka-marketing`) →
`registration_completed` (any order is wrong: require the pageview first).
Break down by `first_touch_source` (fall back: `utm_source`,
`$referring_domain`). Exclude `test_account = true`. `registration_completed`
fires once per user id, so the funnel's conversion is completed signups, not
sign-ins. Historical signups before this change carry no attribution and are
not backfilled.

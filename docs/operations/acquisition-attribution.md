# Acquisition attribution (source → signup)

First-touch acquisition is shared between `aspectlylabs.com` (mikka-web) and
`app.aspectlylabs.com` (this repo) through one bounded cookie and PostHog.

## Data flow

1. **Marketing pageview** — mikka-web sends a sanitized `$pageview` to the same
   PostHog project (`app = mikka-marketing`): host, path, `$referring_domain`
   and bounded `utm_*` labels only. It also writes `mikka_first_touch_v1`
   (`Domain=aspectlylabs.com; SameSite=Lax; Max-Age=30d`) preserving the first
   external touch across internal navigation.
2. **App pageview** — the SDK does not save referrer or campaign params
   (`lib/analytics/posthog-init.ts`): with either on it keeps the first page's
   raw URL and referrer and sends them, query and share token included, as
   `$initial_*` person properties on every `/flags` request, which no hook
   sanitizes. `lib/analytics-policy.ts#source` keeps only bounded
   `$session_entry_*` UTM labels and referring domain, and `first_touch_*`.
   No query strings, fragments or raw URLs leave
   (`tests/posthog-flags-privacy.test.mjs` runs the real SDK).
3. **Registration** — the Better Auth `user.create.after` hook captures
   `registration_completed` once per account (email and OAuth alike;
   sign-ins and failed attempts never reach it) with
   `firstTouchProperties(parseFirstTouch(cookie))` plus `test_account` for
   smoke accounts. `lib/first-touch.ts` re-validates every field server-side.

## Source → signup breakdown (PostHog)

The two sites do **not** share a visitor identity: mikka-web's anonymous
`distinct_id` never reaches the app (the app's SDK uses memory persistence by
design), and `registration_completed` is keyed to the account id. A cross-event
funnel cannot join them — the cookie is what carries attribution instead, so
the breakdown is read off `registration_completed` itself:

- **Trends/Insight** on `registration_completed`, break down by
  `first_touch_source` (then `first_touch_utm_source`,
  `first_touch_referrer_domain`). Exclude `test_account = true`. This gives the
  signups-by-source half with no identity join.
- Marketing-side volume comes from the marketing `$pageview`s grouped by
  `utm_source`/`$referring_domain`; it is a separate series, not a joined
  conversion.

`registration_completed` fires once per user id — completed signups, not
sign-ins. Historical signups before this change carry no attribution and are
not backfilled.

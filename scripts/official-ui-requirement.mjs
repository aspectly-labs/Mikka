// One switch for every public test that needs the official UI checkout (mikka-hosted-ui, mounted at
// MIKKA_UI_OVERLAY_DIR or .hosted-ui). Without the checkout such a test skips: a public or fork build has no
// interface to read. The CI lane that mounts the checkout sets MIKKA_REQUIRE_OFFICIAL_UI=1, and then a missing
// checkout is an error instead of a skip, so a suite that silently skipped cannot report green.
// Every test that reads the checkout skips through officialUiSkip: the shared `needsOfficialUi`
// (scripts/official-ui-tree.mjs, apps/desktop/scripts/official-ui.mjs, apps/frontend/scripts/application-test-build.mjs),
// the UI API route contract (scripts/ui-api-routes.test.mjs, also `test:desktop-release-guard`) and the tests that read
// one .hosted-ui file directly. scripts/official-ui-requirement.test.mjs fails on a test that skips on its own.

export const REQUIRE_OFFICIAL_UI = 'MIKKA_REQUIRE_OFFICIAL_UI'

/** Whether the environment requires the checkout. Unset, empty or `0` is off, `1` is on; anything else is a typo
 * that must not silently turn the requirement off. */
export function officialUiRequired(env = process.env) {
  const value = env[REQUIRE_OFFICIAL_UI]?.trim()
  if (!value || value === '0') return false
  if (value === '1') return true
  throw new Error(`OFFICIAL_UI_REQUIREMENT_INVALID: ${REQUIRE_OFFICIAL_UI} must be 1 or 0`)
}

/** The `skip` option for a test that needs the checkout: false when it is present, otherwise the reason to skip.
 * When the requirement is set, a missing checkout throws, which fails the test file at import. */
export function officialUiSkip(present, where, env = process.env) {
  // Read the switch first: a typo fails even on a machine that has the checkout.
  const required = officialUiRequired(env)
  if (present) return false
  if (required) {
    throw new Error(`OFFICIAL_UI_REQUIRED: ${REQUIRE_OFFICIAL_UI}=1 but the official UI checkout (${where}) is missing`)
  }
  return `needs the official UI checkout (${where}); mikka-hosted-ui CI runs it`
}

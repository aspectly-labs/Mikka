// R-42: every visible string lives in messages/. Mobile i18n debt was burned to
// 0 and is permanently locked at 0; never re-add files here.
const BASELINE = Object.freeze({})

/** Permanently empty (0 frozen mobile files). */
export function frozenMobileFiles() {
  return new Map(Object.entries(BASELINE))
}

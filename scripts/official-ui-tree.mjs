// The UI policies (scripts/*-policy.mjs, lint-ui.mjs) were written for the interface when it lived in this repository.
// It now lives in the official UI checkout (mikka-hosted-ui, mounted at MIKKA_UI_OVERLAY_DIR or .hosted-ui): its core/
// holds the base components, styles, fonts and client application at the paths they had here (decision 2026-11-22-2205).
// This view lets a policy keep its own paths: `components/ui/badge.tsx` reads `<checkout>/core/components/ui/badge.tsx`,
// and the checkout's `@hosted/core/` imports read as the `@/` imports the rules name. Without a checkout the policies
// that need the interface skip; mikka-hosted-ui's CI runs them with its checkout mounted and MIKKA_REQUIRE_OFFICIAL_UI=1,
// which turns a missing checkout into an error (official-ui-requirement.mjs).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { officialUiSkip } from './official-ui-requirement.mjs'

// The policies run from the repository root and read its files by relative path; a test that runs a policy in a
// fixture repository gets that fixture's checkout, or none.
export const repository = process.cwd()
const configured = process.env.MIKKA_UI_OVERLAY_DIR?.trim()
const checkout = configured ? resolve(repository, configured) : join(repository, '.hosted-ui')
export const officialCheckout = existsSync(checkout) ? checkout : null
export const officialCore = existsSync(join(checkout, 'core')) ? join(checkout, 'core') : null
// MIKKA_REQUIRE_OFFICIAL_UI=1 applies to this repository only: a policy run in a fixture repository (cwd elsewhere)
// is expected to have no checkout.
const own = resolve(fileURLToPath(new URL('..', import.meta.url))) === resolve(repository)
export const needsOfficialUi = officialUiSkip(officialCore, 'MIKKA_UI_OVERLAY_DIR or .hosted-ui', own ? process.env : {})

const slash = value => value.split(sep).join('/')
/** Where a policy's repository path is: this repository's own file, else the checkout's core/ file. */
export function uiPath(file) {
  const own = isAbsolute(file) ? file : join(repository, file)
  if (existsSync(own) || !officialCore) return own
  const official = join(officialCore, isAbsolute(file) ? relative(repository, file) : file)
  return existsSync(official) ? official : own
}
export const uiExists = file => existsSync(uiPath(file))
/** A path the interface had in this repository and now has in the checkout's core/. */
export const isOfficialUiPath = file => /^(?:components|hooks)\//.test(file) || /^app\/(?:globals\.css|fonts\/)/.test(file)
  || /^lib\/(?:presence-gate\.tsx|use-presence\.ts|client-runtime\/(?:dynamic|lazy-dialog|link|localized-navigation|script)\.tsx)$/.test(file)
  || /^lib\/(?:hooks\/use-(?:check-on-return|delayed-visible)|platform\/use-(?:platform|agent-logins)|conversation\/folded)\.ts$/.test(file)
/** An allowlist entry for a moved file is checked where the file is; without the checkout it cannot be, and is skipped. */
export const unverifiable = file => !officialCore && isOfficialUiPath(file)
/** A file's text as the policy reads it: the checkout's own `@hosted/core/` imports are the `@/` the rules name. */
export const readUi = file => {
  const path = uiPath(file)
  const text = readFileSync(path, 'utf8')
  return officialCore && path.startsWith(officialCore) ? text.replaceAll('@hosted/core/', '@/') : text
}

/** Every source file of the checkout's core/, by the repository path it has in this view. */
export function officialCoreFiles() {
  if (!officialCore) return []
  const found = []
  const walk = directory => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else found.push(slash(relative(officialCore, path)))
    }
  }
  walk(officialCore)
  return found.sort()
}

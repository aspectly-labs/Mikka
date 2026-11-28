import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

for (const [file, names] of [
  ['desktop-release.yml', ['APPLE_DEVELOPER_ID_P12_BASE64', 'APPLE_DEVELOPER_ID_P12_PASSWORD', 'APPLE_TEAM_ID', 'ASC_API_KEY_P8', 'ASC_API_KEY_ID', 'ASC_API_ISSUER_ID']],
]) test(file + ' reads the existing canonical platform names through OIDC, without static repository credentials', () => {
  const source = readFileSync(new URL('../.github/workflows/' + file, import.meta.url), 'utf8')
  assert.ok(!source.includes('secrets.'))
  assert.ok(source.includes('id-token: write'))
  assert.ok(source.includes('node scripts/release/apple-credentials.mjs'))
  for (const name of names) {
    const label = '- name: Read existing ' + name + ' through OIDC'
    const start = source.indexOf(label); assert.ok(start >= 0, name)
    const end = source.indexOf('\n      - ', start + label.length)
    const block = source.slice(start, end < 0 ? source.length : end)
    for (const text of ['method: oidc', 'identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac', 'secret-path: /platform', 'secret-name: ' + name, 'recursive: false', 'include-imports: false']) assert.ok(block.includes(text), name + ':' + text)
  }
})

test('mobile-next-update.yml reads only canonical OIDC platform credentials without static secrets', () => {
  const source = readFileSync(new URL('../.github/workflows/mobile-next-update.yml', import.meta.url), 'utf8')
  assert.ok(!source.includes('secrets.'))
  assert.ok(source.includes('id-token: write'))
  for (const name of ['HOSTED_UI_READ_KEY', 'EXPO_TOKEN']) {
    const label = '- name: Read existing ' + name + ' through OIDC'
    const start = source.indexOf(label); assert.ok(start >= 0, name)
    const end = source.indexOf('\n      - ', start + label.length)
    const block = source.slice(start, end < 0 ? source.length : end)
    for (const text of ['uses: Infisical/secrets-action@d2e351f16c6ca20d17c85e6c992e04bdeb64e87d', 'method: oidc', 'identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac', 'oidc-audience: mikka-infisical', 'project-id: 89850d6a-f020-4936-863e-df77380dfe40', 'env-slug: prod', 'secret-path: /platform', 'secret-name: ' + name, 'recursive: false', 'include-imports: false']) assert.ok(block.includes(text), name + ':' + text)
  }
})

test('mobile-next-ios.yml reads only canonical OIDC platform credentials without static secrets', () => {
  const source = readFileSync(new URL('../.github/workflows/mobile-next-ios.yml', import.meta.url), 'utf8')
  assert.ok(!source.includes('secrets.'))
  assert.ok(source.includes('id-token: write'))
  for (const name of ['HOSTED_UI_READ_KEY', 'APPLE_TEAM_ID', 'ASC_API_KEY_P8', 'ASC_API_KEY_ID', 'ASC_API_ISSUER_ID', 'APPLE_IOS_DISTRIBUTION_P12_BASE64', 'APPLE_IOS_DISTRIBUTION_P12_PASSWORD']) {
    const marker = 'secret-name: ' + name
    const at = source.indexOf(marker); assert.ok(at >= 0, name)
    const start = source.lastIndexOf('\n      - ', at)
    const end = source.indexOf('\n      - ', at)
    const block = source.slice(start, end < 0 ? source.length : end)
    for (const text of ['uses: Infisical/secrets-action@d2e351f16c6ca20d17c85e6c992e04bdeb64e87d', 'method: oidc', 'identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac', 'oidc-audience: mikka-infisical', 'project-id: 89850d6a-f020-4936-863e-df77380dfe40', 'env-slug: prod', 'secret-path: /platform', marker, 'recursive: false', 'include-imports: false']) assert.ok(block.includes(text), name + ':' + text)
  }
})

test('mobile-next-update.yml reads the source App only to mint a read-only release policy token, never for staging', () => {
  const source = readFileSync(new URL('../.github/workflows/mobile-next-update.yml', import.meta.url), 'utf8')
  for (const name of ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY']) {
    const at = source.indexOf('secret-name: ' + name); assert.ok(at >= 0, name)
    const block = source.slice(source.lastIndexOf('\n      - ', at), source.indexOf('\n      - ', at))
    for (const text of ["if: env.MOBILE_OTA_PHASE != 'stage'", 'method: oidc', 'secret-path: ${{ steps.source-app.outputs.secret-path }}', 'recursive: false', 'include-imports: false'])
      assert.ok(block.includes(text), name + ':' + text)
  }
  const mint = source.slice(source.indexOf('- name: Mint a short-lived read-only release policy token'), source.indexOf('- name: Remove App credentials before reading the policy'))
  assert.match(mint, /repositories: mikka-cloud\n\s+permission-contents: read\n/)
  assert.doesNotMatch(mint, /permission-(?!contents)/)
  assert.ok(source.indexOf("echo 'GITHUB_APP_PRIVATE_KEY=' >> \"$GITHUB_ENV\"") < source.indexOf('- name: Require the reviewed mobile production policy'))
})

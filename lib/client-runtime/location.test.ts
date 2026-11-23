import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localeHref } from '@/lib/client-runtime/location'

test('localeHref: API paths are never prefixed with a locale', () => {
  for (const locale of ['en', 'zh-CN']) {
    assert.equal(localeHref('/api/integrations/composio/connect?intent=coi_x', locale), '/api/integrations/composio/connect?intent=coi_x', locale)
    assert.equal(localeHref('/api/auth/session', locale), '/api/auth/session', locale)
  }
})

test('localeHref: pages are localized, and the base path is left to its caller', () => {
  assert.equal(localeHref('/sign-in?next=%2F', 'en'), '/en/sign-in?next=%2F')
  assert.equal(localeHref('/sign-in?next=%2F', 'zh-CN'), '/sign-in?next=%2F')
  assert.equal(localeHref('/', 'en'), '/en/')
  assert.equal(localeHref('https://example.test/x', 'en'), 'https://example.test/x')
  assert.equal(localeHref('//evil.test/x', 'en'), '//evil.test/x')
})

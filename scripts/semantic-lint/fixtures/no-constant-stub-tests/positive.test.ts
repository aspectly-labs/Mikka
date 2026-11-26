// Positive fixture for no-constant-stub-tests: tautological stub assertions without production code under test.
import test from 'node:test'
import assert from 'node:assert/strict'

declare function expect(value: unknown): {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
}

const EXPECTED_PRICE = 2000
const MOCK_PRO_LIMIT = 32
const FAKE_CATALOG = {
  pro: {
    price: '$20/mo',
    limit: 32,
  },
}

function getFakeCatalog() {
  return FAKE_CATALOG
}

test('hardcoded price constant asserted directly against literal', () => {
  assert.equal(EXPECTED_PRICE, 2000)
})

test('local mock limit asserted with strictEqual', () => {
  assert.strictEqual(MOCK_PRO_LIMIT, 32)
})

test('trivial local helper returning fake catalog asserted against literal', () => {
  assert.equal(getFakeCatalog().pro.price, '$20/mo')
})

test('destructured fake catalog asserted with assert.ok', () => {
  const { price } = FAKE_CATALOG.pro
  assert.ok(price === '$20/mo')
})

test('vitest-style expect on local stub constant', () => {
  expect(MOCK_PRO_LIMIT).toBe(32)
})

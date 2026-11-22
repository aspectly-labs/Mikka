import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Window } from 'happy-dom'
import type { SuggestionCard } from '@/lib/suggestions/card'

mock.module('@/lib/intl/i18n-client', { namedExports: {
  useLocale: () => 'en',
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
  useMessages: () => ({}),
  useFormatter: () => ({}),
} })

let SuggestionRow: typeof import('./mobile-card')['SuggestionRow']
before(async () => { ({ SuggestionRow } = await import('./mobile-card')) })

const card: SuggestionCard = { source: 'github', action: 'review', title: 'Original pull request', actionTitle: 'Review this pull request', url: 'https://example.test/pull/1' }

function render(row: SuggestionCard, status: string) {
  const browser = new Window()
  const container = browser.document.createElement('div')
  container.innerHTML = renderToStaticMarkup(<SuggestionRow card={row} status={status} />)
  return { container, close: () => browser.close() }
}

test('a handed-over suggestion is one line: 建议, its sentence linking to the item, then its state, with no card or bubble', () => {
  const { container, close } = render(card, 'Handed to Coordinator')
  try {
    assert.equal(container.children.length, 1)
    const row = container.firstElementChild!
    assert.equal(row.tagName, 'P')
    assert.equal(row.getAttribute('data-slot'), 'suggestion-row')
    // The thread screen hides an event line's author line: the row is the chat's record, not a message.
    assert.equal(row.getAttribute('data-event-line'), 'suggestion')
    assert.equal(row.firstElementChild!.textContent, 'Nav.suggestions')
    const words = row.querySelector('[data-slot="suggestion-words"]')!
    assert.ok(words.className.includes('truncate'), 'the sentence stays on one line')
    assert.equal(words.getAttribute('title'), 'Original pull request', 'the source\'s own words stay reachable')
    const link = words.querySelector('a')!
    assert.equal(link.getAttribute('href'), card.url)
    assert.equal(link.getAttribute('target'), '_blank')
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer')
    assert.ok(link.textContent.includes('Review this pull request'))
    assert.ok(link.textContent.includes('GitHub'), 'the app is named for screen readers beside its mark')
    assert.equal(row.querySelector('[role="status"]')!.textContent, 'Handed to Coordinator')
    for (const slot of ['suggestion-card', 'bubble', 'message']) assert.equal(container.querySelector(`[data-slot="${slot}"]`), null, slot)
  } finally { close() }
})

test('a suggestion without a link or action line keeps its title as the sentence and shows its sending state', () => {
  const { container, close } = render({ ...card, actionTitle: null, url: null }, 'Sending…')
  try {
    const words = container.querySelector('[data-slot="suggestion-words"]')!
    assert.equal(words.querySelector('a'), null)
    assert.equal(words.getAttribute('title'), null)
    assert.ok(words.textContent.includes('Original pull request'))
    assert.ok(words.textContent.includes('SuggestionsPage.action.review'), 'the item\'s kind leads as its verb')
    assert.equal(container.querySelector('[role="status"]')!.textContent, 'Sending…')
  } finally { close() }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { ACCEPTED_BOT_SHAPES, BOT_SHAPES, LEGACY_BOT_SHAPES, botShapeOf } from '../lib/bot-shapes.ts'

test('bots pick one of bot-avatars\' eighteen bodies', () => {
  assert.equal(BOT_SHAPES.length, 18)
  assert.equal(new Set(BOT_SHAPES).size, 18)
})

test('a stored body draws as itself', () => {
  for (const shape of BOT_SHAPES) assert.equal(botShapeOf({ id: 'bot-1', shape }), shape)
})

test('an old bloub shape draws as its nearest body, never rewritten', () => {
  for (const [old, body] of Object.entries(LEGACY_BOT_SHAPES)) if (old !== 'cercle') assert.equal(botShapeOf({ id: 'bot-1', shape: old }), body)
  assert.equal(botShapeOf({ shape: 'cercle' }), 'circle')
})

test('bots left on the old default circle get a steady body from their id', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
  const bodies = ids.map(id => botShapeOf({ id, shape: 'cercle' }))
  assert.deepEqual(bodies, ids.map(id => botShapeOf({ id, shape: 'cercle' })))
  assert.ok(new Set(bodies).size > 8, 'default bots spread over the bodies')
  for (const body of bodies) assert.ok(BOT_SHAPES.includes(body))
})

test('the API accepts every body and every old id, and nothing else', () => {
  for (const shape of [...BOT_SHAPES, ...Object.keys(LEGACY_BOT_SHAPES)]) assert.ok(ACCEPTED_BOT_SHAPES.includes(shape), shape)
  assert.equal(new Set(ACCEPTED_BOT_SHAPES).size, ACCEPTED_BOT_SHAPES.length)
  assert.equal(botShapeOf({ shape: 'heart' }), 'clover')
  const id = '00000000-0000-4000-8000-000000000003'
  assert.equal(botShapeOf({ id, shape: 'heart' }), botShapeOf({ id, shape: 'cercle' }), 'an unknown value with an id gets the id\'s body')
})

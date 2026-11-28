import assert from 'node:assert/strict'
import test from 'node:test'
import { liteLlmRequest } from '../api/ingress/services.mjs'
import { converterRequest } from './request.mjs'

const origin = 'https://litellm.internal'
const id = 'gen_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const generation = '/v1/mikka/gateway-generation'
const managed = '/v1/mikka/managed-search/haiku'

test('the private Gateway receipt route forwards only one canonical generation ID', async () => {
  const binding = { fetch(request) {
    assert.equal(request.headers.get('authorization'), 'Bearer proxy-key')
    assert.equal(request.headers.get('cookie'), null)
    return new Response(converterRequest(request)?.url)
  } }
  const url = `${generation}?id=${id}`
  const request = new Request(origin + url, { headers: { authorization: 'Bearer proxy-key', cookie: 'private' } })
  assert.equal(await liteLlmRequest(request, binding).text(), 'http://litellm' + url)
  for (const path of [generation, `${generation}?ID=${id}`, `${generation}?id=${id}&id=${id}`,
    `${generation}?id=${id}&target=https://example.test`, `${generation}?id=${id}%0A`, `${generation}?id=${id.toLowerCase()}`,
    `${generation}?id=gen_81ARZ3NDEKTSV4RRFFQ69G5FAV`, `${generation}?id=${id}&`, `${generation}?id=%67${id.slice(1)}`,
    `/v1/mikka/catalog?id=${id}`, `/v1/generation?id=${id}`]) {
    assert.equal(converterRequest(new Request(origin + path)), null, path)
    assert.equal(liteLlmRequest(new Request(origin + path), binding).status, 404, path)
  }
  const wrongMethod = new Request(origin + url, { method: 'POST' })
  assert.equal(converterRequest(wrongMethod), null)
  assert.equal(liteLlmRequest(wrongMethod, binding).status, 404)
})

test('the private Gateway inference routes accept fixed POST paths without queries', () => {
  for (const mode of ['stream', 'generate']) {
    const path = `${managed}/${mode}/language-model`
    assert.equal(converterRequest(new Request(origin + path, { method: 'POST' }))?.url, 'http://litellm' + path)
    assert.equal(converterRequest(new Request(origin + path)), null)
    assert.equal(converterRequest(new Request(origin + path + '?override=1', { method: 'POST' })), null)
  }
})

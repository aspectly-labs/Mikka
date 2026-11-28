import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ingressConfig } from '../../../cloudflare/api/ingress/config.mjs'

/** The transport must create the Request. An in-memory bodyless Request
 * misses the non-null zero-byte stream delivered by the real runtime. */
test('the production redelivery handler accepts zero-byte HTTP POSTs through workerd without forwarding caller authority', async t => {
  const require = createRequire(import.meta.url)
  const dependency = createRequire(realpathSync(require.resolve('wrangler/package.json')))
  const { Miniflare, convertV4MiniflareOptions } = dependency('miniflare')
  const { build } = dependency('esbuild')
  const directory = await mkdtemp(join(tmpdir(), 'github-redelivery-http-'))
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const production = ingressConfig({ release: 'fixture', origin: 'https://app.example', image: 'registry.example.test/api:fixture' })
  const source = `import {githubRedeliveryRequest} from './cloudflare/api/ingress/services.mjs';
export default {async fetch(incoming) {
  const url=new URL(incoming.url);
  const request=new Request('https://github-redelivery.internal'+url.pathname+url.search,incoming);
  const observed=request.clone(), bodyWasNull=request.body===null;
  let calls=0, forwarded=null;
  const response=await githubRedeliveryRequest(request,{async fetch(sent) {
    calls++; forwarded={url:sent.url,method:sent.method,bodyWasNull:sent.body===null,headers:[...sent.headers],redirect:sent.redirect};
    return incoming.headers.get('x-fixture-redirect')
      ? new Response(null,{status:302,headers:{location:'https://untrusted.example/other'}})
      : new Response(null,{status:204});
  }});
  return Response.json({status:response.status,bodyWasNull,bytes:(await observed.arrayBuffer()).byteLength,
    contentLength:incoming.headers.get('content-length'),calls,forwarded});
}};`
  const bundle = await build({ stdin: { contents: source, resolveDir: root, sourcefile: 'redelivery-http-fixture.mjs', loader: 'js' },
    bundle: true, format: 'esm', platform: 'browser', external: ['node:*'], write: false, treeShaking: true, logLevel: 'silent' })
  const runtime = new Miniflare(convertV4MiniflareOptions({ cf: false, host: '127.0.0.1', port: 0,
    resourcePersistencePath: directory,
    workers: [{ name: 'redelivery-http', modules: true, compatibilityDate: production.compatibility_date,
      compatibilityFlags: production.compatibility_flags, script: bundle.outputFiles[0].text }],
  }))
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const origin = await runtime.ready
  assert.equal(origin.hostname, '127.0.0.1')
  const callerHeaders = { authorization: 'synthetic-caller', cookie: 'synthetic-cookie', 'x-mikka-internal': 'forged' }
  const chunked = body => new Promise((resolve, reject) => {
    const outgoing = httpRequest(new URL('/redeliver', origin), { method: 'POST',
      headers: { ...callerHeaders, 'transfer-encoding': 'chunked' }, signal: AbortSignal.timeout(5000) }, incoming => {
      const chunks = []
      incoming.on('data', chunk => chunks.push(chunk))
      incoming.on('error', reject)
      incoming.on('end', () => {
        try { const body = Buffer.concat(chunks).toString(); assert.equal(incoming.statusCode, 200, body); resolve(JSON.parse(body)) }
        catch (error) { reject(error) }
      })
    })
    outgoing.on('error', reject)
    if (body) outgoing.write(body)
    outgoing.end()
  })
  const finite = async (path, options) => {
    const response = await fetch(new URL(path, origin), { ...options, headers: { ...callerHeaders, ...options.headers }, signal: AbortSignal.timeout(5000) })
    const body = await response.text()
    assert.equal(response.status, 200, body)
    return JSON.parse(body)
  }
  for (const [name, read] of [
    ['content-length zero', () => finite('/redeliver', { method: 'POST' })],
    ['chunked zero', () => chunked('')],
  ]) await t.test(name, async () => {
    const value = await read()
    assert.equal(value.bodyWasNull, false); assert.equal(value.bytes, 0)
    assert.equal(value.status, 204); assert.equal(value.calls, 1)
    assert.deepEqual(value.forwarded, { url: 'https://github-redelivery.internal/redeliver', method: 'POST',
      bodyWasNull: true, headers: [], redirect: 'manual' })
  })
  await t.test('the binding cannot redirect maintenance to another target', async () => {
    const value = await finite('/redeliver', { method: 'POST', headers: { 'x-fixture-redirect': 'yes' } })
    assert.equal(value.status, 502); assert.equal(value.calls, 1)
    assert.deepEqual(value.forwarded.headers, []); assert.equal(value.forwarded.redirect, 'manual')
  })
  for (const [name, read] of [
    ['one byte', () => finite('/redeliver', { method: 'POST', body: 'x' })],
    ['chunked one byte', () => chunked('x')],
    ['caller-selected operation', () => finite('/redeliver?app=other', { method: 'POST' })],
    ['wrong method', () => finite('/redeliver', { method: 'GET' })],
  ]) await t.test(name, async () => {
    const value = await read()
    assert.equal(value.status, 404); assert.equal(value.calls, 0); assert.equal(value.forwarded, null)
  })
})

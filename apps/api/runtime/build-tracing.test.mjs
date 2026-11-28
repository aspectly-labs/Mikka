import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileTracing } from '../scripts/finalize-build.mjs'
import { decodeOtlp } from '../../../tests/mvp/trace-collector.mjs'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const exec = promisify(execFile)
const revision = '123456789abc' + 'd'.repeat(28)

test('compiled API tracing exports the artifact revision on spans and logs before pg loads', { timeout: 60_000 }, async t => {
  const spans = [], logs = [], sentinel = 'private-build-pg-parameter'
  let privateBytes = false
  const collector = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    privateBytes ||= body.includes(sentinel)
    const signal = request.url.endsWith('/traces') ? 'traces' : 'logs'
    ;(signal === 'traces' ? spans : logs).push(...decodeOtlp(body, signal))
    response.writeHead(200, { 'content-type': 'application/x-protobuf' }); response.end()
  })
  await new Promise((resolve, reject) => { collector.once('error', reject); collector.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { collector.closeAllConnections(); await new Promise(resolve => collector.close(resolve)) })
  const cache = join(repository, 'node_modules/.cache')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'build-tracing-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'request.mjs'), `
await import('./mikka-tracing.mjs');
const { trace, SpanStatusCode } = await import('@opentelemetry/api');
const { default: pg } = await import('pg');
const provider = globalThis[Symbol.for('mikka.tracing')];
if (!provider || pg.Client.prototype.query.__wrapped !== true) throw new Error('BUILD_TRACING_NOT_STARTED_BEFORE_PG');
let parentId;
await trace.getTracer('build-contract').startActiveSpan('test.request', async span => {
  parentId = span.spanContext().spanId;
  const client = new pg.Client();
  await client.end();
  try { await client.query('SELECT $1::text', [${JSON.stringify(sentinel)}]); }
  catch { span.setStatus({ code: SpanStatusCode.ERROR }); }
  finally { span.end(); }
});
await provider.forceFlush();
await Promise.all([...globalThis[Symbol.for('mikka.telemetry.flush')]].map(flush => flush()));
await provider.shutdown();
console.log(JSON.stringify({ parentId }));
`)
  for (const scenario of [
    { name: 'production without a runtime revision', buildRevision: revision, runtimeRevision: undefined, expected: revision.slice(0, 12) },
    { name: 'production with a conflicting runtime revision', buildRevision: revision, runtimeRevision: 'f'.repeat(40), expected: revision.slice(0, 12) },
    { name: 'development retains its runtime revision', buildRevision: undefined, runtimeRevision: 'e'.repeat(40), expected: 'e'.repeat(12) },
  ]) await t.test(scenario.name, async () => {
    spans.length = 0; logs.length = 0
    await writeFile(join(directory, 'mikka-tracing.mjs'), await compileTracing(repository, scenario.buildRevision))
    const env = { ...process.env, NODE_ENV: scenario.buildRevision ? 'production' : 'development', CI: '',
      MIKKA_PUBLIC_POSTHOG_KEY: 'phc_build_runtime_fixture', MIKKA_TRACE_SAMPLE_RATE: '1',
      MIKKA_TRACE_ENDPOINT: `http://127.0.0.1:${collector.address().port}/i/v1/traces` }
    delete env.MIKKA_BUILD_REVISION
    if (scenario.runtimeRevision) env.MIKKA_BUILD_REVISION = scenario.runtimeRevision
    const { stdout, stderr } = await exec(process.execPath, [join(directory, 'request.mjs')], { cwd: repository, env, timeout: 15_000 })
    assert.equal(stderr, '')
    const { parentId } = JSON.parse(stdout)
    const query = spans.find(span => span.attributes['db.system.name'] === 'postgresql' && span.parentSpanId === parentId)
    assert.ok(query, 'BUILD_PG_SPAN_MISSING')
    assert.equal(query.status, 2)
    assert.ok(logs.some(log => log.spanId === parentId && log.body === 'mikka.stage.failed'), 'BUILD_STAGE_LOG_MISSING')
    for (const record of [...spans, ...logs]) {
      assert.equal(record.service, 'mikka-web')
      assert.equal(record.serviceVersion, scenario.expected)
    }
    assert.equal(privateBytes, false, 'SQL parameter values must not enter telemetry')
  })
})

test('a supplied artifact revision must be an immutable Git commit SHA', async () => {
  for (const invalid of ['', 'main', 'a'.repeat(12), 'a'.repeat(41), 'not-a-revision']) {
    await assert.rejects(compileTracing(repository, invalid), { message: 'API_BUILD_SHA_REQUIRED' })
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('the locked runtime executes LiteLLM at its actual production compatibility date', async t => {
  const require = createRequire(import.meta.url)
  const dependency = createRequire(realpathSync(require.resolve('wrangler/package.json')))
  const { Miniflare, convertV4MiniflareOptions } = dependency('miniflare')
  const { build } = dependency('esbuild')
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const production = JSON.parse(await readFile(new URL('../../../cloudflare/litellm/wrangler.jsonc', import.meta.url)))
  const bundle = await build({ stdin: { contents: "export {default} from './cloudflare/litellm/worker.mjs'",
    resolveDir: root, sourcefile: 'litellm-runtime-compatibility-fixture.mjs', loader: 'js' },
    bundle: true, format: 'esm', platform: 'browser', external: ['node:*', 'cloudflare:workers'],
    write: false, treeShaking: true, logLevel: 'silent' })
  const directory = await mkdtemp(join(tmpdir(), 'litellm-runtime-compatibility-'))
  let outboundCalls = 0
  const runtime = new Miniflare(convertV4MiniflareOptions({ cf: false, host: '127.0.0.1', port: 0,
    resourcePersistencePath: directory,
    workers: [{ name: 'litellm-compatibility', modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: production.compatibility_date, compatibilityFlags: production.compatibility_flags,
      outboundService() { outboundCalls++; throw new Error('network is not part of runtime compatibility acceptance') },
    }],
  }))
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const origin = await runtime.ready
  assert.equal(origin.hostname, '127.0.0.1')
  const response = await fetch(new URL('/not-a-model-route', origin), { signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(await response.text(), '')
  assert.equal(outboundCalls, 0)
})

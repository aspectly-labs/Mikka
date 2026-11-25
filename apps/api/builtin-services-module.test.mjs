import assert from 'node:assert/strict'
import test from 'node:test'
import { builtinServices } from './builtin-services-module.mjs'

function options(dev, preset) {
  return { dev, preset }
}

test('the built-in gateway mounts in the production node server and the known Nitro dev topology only', () => {
  for (const [dev, preset] of [[false, 'node-server'], [true, 'nitro-dev']]) {
    const nitro = { options: options(dev, preset) }
    builtinServices(nitro)
    assert.equal(nitro.options.features.websocket, true)
    assert.equal(nitro.options.plugins.length, 1)
    assert.ok(nitro.options.plugins[0].endsWith('apps/api/plugins/builtin-services.ts'))
    assert.deepEqual(Object.keys(nitro.options.routes), [
      '/mikka/v1/live/**',
      '/mikka/v1/devices/:deviceId/socket',
      '/mikka/v1/devices/:deviceId/push',
      '/mikka/v1/devices/:deviceId/status',
    ])
    for (const handler of Object.values(nitro.options.routes)) assert.ok(handler.endsWith('apps/api/routes/builtin-gateway.ts'))
    builtinServices(nitro)
    assert.equal(nitro.options.plugins.length, 1, 'the module remains idempotent when Nitro merges configuration')
  }
})

test('other presets and development compositions do not silently become a gateway host', () => {
  for (const [dev, preset] of [[false, 'nitro-dev'], [false, 'vercel'], [true, 'node-server'], [true, 'vercel']]) {
    const nitro = { options: options(dev, preset) }
    builtinServices(nitro)
    assert.equal(nitro.options.features, undefined)
    assert.equal(nitro.options.plugins, undefined)
    assert.equal(nitro.options.routes, undefined)
  }
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { frontendConfig } from '../../frontend/vite.config.mjs'

test('the SSH preload acceptance builds only main and preload, while every desktop renderer build requires the official checkout', async () => {
  const commands = []
  const manifest = '{"version":"fixture"}'
  const source = readFileSync(new URL('../../../tests/ssh-install/run.mjs', import.meta.url), 'utf8')
  runInNewContext(source.replace(/^import .*\n/gm, ''), {
    execFileSync: (program, args, options) => {
      commands.push({ program, args, options })
      if (args[0] === 'packages/daemon/scripts/build.mjs') return 'Retained build directory: /tmp/ssh-daemon-fixture'
      if (program === 'npm') return '[{"filename":"mikka-fixture.tgz"}]'
      return ''
    },
    mkdtempSync: () => '/tmp/ssh-runner-fixture',
    readFileSync: path => { assert.equal(path, 'packages/daemon/package.json'); return manifest },
    writeFileSync: () => {}, rmSync: () => {}, tmpdir, join,
    process: { execPath: process.execPath, env: {} },
  }, { filename: 'tests/ssh-install/run.mjs', timeout: 2000 })
  const build = commands.find(command => command.args[0] === 'apps/desktop/scripts/build.mjs')
  assert.ok(build, 'the actual SSH runner still builds the installed preload')
  // The runner's arrays come from the VM realm; copy into this realm before a strict comparison.
  assert.deepEqual(Array.from(build.args).slice(1), ['--without-renderer'])
  const names = ['MIKKA_UI_OVERLAY_DIR', 'MIKKA_UI_OVERLAY_SHA', 'MIKKA_DEPLOYMENT_STAGE', 'VERCEL', 'VERCEL_ENV']
  const previous = names.map(name => process.env[name])
  try {
    for (const name of names) delete process.env[name]
    // Without the checkout the desktop renderer is the headless test page (apps/desktop/scripts/build.mjs refuses a
    // production build); a production stage still needs the checkout and its revision.
    assert.ok(await frontendConfig({ target: 'desktop' }))
    process.env.MIKKA_DEPLOYMENT_STAGE = 'production'
    await assert.rejects(frontendConfig({ target: 'desktop' }), /OFFICIAL_UI_CHECKOUT_AND_REVISION_REQUIRED/)
  } finally {
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index] })
  }
})

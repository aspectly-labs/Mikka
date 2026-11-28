import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'

/**
 * The E2B workflow's offline test job installs only the packages its tests
 * import, pinned by hand. When a test starts importing another package (as
 * cloud-startup did with `ai` through lib/conversation/fold.ts), or package.json
 * moves a version, the job fails after merge. This keeps the hand-pinned list
 * equal to package.json.
 */
const root = resolve(import.meta.dirname, '../..')

test('the offline gate installs the same versions package.json pins', async () => {
  const workflow = await readFile(join(root, '.github/workflows/e2b-official-runtime.yml'), 'utf8')
  const line = workflow.split('\n').find(text => text.includes('runtime-gate-tests') && text.includes('npm install'))
  assert.ok(line, 'the offline gate install line exists')
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const pinned = { ...pkg.dependencies, ...pkg.devDependencies }
  const specs = [...line.matchAll(/'((?:@[^@'\s]+\/)?[^@'\s]+)@([^'\s]+)'/g)]
  assert.ok(specs.length >= 4, 'the install line names its packages')
  for (const [, name, version] of specs) {
    assert.ok(pinned[name], `${name} is a dependency of the repository`)
    assert.equal(version, pinned[name].replace(/^[\^~]/, ''), `${name} matches package.json`)
  }
  assert.ok(specs.some(([, name]) => name === 'ai'), 'cloud-startup imports ai through lib/conversation/fold.ts')
})

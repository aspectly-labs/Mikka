import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import yaml from 'js-yaml'

test('all shared-account workflows retain pending requests', async () => {
  const directory = new URL('../../.github/workflows/', import.meta.url)
  let count = 0
  for (const file of (await readdir(directory)).filter(name => name.endsWith('.yml'))) {
    const workflow = yaml.load(await readFile(new URL(file, directory), 'utf8'))
    const entries = [workflow.concurrency, ...Object.values(workflow.jobs ?? {}).map(job => job.concurrency)]
    for (const concurrency of entries) {
      const group = typeof concurrency === 'string' ? concurrency : concurrency?.group
      if (typeof group !== 'string' || !group.includes('production-smoke-owner-acceptance')) continue
      count++
      assert.equal(typeof concurrency, 'object', file + ': scalar concurrency cannot retain every pending request')
      assert.equal(concurrency['cancel-in-progress'], false, file)
      assert.equal(concurrency.queue, 'max', file + ': a default single pending request can cancel other workflows')
    }
  }
  // The three production probes dropped their pull_request triggers (#3114),
  // so their queue group is the shared literal again; the loop still asserts
  // queue:max and no cancellation on it.
  assert.ok(count >= 12, 'cover workflow and job declarations across every production acceptance entry')
})

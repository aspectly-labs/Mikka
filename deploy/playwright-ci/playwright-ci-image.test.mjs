import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const dockerfile = readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8')
const verifyScript = readFileSync(new URL('./verify.sh', import.meta.url), 'utf8')
const workflow = readFileSync(new URL('../../.github/workflows/cloudflare-playwright-ci-image.yml', import.meta.url), 'utf8')
const lockfile = readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8')

test('Playwright CI Dockerfile matches repo-pinned Playwright, Node, and pnpm digests', () => {
  assert.match(lockfile, /^\s+playwright@1\.64\.1:/m, 'Mikka pnpm-lock.yaml must resolve playwright@1.64.1')
  assert.match(dockerfile, /^FROM node:24\.22\.1-bookworm-slim@sha256:[a-f0-9]{64} AS node-tools$/m)
  assert.match(dockerfile, /ADD --checksum=sha256:[a-f0-9]{64} https:\/\/registry\.npmjs\.org\/pnpm\/-\/pnpm-10\.34\.3\.tgz \/tmp\/pnpm\.tgz/)
  assert.match(dockerfile, /^FROM mcr\.microsoft\.com\/playwright:v1\.64\.1-noble@sha256:[a-f0-9]{64}$/m)
  assert.match(dockerfile, /PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright/)
  assert.match(dockerfile, /PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1/)
  assert.match(dockerfile, /rm -rf \/ms-playwright\/firefox\*/)
  assert.ok(!/mikka-hosted-ui|\.hosted-ui|CLOUDFLARE_API_TOKEN|GITHUB_TOKEN/.test(dockerfile), 'Public Playwright CI image must stay free of private UI code and secrets')
})

test('Playwright CI workflow keeps PR verification credential-free and gates registry publish to main dispatch', () => {
  const verifySection = workflow.split('\n  verify:\n')[1]?.split('\n  publish:\n')[0] ?? ''
  const publishSection = workflow.split('\n  publish:\n')[1] ?? ''
  assert.ok(verifySection.length > 0 && publishSection.length > 0)

  for (const forbidden of ['secrets.', 'id-token: write', 'environment:', 'cloudflare-registry-credentials']) {
    assert.ok(!verifySection.includes(forbidden), `verify job must stay credential-free (found ${forbidden})`)
  }
  assert.match(publishSection, /github\.event_name == 'workflow_dispatch'/)
  assert.match(publishSection, /github\.ref == 'refs\/heads\/main'/)
  assert.match(publishSection, /environment: cloudflare-runtime-release/)
  assert.match(publishSection, /uses: \.\/\.github\/actions\/cloudflare-registry-credentials/)
  assert.match(workflow, /CF_ACCOUNT_ID:\s*d8f6630c7869111a5139bc5ed4d24ace/)
  assert.match(workflow, /CF_IMAGE_REPO:\s*mikka-hosted-ui-ci/)
  assert.match(verifyScript, /--network none --cap-drop ALL --security-opt=no-new-privileges/)
})

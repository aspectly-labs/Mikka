// Notes derived from Capy or Codex source or reverse engineering live in the private hosted repository
// (mikka-hosted-ui docs/research/ and docs/tasks/; owner decision, 2026-11-27). This repository may state a
// conclusion ("matches Capy's behaviour: …") but never cites the evidence itself: an unpacked app path, a
// bundle file name with its offset or column, or an installer's internals. Put the evidence in the hosted
// repository and point to it (AGENTS.md, "Docs split").
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import test from 'node:test'

const ROOT = resolve(import.meta.dirname, '..')
const SELF = 'scripts/no-competitor-source.test.mjs'
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.pdf', '.zip', '.gz', '.tgz', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.mov', '.webm', '.wasm', '.node', '.sqlite', '.db'])

// Markers that only competitor-source work produces, wherever they appear.
const ALWAYS = [
  { name: 'unpacked source folder', re: /\b(?:capy|codex)-src\b/i },
  { name: 'installed Capy app path', re: /\bCapy\.app\b/ },
  { name: 'Capy download or installer', re: /\bdownloads\.capy\.ai\b|\bCapy-\d+\.\d+\.\d+-[a-z0-9]+\.(?:dmg|zip|exe|AppImage)\b|\bcapy-\d+\.\d+\.\d+-[a-z0-9]+\.tar\.gz\b/i },
  { name: 'bundle file with an offset', re: /\b[a-z][a-z0-9-]*-[A-Za-z0-9_-]{8}\.js@\d+/ },
  { name: 'bundle column offset', re: /~col \d+/ },
]
// A hashed bundle name (`index-BNVriEhx.js`) or a packaged renderer path is a competitor citation only next to its
// product's name; Mikka's own build and tests name their own hashed assets.
const NEAR_COMPETITOR = [
  { name: 'hashed bundle file', re: /\b[a-z][a-z0-9-]*-[A-Za-z0-9_]{8}\.js\b(?!on)/ },
  { name: 'packaged renderer path', re: /\b(?:resources|Contents\/Resources)\/(?:renderer|app\.asar)\b/i },
]
const COMPETITOR = /\b(?:capy|codex)\b/i

export function competitorSourceProblems(path, text) {
  const problems = []
  for (const [index, line] of text.split('\n').entries()) {
    for (const { name, re } of ALWAYS) if (re.test(line)) problems.push(`${path}:${index + 1}: ${name}`)
    if (!COMPETITOR.test(line)) continue
    for (const { name, re } of NEAR_COMPETITOR) if (re.test(line)) problems.push(`${path}:${index + 1}: ${name} next to a competitor's name`)
  }
  return problems
}

function trackedTextFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\0')
    .filter(path => path && path !== SELF && path !== 'pnpm-lock.yaml' && !BINARY.has(extname(path).toLowerCase()))
}

test('tracked public files cite no Capy or Codex source internals', () => {
  const problems = []
  for (const path of trackedTextFiles()) {
    let text
    try { text = readFileSync(resolve(ROOT, path), 'utf8') } catch { continue }
    if (text.includes('\0')) continue
    problems.push(...competitorSourceProblems(path, text))
  }
  assert.deepEqual(problems, [], `Move the evidence to mikka-hosted-ui docs/research/ and keep only the conclusion here:\n${problems.join('\n')}`)
})

test('competitorSourceProblems flags source citations and leaves conclusions and Mikka assets alone', () => {
  const flagged = [
    'see ~/capy-src/shared/sidebar-threads.tsx',
    'read /Applications/Capy.app/Contents/Resources/renderer/assets',
    'Capy 0.8.0: `resources/renderer/assets/index-BNVriEhx.js`',
    'onboarding-DQUpYdYX.js@12345',
    'the chip at ~col 4410',
    'from https://downloads.capy.ai/stable/Capy-0.7.2-arm64.dmg',
  ]
  for (const line of flagged) assert.notDeepEqual(competitorSourceProblems('x.md', line), [], line)
  const allowed = [
    "Deleting a state moves its tasks first, as Capy does.",
    "filename: 'https://app.aspectlylabs.com/mikka/assets/index-B3x9qZ1a.js'",
    'apps/desktop/release/mac-arm64/Mikka.app/Contents/Resources/app.asar',
    'Capy names its threads; see mikka-hosted-ui `docs/research/2026-11-27-public-evidence.md`.',
    'the Codex runtime bundle is installed from npm',
  ]
  for (const line of allowed) assert.deepEqual(competitorSourceProblems('x.md', line), [], line)
})

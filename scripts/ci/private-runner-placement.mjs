import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

// Exact workflow bytes reviewed at private 72bdb348. Removals are safe; edits,
// including new Cloudflare profiles, need public policy review before building.
const approvedWorkflows = Object.freeze({
  '.github/workflows/capture-retention.yml': 'ebab36f3a8acac6b818adfd60e85db6d5ec8e26ba14f1fa7ac0671d5445fe702',
  '.github/workflows/cloudflare-billing-evidence.yml': '3fa6d917bb35db6175c3df93a32c95bed05bde1bc334e7df28c960a7c45edb33',
  '.github/workflows/container-identity-metadata.yml': '93564de784df5660a743b75f075e77bc93b5b62aea614c048689603ccd122b1f',
  '.github/workflows/eve-lifecycle-tests.yml': '7c74cb2449d91d071cd041c6e42f3f3db0b0a3f139d8d24581ddbf2b521f1d20',
  '.github/workflows/eve-world-resources.yml': '912351b1cf33e4c1ccee722dddb1b818a6078072235389c8df412c4d9f7384bb',
  '.github/workflows/github-webhook-prepare.yml': '13a8fdc3d450e80d1e91932af28b81faac7263ced5935b243a62cb5f420d2d32',
  '.github/workflows/marketing-cloudflare-release.yml': '8e734ae3a6f8cb2687c5d1b3bd6d5d076e882f4057cffd3322962f283306848b',
  '.github/workflows/migration-drift.yml': '2e4a3430a24111572549ed314e632efea0e94345afaf1f08c9b649b8dc951be1',
  '.github/workflows/observe-cloudflare-runtime.yml': 'a0e19145e330d7349362733eaa43add5cbe99aa3528002d186a2d60a0c7add46',
  '.github/workflows/ops-scheduler-deploy.yml': '159dd9df51310320b538149ac0665b72fd16f71df7d5f0eede3f713770ccc6bb',
  '.github/workflows/overlay-source-sync.yml': '1cfb11e30cc877b36f1fc606cb52c418821db3f7a084b85fc3f3085d95c03e62',
  '.github/workflows/overlay-sync-tests.yml': '905303a3f2118cbce10667173a5e6f36d82e6776793b8c35baa2af8fab2a1412',
  '.github/workflows/private-source-download.yml': '795c9055b705095776983f91a22a62725b714a7a942e9bfeb676e849624618d0',
  '.github/workflows/product-task-canary.yml': '6ae7a104132db529fd1d91b515a2a6c2cadc7e41b425ede8881890d4272f174f',
  '.github/workflows/production-daemon-qualification.yml': 'e3fb5da02ad7bce8c209eb006ea7f3466f9f3c1a5e3de9e641a1335006e52525',
  '.github/workflows/public-migration-markers.yml': 'b255f317481b51bb30dd72a7e6fbb41213e4d881d86ba59c37c582a41bc31f1f',
  '.github/workflows/runtime-native-alert.yml': '227f374ee4756d4d6767e6c8345b42afaf198a7067cc7ed36274899319f98ede',
  '.github/workflows/runtime-observer-runner-canary.yml': 'be71c2c734859587e894e0da7f960cdac80bd7690853c0d5ad6cd00307d0b53f',
  '.github/workflows/vercel-project-billing.yml': '013709338c50323a56d3a703fd979769b1272b655e8d528568219f96059bd489',
  '.github/workflows/vercel-workflow-inventory.yml': 'a8766a7900b04eda41c6c72a9f7b2197cf80e46b24d76f85bccaae808d28dc94',
  '.github/workflows/zero-residency-guard.yml': '73c48a769e7d25087c3e6b23c261cfabb11d83a342baca48a9530d1dc59d368c',
})
const fail = () => { throw new Error('CLOUD_PUBLIC_CI_PRIVATE_RUNNER_PLACEMENT') }

/** Hash approved bytes instead of interpreting untrusted YAML without a parser. */
export function assertApprovedWorkflowBytes(files, approved) {
  const seen = new Set()
  for (const { path, mode, bytes } of files) {
    if (seen.has(path) || mode !== '100644' || !Object.hasOwn(approved, path)
      || createHash('sha256').update(bytes).digest('hex') !== approved[path]) fail()
    seen.add(path)
  }
}

export function assertPrivateRunnerPlacement(directory, source) {
  if (!/^[a-f0-9]{40}$/.test(source ?? '')) fail()
  const git = args => execFileSync('git', ['-C', directory, ...args], { maxBuffer: 2 * 1024 * 1024, timeout: 10_000 })
  const rows = git(['ls-tree', '-rz', '--full-tree', source, '--', '.github/workflows']).toString('utf8').split('\0').filter(Boolean)
  const files = rows.flatMap(row => {
    const match = /^([0-7]{6}) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(row)
    if (!match) fail()
    const [, mode, blob, path] = match
    if (!/\.ya?ml$/i.test(path)) return []
    if (!Object.hasOwn(approvedWorkflows, path)) fail()
    return [{ path, mode, bytes: git(['cat-file', 'blob', blob]) }]
  })
  assertApprovedWorkflowBytes(files, approvedWorkflows)
}

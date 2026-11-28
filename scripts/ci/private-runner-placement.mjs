import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

// Exact workflow bytes reviewed at private d7d4666 (mikka-cloud#509). The five manual
// docs/overlay/lifecycle workflow updates were reviewed at private f7fd2873: one
// read-only docs fallback and four comment/input-description changes. Removals are
// safe; all later edits, including runner changes, need public policy review.
const approvedWorkflows = Object.freeze({
  '.github/workflows/capture-retention.yml': 'ebab36f3a8acac6b818adfd60e85db6d5ec8e26ba14f1fa7ac0671d5445fe702',
  '.github/workflows/cloudflare-billing-evidence.yml': 'f9182c2cfaa012a27435f1221d4e5ecb521ddc60e429261a82519e45f4f025ca',
  '.github/workflows/container-identity-metadata.yml': '57864183f1bb7b63c82d1ef45f8a581d6d1dd6910512ad4edcbb2cc856037e7a',
  '.github/workflows/docs-gates.yml': 'bb12d5d5471335f34138bbb5a79a3986ce0e8609bc80297df5858eb44ac3a26f',
  '.github/workflows/eve-lifecycle-tests.yml': '767a5a757ebda2f872d89d904e0dbbcdb621ff6e56136591bfcea3e44f1c577f',
  '.github/workflows/eve-world-resources.yml': '912351b1cf33e4c1ccee722dddb1b818a6078072235389c8df412c4d9f7384bb',
  '.github/workflows/github-webhook-prepare.yml': '13a8fdc3d450e80d1e91932af28b81faac7263ced5935b243a62cb5f420d2d32',
  '.github/workflows/marketing-cloudflare-release.yml': '8e734ae3a6f8cb2687c5d1b3bd6d5d076e882f4057cffd3322962f283306848b',
  '.github/workflows/migration-drift.yml': '7d9f25946cf3105e794402ec46bc2e4120ca73fd20960d433ff6dcabb6da99e7',
  '.github/workflows/observe-cloudflare-runtime.yml': 'a1d0b3631dc5176756b2fdb29f129f2d07715e0d37a2d19b34714b4bc79dea62',
  '.github/workflows/ops-scheduler-deploy.yml': '159dd9df51310320b538149ac0665b72fd16f71df7d5f0eede3f713770ccc6bb',
  '.github/workflows/overlay-source-sync.yml': '22a833b602cf214c20e9cd52a94581d53767b88ccd6dab6b690d59ff0d538dc2',
  '.github/workflows/overlay-sync-tests.yml': '0293a28ddf9905ea8a2af4869871b146068c54c3c4f47e2232296f017d02e42d',
  '.github/workflows/private-source-download.yml': '795c9055b705095776983f91a22a62725b714a7a942e9bfeb676e849624618d0',
  '.github/workflows/product-task-canary.yml': '47d4a4e79d0c29dceeeb07ae1aa34359b83b85b645b39433f18fc8166ee0e8e3',
  '.github/workflows/production-daemon-qualification.yml': 'e54873ad25403ae51203eaac9f160ae5d3cd9740e4321b70d2d790dea00b7304',
  '.github/workflows/public-migration-markers.yml': 'ee615e8b4997dee2982868d530b933cb3ac155f35c7fcab37196b683aa9c2ea1',
  '.github/workflows/runtime-native-alert.yml': '227f374ee4756d4d6767e6c8345b42afaf198a7067cc7ed36274899319f98ede',
  '.github/workflows/runtime-observer-runner-canary.yml': 'be71c2c734859587e894e0da7f960cdac80bd7690853c0d5ad6cd00307d0b53f',
  '.github/workflows/vercel-project-billing.yml': '8a88971d6d6993ecd46d58f91f73374b3bade2692f468864866d6f3c472f64aa',
  '.github/workflows/vercel-workflow-inventory.yml': '361bbecfd13498e131f9c05bb05ba390a6f106bf16e3218b14654f07e91b73cf',
  '.github/workflows/verify-overlay-pin.yml': 'da9a97c2d26a74ab3a842be55fe290944561f34bfcf095695024dd0e363404dd',
  '.github/workflows/zero-residency-guard.yml': '0d20d10bfeaa64650301042db30bf5dc49f78933eeac2b492f05c0512ac48d03',
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

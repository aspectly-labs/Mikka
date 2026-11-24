import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { repository } from './application-plugin.mjs'

let sequence = 0
const workspace = createRequire(resolve(repository, 'package.json'))
// One React for every module, the official UI checkout's included, as the Vite build's `resolve.dedupe` does.
const oneReact = { name: 'one-react', setup(builder) {
  builder.onResolve({ filter: /^react(?:-dom)?(?:\/|$)/ }, args => ({ path: workspace.resolve(args.path) }))
} }
export async function browserModule(source, define = {}) {
  const result = await build({
    absWorkingDir: repository,
    stdin: { contents: source, loader: 'tsx', sourcefile: 'frontend-contract.tsx', resolveDir: repository },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023',
    tsconfig: resolve(repository, 'apps/frontend/tsconfig.json'), plugins: [oneReact],
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.MIKKA_BASE_PATH': '"/mikka"', 'process.env': '{}', ...define },
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#frontend-${++sequence}`)
}

// Regenerates lib/issue-editor-schema-spec.json from the live issue editor schema.
// The server cannot import the editor's React-based extensions, so it validates against this snapshot;
// lib/issue-document-seed.test.ts fails whenever the snapshot drifts from the editor.
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const overlay = resolve(root, process.env.MIKKA_UI_OVERLAY_DIR || '.hosted-ui')
const schemaEntry = resolve(overlay, 'web/components/workspace/issue-editor-schema.ts')
if (!existsSync(schemaEntry)) {
  throw new Error(`Missing issue editor schema overlay at ${schemaEntry}; check out .hosted-ui or set MIKKA_UI_OVERLAY_DIR.`)
}
const snapshotEntry = fileURLToPath(new URL('../lib/issue-editor-schema-snapshot.ts', import.meta.url))
const serialized = execFileSync(
  process.execPath,
  [
    '--import', 'tsx',
    '--import', resolve(root, 'tests/support/server-only.mjs'),
    '--input-type=module',
    '-e',
    'const [{ issueEditorSchema }, { issueEditorSchemaSpec }] = await Promise.all([import(process.argv[1]), import(process.argv[2])]); process.stdout.write(JSON.stringify(issueEditorSchemaSpec(issueEditorSchema()), null, 2) + "\\n");',
    pathToFileURL(schemaEntry).href,
    pathToFileURL(snapshotEntry).href,
  ],
  { cwd: root, encoding: 'utf8', env: { ...process.env, TSX_TSCONFIG_PATH: resolve(overlay, 'tsconfig.json') } },
)
writeFileSync(new URL('../lib/issue-editor-schema-spec.json', import.meta.url), serialized)

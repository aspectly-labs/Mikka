import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { join, posix, resolve } from 'node:path'

export const migrationEntrypoint = 'scripts/migrate.mjs'
export const migrationRoots = Object.freeze(['scripts/check-migrations.mjs', migrationEntrypoint, 'scripts/migration-steps.mjs'])
/** v3 reads these two files for the runtime record; neither is hashed whole. */
export const migrationRuntimeInputs = Object.freeze(['.node-version', 'pnpm-lock.yaml'])
export const migrationIdentityVersion = 3
/** The only bare packages the migrator closure may import. */
export const migrationPackages = Object.freeze(['pg'])
// v2 hashed these whole toolchain files; kept only to read v2 receipts.
const v2Toolchain = Object.freeze(['.node-version', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
const digest = /^sha256:[a-f0-9]{64}$/
const integrity = /^sha512-[A-Za-z0-9+/]{86}==$/
const packageKey = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*@\d[^\s:]*$/i
const safePath = file => typeof file === 'string' && /^[a-zA-Z0-9_.@+/-]+$/.test(file)
  && !file.startsWith('/') && file === posix.normalize(file)
  && !file.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' || part.startsWith('.env'))
const npmrc = file => /(?:^|\/)\.npmrc$/.test(file)
const packageHook = file => /(?:^|\/)\.?pnpmfile\.(?:cjs|mjs|js)$/.test(file)
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (object, key) => plainObject(object) && Object.hasOwn(object, key)
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0
const byImport = (a, b) => order(a.importer, b.importer) || order(a.name, b.name)

function fileList(files, match, message) {
  assert.ok(Array.isArray(files) && files.length > 0 && files.every(match), message)
  assert.deepEqual(files, [...new Set(files)].sort(), message)
}

function sorted(values, message) {
  assert.ok(Array.isArray(values), message)
  assert.deepEqual(values, [...values].sort(), message)
  assert.equal(new Set(values).size, values.length, message)
}

function validRuntime(runtime) {
  const message = 'Invalid migration runtime record'
  assert.ok(plainObject(runtime), message)
  assert.deepEqual(Object.keys(runtime), ['imports', 'lockfileVersion', 'nodeMajor', 'packages'], message)
  assert.equal(runtime.lockfileVersion, '9.0', message)
  assert.ok(Number.isSafeInteger(runtime.nodeMajor) && runtime.nodeMajor > 0, message)
  assert.ok(Array.isArray(runtime.packages), message)
  const keys = new Set()
  for (const entry of runtime.packages) {
    assert.ok(plainObject(entry), message)
    assert.deepEqual(Object.keys(entry), ['dependencies', 'integrity', 'key', 'optionalDependencies'], message)
    assert.match(entry.key ?? '', packageKey, message)
    assert.match(entry.integrity ?? '', integrity, message)
    keys.add(entry.key)
  }
  sorted(runtime.packages.map(entry => entry.key), message)
  for (const entry of runtime.packages) for (const section of [entry.dependencies, entry.optionalDependencies]) {
    assert.ok(Array.isArray(section) && section.every(edge => Array.isArray(edge) && edge.length === 2
      && typeof edge[0] === 'string' && keys.has(edge[1])), message)
    sorted(section.map(edge => edge[0]), message)
  }
  assert.ok(Array.isArray(runtime.imports), message)
  for (const entry of runtime.imports) {
    assert.ok(plainObject(entry), message)
    assert.deepEqual(Object.keys(entry), ['importer', 'key', 'name'], message)
    assert.ok(entry.importer === '.' || safePath(entry.importer), message)
    assert.ok(migrationPackages.includes(entry.name) && keys.has(entry.key), message)
  }
  assert.deepEqual(runtime.imports, [...runtime.imports].sort(byImport), message)
  assert.equal(new Set(runtime.imports.map(entry => entry.importer + '\0' + entry.name)).size, runtime.imports.length, message)
  // Every recorded package is reachable from an import: nothing unrelated rides along.
  const reachable = new Set(), pending = runtime.imports.map(entry => entry.key)
  const byKey = new Map(runtime.packages.map(entry => [entry.key, entry]))
  while (pending.length) {
    const key = pending.pop()
    if (reachable.has(key)) continue
    reachable.add(key)
    for (const [, target] of [...byKey.get(key).dependencies, ...byKey.get(key).optionalDependencies]) pending.push(target)
  }
  assert.equal(reachable.size, keys.size, message)
}

function validSqlFiles(files, message) {
  fileList(files, file => /^drizzle\/[a-zA-Z0-9_-]+\.sql$/.test(file), message)
}

export function validateMigrationManifest(migrations) {
  assert.equal(migrations?.version, migrationIdentityVersion, 'Migration execution identity v3 is required for a release candidate')
  assert.deepEqual(Object.keys(migrations).sort(), ['contextDigest', 'execution', 'files', 'version'])
  assert.match(migrations.contextDigest ?? '', digest)
  validSqlFiles(migrations.files, 'Invalid migration SQL file list')
  const execution = migrations.execution
  assert.ok(plainObject(execution))
  assert.deepEqual(Object.keys(execution).sort(), ['contextDigest', 'entrypoint', 'files', 'runtime'])
  assert.equal(execution.entrypoint, migrationEntrypoint)
  assert.match(execution.contextDigest ?? '', digest)
  fileList(execution.files, file => safePath(file) && (/\.(?:mjs|cjs|js)$/.test(file) || npmrc(file)),
    'Invalid migration execution file list')
  for (const file of migrationRoots) assert.ok(execution.files.includes(file), 'Missing migration execution input: ' + file)
  validRuntime(execution.runtime)
  return migrations
}

function validateV2MigrationManifest(migrations) {
  assert.deepEqual(Object.keys(migrations).sort(), ['contextDigest', 'execution', 'files', 'version'])
  assert.match(migrations.contextDigest ?? '', digest)
  validSqlFiles(migrations.files, 'Invalid migration SQL file list')
  const execution = migrations.execution
  assert.ok(plainObject(execution))
  assert.deepEqual(Object.keys(execution).sort(), ['contextDigest', 'entrypoint', 'files'])
  assert.equal(execution.entrypoint, migrationEntrypoint)
  assert.match(execution.contextDigest ?? '', digest)
  fileList(execution.files, file => safePath(file) && !file.endsWith('.sql'), 'Invalid migration execution file list')
  for (const file of [...migrationRoots, ...v2Toolchain]) assert.ok(execution.files.includes(file), 'Missing migration execution input: ' + file)
  return migrations
}

/** This permits reading an existing receipt, never admitting a new candidate. */
export function validateHistoricalMigrations(migrations) {
  if (migrations?.version === migrationIdentityVersion) return validateMigrationManifest(migrations)
  if (migrations?.version === 2) return validateV2MigrationManifest(migrations)
  assert.deepEqual(Object.keys(migrations ?? {}).sort(), ['contextDigest', 'files'])
  assert.match(migrations.contextDigest ?? '', digest)
  validSqlFiles(migrations.files, 'Invalid historical migration SQL file list')
  return migrations
}

async function regularFile(directory, file) {
  assert.ok(safePath(file), 'Invalid migration input path')
  const path = join(directory, file)
  const info = await lstat(path)
  assert.ok(info.isFile(), 'Migration inputs must be regular files: ' + file)
  assert.equal(await realpath(path), path, 'Migration input parent must not be a symbolic link: ' + file)
  const executable = info.mode & 0o111
  assert.ok(executable === 0 || executable === 0o111, 'Migration input executable mode must match Git: ' + file)
  return { bytes: await readFile(path), executable }
}

/** Kept byte-for-byte reproducible from Git blobs by the independent publisher.
 * Node versions come from the checked-in declaration, never this host's version. */
async function hashFiles(directory, files, parameters) {
  const hash = createHash('sha256').update(JSON.stringify(parameters) + '\0')
  for (const file of files) {
    const { bytes, executable } = await regularFile(directory, file)
    hash.update(JSON.stringify([file, 'file', executable, bytes.length]) + '\0')
    hash.update(bytes)
  }
  return 'sha256:' + hash.digest('hex')
}

function trivia(source, start) {
  let index = start
  for (;;) {
    while (/\s/.test(source[index] ?? '') && index < source.length) index++
    if (source.startsWith('//', index)) {
      const end = source.slice(index + 2).search(/[\n\r\u2028\u2029]/)
      index = end < 0 ? source.length : index + 2 + end + 1
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      assert.notEqual(end, -1, 'Unterminated migration import comment')
      index = end + 2
    } else return index
  }
}

/** Scan the original text conservatively, including template interpolations.
 * Text that merely mentions import() may add a dependency or fail closed; it
 * cannot hide a real import. Computed paths and escaped strings need review. */
function dynamicImports(source) {
  assert.ok(!/\b(?:eval|Function|createRequire)\b/.test(source), 'Migration dynamic code loaders are unsupported')
  const specifiers = []
  for (const match of source.matchAll(/\b(import|require)\b/g)) {
    let index = trivia(source, match.index + match[0].length)
    if (match[1] === 'import' && source[index] === '.') {
      assert.match(source.slice(index), /^\.meta\.url\b/, 'Migration import.meta loaders are unsupported')
      continue
    }
    if (source[index] !== '(') continue
    assert.equal(match[1], 'import', 'Migration require() dependencies are unsupported')
    index = trivia(source, index + 1)
    const quote = source[index++]
    assert.ok(quote === "'" || quote === '"', 'Migration dynamic imports must use one literal path')
    const start = index
    while (index < source.length && source[index] !== quote) {
      assert.ok(!/[\\\r\n]/.test(source[index]), 'Migration dynamic import escapes are unsupported')
      index++
    }
    assert.equal(source[index], quote, 'Unterminated migration dynamic import')
    const specifier = source.slice(start, index)
    index = trivia(source, index + 1)
    assert.equal(source[index], ')', 'Migration dynamic imports must use one literal path')
    specifiers.push(specifier)
  }
  return specifiers
}

// SourceTextModule parses declarations and re-exports without linking or
// evaluating candidate modules. Dynamic import() is handled separately above.
const parseModule = `import {SourceTextModule} from 'node:vm';
import {readFileSync} from 'node:fs';
const module=new SourceTextModule(readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify({nodeMajor:Number(process.versions.node.split('.')[0]),requests:module.moduleRequests}));`

function imports(source) {
  let parsed
  try {
    parsed = JSON.parse(execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', parseModule],
      { input: source, encoding: 'utf8', env: {}, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }))
  } catch (cause) { throw new Error('Migration execution module cannot be parsed without evaluation', { cause }) }
  const { requests, nodeMajor } = parsed
  assert.ok(Array.isArray(requests), 'Migration parser must report import metadata')
  for (const request of requests) {
    assert.ok(typeof request.specifier === 'string' && request.specifier.length > 0)
    // Node 22.20+ reports attributes but predates the source-phase grammar and
    // phase property. Keep its real parser gate; never fall back to the older
    // dependencySpecifiers API, which loses import attributes.
    if (request.phase === undefined) {
      assert.equal(nodeMajor, 22, 'Migration parser must report the import phase')
      for (const match of source.matchAll(/\bimport\b/g)) {
        const index = trivia(source, match.index + match[0].length)
        assert.ok(!/^(?:source|defer)\b/.test(source.slice(index)), 'Migration source-phase imports are unsupported')
      }
    } else assert.equal(request.phase, 'evaluation', 'Migration source-phase imports are unsupported')
    assert.deepEqual(request.attributes, {}, 'Migration import attributes are unsupported')
  }
  return [...new Set([...requests.map(request => request.specifier), ...dynamicImports(source)])]
}

function dependency(specifier, importer, tracked) {
  assert.ok(!['module', 'node:module', 'vm', 'node:vm'].includes(specifier), 'Migration dynamic module loaders are unsupported')
  if (isBuiltin(specifier)) return null
  if (migrationPackages.includes(specifier)) return { package: specifier }
  assert.ok(/^(?:\.\.?\/)[a-zA-Z0-9_./-]+\.m?js$/.test(specifier), 'Unsupported migration dependency: ' + specifier)
  const file = posix.normalize(posix.join(posix.dirname(importer), specifier))
  assert.ok(safePath(file) && tracked.has(file), 'Untracked or escaping migration dependency: ' + file)
  return { file }
}

// pnpm writes lockfile v9 as indented block mappings, one-line block sequence
// items and one-line flow collections of scalars. This reader accepts exactly
// that subset with YAML's failsafe (all-string) meaning and refuses anything
// else: anchors, aliases, tags, comments, multi-line or double-quoted scalars,
// tabs, carriage returns and duplicate keys. It never evaluates the lockfile.
// The private verifier reparses the same Git bytes with a full YAML parser, so
// a misreading here can only make the identities disagree, never pass a change.
const lockfileError = 'Migration lockfile uses YAML outside the pnpm lockfile v9 subset'

function lockfileQuoted(text, start) {
  assert.equal(text[start], "'", lockfileError)
  let value = '', index = start + 1
  for (;;) {
    assert.ok(index < text.length, lockfileError)
    if (text[index] === "'") {
      if (text[index + 1] !== "'") return { value, end: index + 1 }
      value += "'"; index += 2
    } else value += text[index++]
  }
}

function lockfilePlain(value, flow) {
  assert.ok(value.length > 0 && value === value.trim(), lockfileError)
  assert.ok(!/^[-?:,[\]{}#&*!|>'"%@`]/.test(value), lockfileError)
  assert.ok(!value.includes(': ') && !value.includes(' #') && !value.endsWith(':'), lockfileError)
  if (flow) assert.ok(!/[,[\]{}]/.test(value), lockfileError)
  return value
}

function lockfileFlow(text) {
  const mapping = text[0] === '{', close = mapping ? '}' : ']'
  assert.ok(text.endsWith(close), lockfileError)
  const body = text.slice(1, -1), result = mapping ? Object.create(null) : []
  let index = 0
  const scalar = stop => {
    if (body[index] === "'") {
      const { value, end } = lockfileQuoted(body, index)
      index = end
      return value
    }
    const start = index
    while (index < body.length && !stop(index)) index++
    return lockfilePlain(body.slice(start, index), true)
  }
  while (body !== '') {
    if (mapping) {
      const key = scalar(at => body.startsWith(': ', at) || body[at] === ',')
      assert.ok(body.startsWith(': ', index) && !Object.hasOwn(result, key), lockfileError)
      index += 2
      result[key] = scalar(at => body[at] === ',')
    } else result.push(scalar(at => body[at] === ','))
    if (index === body.length) break
    assert.ok(body.startsWith(', ', index), lockfileError)
    index += 2
  }
  return result
}

function lockfileValue(text) {
  if (text[0] === '{' || text[0] === '[') return lockfileFlow(text)
  if (text[0] === "'") {
    const { value, end } = lockfileQuoted(text, 0)
    assert.equal(end, text.length, lockfileError)
    return value
  }
  return lockfilePlain(text, false)
}

function lockfileBlock(lines, start, indent) {
  let index = start
  if (lines[index].text.startsWith('- ')) {
    const items = []
    while (index < lines.length && lines[index].indent === indent) {
      assert.ok(lines[index].text.startsWith('- '), lockfileError)
      items.push(lockfileValue(lines[index++].text.slice(2)))
    }
    assert.ok(index === lines.length || lines[index].indent < indent, lockfileError)
    return { value: items, next: index }
  }
  const map = Object.create(null)
  while (index < lines.length && lines[index].indent === indent) {
    const text = lines[index].text
    let key, rest
    if (text[0] === "'") {
      const quoted = lockfileQuoted(text, 0)
      key = quoted.value
      rest = text.slice(quoted.end)
      assert.ok(rest === ':' || rest.startsWith(': '), lockfileError)
      rest = rest === ':' ? null : rest.slice(2)
    } else {
      const separator = text.indexOf(': ')
      assert.ok(separator >= 0 || text.endsWith(':'), lockfileError)
      key = lockfilePlain(separator < 0 ? text.slice(0, -1) : text.slice(0, separator), false)
      rest = separator < 0 ? null : text.slice(separator + 2)
    }
    assert.ok(!Object.hasOwn(map, key), lockfileError)
    if (rest === null) {
      assert.ok(lines[index + 1]?.indent === indent + 2, lockfileError)
      const nested = lockfileBlock(lines, index + 1, indent + 2)
      map[key] = nested.value
      index = nested.next
    } else {
      map[key] = lockfileValue(rest)
      index++
    }
  }
  assert.ok(index === lines.length || lines[index].indent < indent, lockfileError)
  return { value: map, next: index }
}

export function readLockfile(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    const refused = (code < 0x20 && code !== 0x0a) || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029 || code === 0xfeff
    assert.ok(!refused, lockfileError)
  }
  const lines = []
  for (const line of text.split('\n')) {
    if (/^ *$/.test(line)) continue
    const indent = line.length - line.trimStart().length
    assert.ok(indent % 2 === 0 && !line.endsWith(' '), lockfileError)
    lines.push({ indent, text: line.slice(indent) })
  }
  assert.ok(lines.length > 0 && lines[0].indent === 0, lockfileError)
  const { value, next } = lockfileBlock(lines, 0, 0)
  assert.ok(next === lines.length && !Array.isArray(value), lockfileError)
  return value
}

const runtimeError = 'Migration package must be a registry package with a resolved, integrity-hashed lockfile entry'

/** pnpm's own reference rule: a bare version belongs to the dependency's name;
 * a reference with its own name is an npm alias. Anything with a protocol
 * (link:, workspace:, file:, git or tarball URLs) is refused. */
function snapshotKey(name, reference) {
  assert.ok(typeof reference === 'string' && reference.length > 0 && !reference.includes(':'), runtimeError + ': ' + name)
  const at = reference.indexOf('@'), peers = reference.indexOf('(')
  const key = reference.startsWith('@') || (at > 0 && (peers < 0 || at < peers)) ? reference : name + '@' + reference
  assert.match(key, packageKey, runtimeError + ': ' + name)
  return key
}

/** The Node major comes from the checked-in declaration, never the host. */
export function nodeMajor(text) {
  const match = /^v?(\d+)(?:\.\d+){0,2}$/.exec(text.trim())
  assert.ok(match, 'Migration Node declaration must be a version number')
  const major = Number(match[1])
  assert.ok(Number.isSafeInteger(major) && major > 0, 'Migration Node declaration must be a version number')
  return major
}

/** Record only what the migrator's own imports install: each bare import's
 * resolved lockfile key and the transitive closure of those snapshots, with
 * every entry's integrity. Unrelated workspace dependencies are absent. */
export function migrationRuntime({ nodeVersion, lockfile, imports }) {
  assert.ok(plainObject(lockfile) && lockfile.lockfileVersion === '9.0', 'Migration lockfile must be pnpm lockfile v9')
  const importers = lockfile.importers, snapshots = lockfile.snapshots, packages = lockfile.packages
  const records = new Map()
  for (const { file, name } of imports) {
    let directory = posix.dirname(file)
    while (directory !== '.' && !own(importers, directory)) directory = posix.dirname(directory)
    assert.ok(own(importers, directory), runtimeError + ': ' + name)
    const declared = ['dependencies', 'devDependencies', 'optionalDependencies']
      .filter(section => own(importers[directory][section], name)).map(section => importers[directory][section][name])
    assert.equal(declared.length, 1, runtimeError + ': ' + name)
    assert.ok(plainObject(declared[0]), runtimeError + ': ' + name)
    const record = { importer: directory, key: snapshotKey(name, declared[0].version), name }
    records.set(directory + '\0' + name, record)
  }
  const entries = new Map(), pending = [...records.values()].map(record => record.key)
  while (pending.length) {
    const key = pending.shift()
    if (entries.has(key)) continue
    assert.ok(entries.size < 256, 'Migration package closure exceeds the bounded inventory')
    const snapshot = own(snapshots, key) ? snapshots[key] : null
    const description = own(packages, key.split('(')[0]) ? packages[key.split('(')[0]] : null
    assert.ok(plainObject(snapshot) && plainObject(description), runtimeError + ': ' + key)
    assert.ok(Object.keys(snapshot).every(field => ['dependencies', 'optionalDependencies', 'optional', 'transitivePeerDependencies'].includes(field)),
      runtimeError + ': ' + key)
    const resolution = description.resolution
    assert.ok(plainObject(resolution) && Object.keys(resolution).join() === 'integrity' && integrity.test(resolution.integrity),
      runtimeError + ': ' + key)
    const edges = section => {
      if (!Object.hasOwn(snapshot, section)) return []
      assert.ok(plainObject(snapshot[section]), runtimeError + ': ' + key)
      return Object.keys(snapshot[section]).sort().map(name => [name, snapshotKey(name, snapshot[section][name])])
    }
    const entry = { dependencies: edges('dependencies'), integrity: resolution.integrity, key, optionalDependencies: edges('optionalDependencies') }
    entries.set(key, entry)
    for (const [, target] of [...entry.dependencies, ...entry.optionalDependencies]) pending.push(target)
  }
  return { imports: [...records.values()].sort(byImport), lockfileVersion: '9.0', nodeMajor: nodeMajor(nodeVersion),
    packages: [...entries.values()].sort((a, b) => order(a.key, b.key)) }
}

/** Discover the exact existing runner/checker closure using only public source
 * bytes. An unavailable helper, computed import or symlink stops planning. */
export async function buildMigrationExecution({ directory, files }) {
  directory = await realpath(resolve(directory))
  const tracked = new Set(files)
  for (const file of [...migrationRoots, ...migrationRuntimeInputs]) assert.ok(tracked.has(file), 'Missing migration execution input: ' + file)
  const pending = [...migrationRoots, ...files.filter(packageHook)]
  const visited = new Set(), bare = []
  for (let index = 0; index < pending.length; index++) {
    const file = pending[index]
    if (visited.has(file)) continue
    visited.add(file)
    const { bytes } = await regularFile(directory, file)
    for (const specifier of imports(bytes.toString('utf8'))) {
      const imported = dependency(specifier, file, tracked)
      if (imported?.file) pending.push(imported.file)
      else if (imported) bare.push({ file, name: imported.package })
    }
  }
  const executionFiles = [...new Set([...visited, ...files.filter(npmrc)])].sort()
  const [nodeVersion, lockfile] = await Promise.all(migrationRuntimeInputs.map(async file =>
    (await regularFile(directory, file)).bytes.toString('utf8')))
  const runtime = migrationRuntime({ nodeVersion, lockfile: readLockfile(lockfile), imports: bare })
  const entrypoint = migrationEntrypoint
  return { entrypoint, files: executionFiles, runtime,
    contextDigest: await hashFiles(directory, executionFiles,
      { version: migrationIdentityVersion, kind: 'migration-execution', entrypoint, runtime }) }
}

export async function buildMigrationContext({ directory, files, sqlFiles }) {
  directory = await realpath(resolve(directory))
  assert.deepEqual(sqlFiles, files.filter(file => /^drizzle\/[^/]+\.sql$/.test(file)).sort(), 'Migration SQL identity must include the complete source snapshot')
  const execution = await buildMigrationExecution({ directory, files })
  return validateMigrationManifest({ version: migrationIdentityVersion, files: sqlFiles, execution,
    contextDigest: await hashFiles(directory, sqlFiles,
      { version: migrationIdentityVersion, kind: 'migrations', execution: execution.contextDigest }) })
}

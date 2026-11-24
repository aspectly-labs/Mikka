// PR 检查：新增或改动的迁移如果超出部署流水线的自动（additive）范围——回填、UPDATE/DELETE/INSERT、
// DROP INDEX、DO/EXECUTE/CALL、已有表上的 unique/partial 索引等——文件头必须有
//   -- migrate: reviewed-data #<PR 编号> <改了什么>
// 有标记的迁移在 PR 审核合并后由流水线照常自动执行（先预发、冒烟，再生产）；没有标记的会在合并后被
// 部署准入以 migration_requires_separate_review 拦下，并卡住之后每一次自动发布。这里在 PR 上提前失败。
//
// 判断规则不在这里写：automatic-migration-sql.mjs 是部署侧 assertAutomaticSql 的原样副本。
// 本文件和那份副本都不能被 check-migrations.mjs / migrate.mjs / migration-steps.mjs 引用，
// 否则会改变迁移执行身份，部署会以 migration_execution_changed 停下。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { assertAutomaticSql } from './automatic-migration-sql.mjs'

// 与部署侧同一写法：文件开头连续的空行和 `--` 注释才算文件头；不区分大小写。
const reviewedDataMarker = /^--\s*migrate:\s*reviewed-data\s+#[1-9]\d*\s+\S.*$/i
const reviewedDataAttempt = /^--\s*migrate:\s*reviewed-data\b/i
const contractHeader = /^--\s*migrate:\s*contract\b/i
export const MARKER_USAGE = '-- migrate: reviewed-data #<PR 编号> <改了什么>'

function leadingComments(sql) {
  const lines = []
  for (const line of sql.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '' && !trimmed.startsWith('--')) break
    lines.push(trimmed)
  }
  return lines
}

/** Git's blob id for these bytes, so main's tree can be compared without one `git show` per file. */
export const blobId = (content) => {
  const bytes = Buffer.from(content, 'utf8')
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

/**
 * One migration file against the deploy rule. Returns a problem string, or null when the
 * pipeline will run it automatically or it belongs to the contract owner window.
 */
export function reviewedDataProblem(name, content) {
  const header = leadingComments(content)
  // Contract migrations never run automatically; check-migrations.mjs owns their marker.
  if (header.some(line => contractHeader.test(line))) return null
  const malformed = header.find(line => reviewedDataAttempt.test(line) && !reviewedDataMarker.test(line))
  if (malformed) return `${name}：reviewed-data 标记格式不对（${malformed}），应为 ${MARKER_USAGE}，编号是审核这个迁移的 PR`
  try {
    assertAutomaticSql(name, content)
    return null
  } catch (error) {
    if (header.some(line => reviewedDataMarker.test(line))) {
      return `${name}：有 reviewed-data 标记，但部署侧仍无法解析这个 SQL 文件（${error.message}）`
    }
    const misplaced = content.split('\n').some(line => reviewedDataAttempt.test(line.trim()))
    return `${name}：迁移会改已有数据或超出自动迁移范围（回填、UPDATE/DELETE/INSERT、DROP、DO/EXECUTE/CALL、已有表上的 unique/partial 索引等），` +
      `${misplaced ? '标记必须放在文件开头的注释里，SQL 语句之前；' : ''}请在文件头写 ${MARKER_USAGE}，并在 PR 里说明影响和回退`
  }
}

/**
 * files: this tree's [{name, content}]. main: Map(name -> blob id) of main's drizzle/ tree, or null.
 * Only migrations this change adds or modifies are checked; main's files are already admitted
 * history and are never re-checked (check-migrations.mjs keeps them byte-identical).
 */
export function checkReviewedDataMigrations(files, main) {
  if (!main) return []
  const problems = []
  for (const { name, content } of files) {
    if (!name.endsWith('.sql') || main.get(name) === blobId(content)) continue
    const problem = reviewedDataProblem(name, content)
    if (problem) problems.push(problem)
  }
  return problems
}

/** main's drizzle/*.sql blob ids by name, from origin/main or a shallow fetch of it. */
export function mainBlobs(root = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  for (const ref of ['origin/main', 'FETCH_HEAD']) {
    try {
      const entries = git('ls-tree', ref, 'drizzle/').split('\n').filter(Boolean).map(line => {
        const [meta, path] = line.split('\t')
        return [path.slice('drizzle/'.length), meta.split(' ')[2]]
      })
      return new Map(entries.filter(([name]) => name.endsWith('.sql')))
    } catch {}
    if (ref === 'origin/main') { try { git('fetch', '-q', '--depth=1', 'origin', 'main') } catch {} }
  }
  return null
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL('../drizzle/', import.meta.url)
  const files = readdirSync(dir).filter(name => name.endsWith('.sql')).map(name => ({ name, content: readFileSync(new URL(name, dir), 'utf8') }))
  const main = mainBlobs()
  if (!main) {
    // Without main every file would look new. Locally that is a warning; in CI the check
    // must not silently pass, so it fails instead.
    console.error('reviewed-data migrations: 拿不到 origin/main，无法判断本次新增或改动的迁移')
    process.exit(process.env.CI ? 1 : 0)
  }
  const problems = checkReviewedDataMigrations(files, main)
  if (problems.length) {
    console.error(`reviewed-data migrations: ${problems.length} 个问题\n${problems.map(p => `  - ${p}`).join('\n')}`)
    process.exit(1)
  }
  const changed = files.filter(({ name, content }) => main.get(name) !== blobId(content)).length
  console.log(`reviewed-data migrations: 本次新增或改动 ${changed} 个迁移，均符合流水线的自动迁移规则（contract 迁移另走 owner window）`)
}

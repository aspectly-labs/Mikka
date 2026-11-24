// Which migrations the deploy pipeline runs automatically, for the PR check in
// scripts/check-reviewed-data-migrations.mjs.
//
// Copied from the deploy side: private mikka-cloud
// operations/business-api/pipeline-migrations.mjs (statements, assertAdditiveSql,
// assertAutomaticSql, reviewedDataMigrations; mikka-cloud #469). The deploy copy
// decides; this copy only lets a pull request fail before merge instead of the
// release stopping after it. Change both together, with the same test cases
// (scripts/automatic-migration-sql.test.mjs mirrors pipeline-migrations.test.mjs).
//
// Keep this file out of the migration execution identity: check-migrations.mjs,
// migrate.mjs and migration-steps.mjs must not import it (see
// docs/operations/build-source-of-truth.md, "Migration identity and admission").

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const reject = () => assert.fail('Automatic migrations require an explicit additive SQL statement')
const word = (token, value) => token?.kind === 'word' && token.value === value
const identifier = token => ['word', 'identifier'].includes(token?.kind)

/** A bounded lexer for the conservative automatic-DDL subset, never an SQL rewriter.
 * Quoted text precedes comment recognition; PostgreSQL block comments may nest.
 * Dollar quoting, procedural SQL and ambiguous backslash-quoted strings stay
 * outside the automatic path. The product migrator receives the original bytes. */
function statements(sql) {
  assert.ok(typeof sql === 'string' && Buffer.byteLength(sql) <= 1024 * 1024)
  const result = [], tokens = []
  let index = 0, depth = 0
  while (index < sql.length) {
    const rest = sql.slice(index), char = sql[index]
    if (/\s/.test(char)) { index++; continue }
    if (rest.startsWith('--')) {
      index += 2
      while (index < sql.length && !/[\r\n]/.test(sql[index])) index++
      continue
    }
    if (rest.startsWith('/*')) {
      let comments = 1; index += 2
      while (comments && index < sql.length) {
        if (sql.startsWith('/*', index)) { comments++; index += 2; assert.ok(comments <= 64) }
        else if (sql.startsWith('*/', index)) { comments--; index += 2 }
        else index++
      }
      assert.equal(comments, 0, 'Unterminated SQL comment')
      continue
    }
    const escaped = /^[Ee]'/.test(rest)
    if (char === "'" || char === '"' || escaped) {
      if (escaped) index++
      const quote = sql[index++], start = index
      let closed = false
      while (index < sql.length) {
        if (escaped && sql[index] === '\\') { index += 2; continue }
        if (sql[index] === quote) {
          if (quote === "'" && !escaped) {
            let slashes = 0
            for (let before = index - 1; before >= start && sql[before] === '\\'; before--) slashes++
            assert.equal(slashes % 2, 0, 'Ambiguous string escaping requires a separately reviewed migration')
          }
          if (sql[index + 1] === quote) { index += 2; continue }
          tokens.push({ kind: quote === '"' ? 'identifier' : 'literal', value: sql.slice(start, index) })
          index++; closed = true; break
        }
        index++
      }
      assert.equal(closed, true, 'Unterminated SQL literal or identifier')
      continue
    }
    // Dollar-quoted bodies (CREATE FUNCTION ... AS $$ ... $$) become one opaque
    // literal; only the statement grammars below may accept one.
    const dollar = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(rest)
    if (dollar) {
      const end = sql.indexOf(dollar[0], index + dollar[0].length)
      assert.ok(end !== -1, 'Unterminated dollar-quoted body')
      tokens.push({ kind: 'dollar', value: sql.slice(index + dollar[0].length, end) })
      index = end + dollar[0].length
      continue
    }
    const name = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(rest)
    if (name) { tokens.push({ kind: 'word', value: name[0].toUpperCase() }); index += name[0].length; continue }
    const numeric = /^[0-9]+(?:\.[0-9]*)?(?:[Ee][+-]?[0-9]+)?/.exec(rest)
    if (numeric) { tokens.push({ kind: 'number', value: numeric[0] }); index += numeric[0].length; continue }
    if (char === ';') {
      assert.equal(depth, 0, 'SQL statement boundary inside an expression')
      if (tokens.length) result.push(tokens.splice(0))
    } else {
      assert.ok('()[],.=:+-*/<>!~|&%^?#'.includes(char), 'Unsupported SQL syntax requires separate review')
      if (char === '(') depth++
      if (char === ')') depth--
      assert.ok(depth >= 0 && depth <= 64, 'Unbalanced SQL expression')
      tokens.push({ kind: 'symbol', value: char })
    }
    assert.ok(tokens.length <= 100000 && result.length <= 10000)
    index++
  }
  assert.equal(depth, 0, 'Unbalanced SQL expression')
  if (tokens.length) result.push(tokens)
  assert.ok(result.length, 'The migration contains no executable statement')
  return result
}

function nameEnd(tokens, index) {
  if (!identifier(tokens[index])) reject()
  index++
  if (tokens[index]?.value === '.') {
    if (!identifier(tokens[index + 1])) reject()
    index += 2
  }
  return index
}

function optional(tokens, index, words) {
  return words.every((value, offset) => word(tokens[index + offset], value)) ? index + words.length : index
}

// Adding a column to existing rows must not invoke a user-defined type/domain,
// an implicit domain default, a cast, or an expression hidden after a literal.
function builtinTypeEnd(tokens, index) {
  if (word(tokens[index], 'PG_CATALOG') && tokens[index + 1]?.value === '.') index += 2
  const type = tokens[index++]
  if (type?.kind !== 'word' || !['SMALLINT', 'INTEGER', 'INT', 'BIGINT', 'INT2', 'INT4', 'INT8',
    'REAL', 'FLOAT4', 'FLOAT8', 'DOUBLE', 'NUMERIC', 'DECIMAL', 'BOOLEAN', 'BOOL', 'TEXT',
    'VARCHAR', 'CHAR', 'CHARACTER', 'BYTEA', 'UUID', 'JSON', 'JSONB', 'DATE', 'TIME',
    'TIMETZ', 'TIMESTAMP', 'TIMESTAMPTZ', 'INTERVAL'].includes(type.value)) reject()
  if (type.value === 'DOUBLE') {
    if (!word(tokens[index++], 'PRECISION')) reject()
  }
  if (type.value === 'CHARACTER') index = optional(tokens, index, ['VARYING'])
  if (tokens[index]?.value === '(') {
    if (!['NUMERIC', 'DECIMAL', 'VARCHAR', 'CHAR', 'CHARACTER', 'TIME', 'TIMETZ', 'TIMESTAMP', 'TIMESTAMPTZ', 'INTERVAL'].includes(type.value)) reject()
    index++
    if (tokens[index]?.kind !== 'number' || !/^[0-9]+$/.test(tokens[index++].value)) reject()
    if (tokens[index]?.value === ',') {
      if (!['NUMERIC', 'DECIMAL'].includes(type.value)) reject()
      index++
      if (tokens[index]?.kind !== 'number' || !/^[0-9]+$/.test(tokens[index++].value)) reject()
    }
    if (tokens[index++]?.value !== ')') reject()
  }
  if (['TIME', 'TIMESTAMP'].includes(type.value) && ['WITH', 'WITHOUT'].some(value => word(tokens[index], value))) {
    index++
    if (!(word(tokens[index++], 'TIME') && word(tokens[index++], 'ZONE'))) reject()
  }
  while (tokens[index]?.value === '[') {
    if (tokens[++index]?.value !== ']') reject()
    index++
  }
  return index
}

function additiveColumn(fields) {
  if (!word(fields[0], 'ADD')) reject()
  let index = optional(fields, 1, ['COLUMN'])
  index = optional(fields, index, ['IF', 'NOT', 'EXISTS'])
  if (!identifier(fields[index++])) reject()
  index = builtinTypeEnd(fields, index)
  let nullable, defaultValue
  while (index < fields.length) {
    if (word(fields[index], 'DEFAULT') && defaultValue === undefined) {
      defaultValue = fields[++index]
      if (!['literal', 'number'].includes(defaultValue?.kind)
          && !['NULL', 'TRUE', 'FALSE'].some(value => word(defaultValue, value))) reject()
      index++
    } else if (word(fields[index], 'NULL') && nullable === undefined) {
      nullable = true; index++
    } else if (word(fields[index], 'NOT') && word(fields[index + 1], 'NULL') && nullable === undefined) {
      nullable = false; index += 2
    } else reject()
  }
  if (nullable === false && (defaultValue === undefined || word(defaultValue, 'NULL'))) reject()
}

function additiveIndexFields(tokens) {
  let index = 0
  do {
    if (!identifier(tokens[index++])) reject()
    if (['ASC', 'DESC'].some(value => word(tokens[index], value))) index++
    if (word(tokens[index], 'NULLS')) {
      index++
      if (!['FIRST', 'LAST'].some(value => word(tokens[index], value))) reject()
      index++
    }
    if (index === tokens.length) return
    if (tokens[index++]?.value !== ',' || index === tokens.length) reject()
  } while (index < tokens.length)
  reject()
}

// Columns, then optionally WHERE with a plain column predicate: no calls or casts.
function newTableIndex(tokens, index) {
  if (tokens[index++]?.value !== '(') reject()
  const close = tokens.findIndex((token, at) => at >= index && token.value === ')')
  if (close === -1) reject()
  additiveIndexFields(tokens.slice(index, close))
  index = close + 1
  if (index === tokens.length) return
  if (!word(tokens[index++], 'WHERE') || index === tokens.length) reject()
  for (const token of tokens.slice(index))
    if (['(', ')', ':', '[', ']'].includes(token.value) || token.kind === 'dollar') reject()
}

// A comparable object name: unquoted words fold to lower case, quoted
// identifiers keep their case, and the default public schema is implied.
function qualifiedName(tokens, index) {
  const part = token => token.kind === 'word' ? token.value.toLowerCase() : token.value
  const end = nameEnd(tokens, index)
  const parts = tokens.slice(index, end).filter(token => token.value !== '.').map(part)
  return { name: (parts.length === 2 && parts[0] === 'public' ? parts.slice(1) : parts).join('.'), end }
}

function expect(tokens, index, ...values) {
  for (const value of values) if (!word(tokens[index++], value)) reject()
  return index
}

// CREATE [OR REPLACE] FUNCTION name() RETURNS trigger, with a dollar-quoted
// PL/pgSQL or SQL body. The body is application code reviewed with its PR; it
// runs only through a trigger this same migration installs (checked below).
function triggerFunction(tokens) {
  let index = optional(tokens, 1, ['OR', 'REPLACE'])
  index = expect(tokens, index, 'FUNCTION')
  const { name, end } = qualifiedName(tokens, index)
  index = end
  if (tokens[index++]?.value !== '(' || tokens[index++]?.value !== ')') reject()
  index = expect(tokens, index, 'RETURNS', 'TRIGGER')
  let language = false, body = false
  while (index < tokens.length) {
    if (word(tokens[index], 'LANGUAGE') && !language && ['PLPGSQL', 'SQL'].some(value => word(tokens[index + 1], value))) {
      language = true; index += 2
    } else if (word(tokens[index], 'AS') && !body && tokens[index + 1]?.kind === 'dollar') {
      body = true; index += 2
    } else reject()
  }
  if (!language || !body) reject()
  return name
}

// CREATE TRIGGER name BEFORE|AFTER event [OR event] ON table
//   [FOR [EACH] ROW|STATEMENT] [WHEN (row condition)] EXECUTE FUNCTION fn('literal', ...)
function trigger(tokens) {
  let index = expect(tokens, 1, 'TRIGGER')
  const { name, end } = qualifiedName(tokens, index)
  index = end
  if (!['BEFORE', 'AFTER'].some(value => word(tokens[index], value))) reject()
  index++
  for (;;) {
    if (word(tokens[index], 'INSERT') || word(tokens[index], 'DELETE')) index++
    else if (word(tokens[index], 'UPDATE')) {
      index++
      if (word(tokens[index], 'OF')) {
        index++
        do { if (!identifier(tokens[index++])) reject() } while (tokens[index]?.value === ',' && ++index)
      }
    } else reject()
    if (!word(tokens[index], 'OR')) break
    index++
  }
  index = expect(tokens, index, 'ON')
  const table = qualifiedName(tokens, index)
  index = table.end
  if (word(tokens[index], 'FOR')) {
    index = optional(tokens, index + 1, ['EACH'])
    if (!['ROW', 'STATEMENT'].some(value => word(tokens[index], value))) reject()
    index++
  }
  if (word(tokens[index], 'WHEN')) {
    // A plain comparison of NEW/OLD columns: no calls, casts or subqueries.
    if (tokens[++index]?.value !== '(') reject()
    let depth = 0
    do {
      const token = tokens[index++]
      if (token === undefined) reject()
      if (token.value === '(') depth++
      else if (token.value === ')') depth--
      else if (token.kind === 'word' && !['NEW', 'OLD', 'AND', 'OR', 'NOT', 'IS', 'NULL', 'TRUE', 'FALSE', 'DISTINCT', 'FROM'].includes(token.value)) {
        if (tokens[index - 2]?.value !== '.') reject()
      } else if (!['identifier', 'literal', 'number', 'word'].includes(token.kind) && !['.', '=', '<', '>', '!'].includes(token.value)) reject()
      if (depth > 1) reject()
    } while (depth > 0)
  }
  index = expect(tokens, index, 'EXECUTE')
  if (!['FUNCTION', 'PROCEDURE'].some(value => word(tokens[index], value))) reject()
  const fn = qualifiedName(tokens, index + 1)
  index = fn.end
  if (tokens[index++]?.value !== '(') reject()
  while (tokens[index]?.value !== ')') {
    if (tokens[index++]?.kind !== 'literal') reject()
    if (tokens[index]?.value === ',') index++
    else if (tokens[index]?.value !== ')') reject()
  }
  if (index !== tokens.length - 1) reject()
  return { name, table: table.name, fn: fn.name }
}

// DROP TRIGGER IF EXISTS name ON table: only to re-create the same trigger idempotently.
function dropTrigger(tokens) {
  let index = expect(tokens, 1, 'TRIGGER', 'IF', 'EXISTS')
  const { name, end } = qualifiedName(tokens, index)
  index = expect(tokens, end, 'ON')
  const table = qualifiedName(tokens, index)
  if (table.end !== tokens.length) reject()
  return { name, table: table.name }
}

/** Supported expansion only: new tables, non-unique indexes, nullable/defaulted
 * columns, new enum types/values, and the existing per-transaction lock budgets.
 * Also, since 2026-11-24 (Alex: no manual migration steps): unique or partial
 * indexes on a table the same migration creates, new trigger functions, and the
 * triggers that run them (re-created idempotently with DROP TRIGGER IF EXISTS).
 * Backfills, constraint changes, other functions and procedural SQL need their
 * separately reviewed path; an unknown statement never becomes a skip. */
export function assertAdditiveSql(sql) {
  const parsed = statements(sql)
  const createdTables = new Set(), functions = new Set(), triggers = []
  for (const tokens of parsed) {
    if (word(tokens[0], 'CREATE') && word(tokens[1], 'TABLE'))
      createdTables.add(qualifiedName(tokens, optional(tokens, 2, ['IF', 'NOT', 'EXISTS'])).name)
    else if (word(tokens[0], 'CREATE') && (word(tokens[1], 'FUNCTION') || (word(tokens[1], 'OR') && word(tokens[2], 'REPLACE'))))
      functions.add(triggerFunction(tokens))
    else if (word(tokens[0], 'CREATE') && word(tokens[1], 'TRIGGER')) triggers.push(trigger(tokens))
  }
  // Every new function is installed by a trigger here, and every trigger either
  // runs a function created here or sits on a table created here.
  for (const name of functions) if (!triggers.some(item => item.fn === name)) reject()
  for (const item of triggers) if (!functions.has(item.fn) && !createdTables.has(item.table)) reject()

  for (const tokens of parsed) {
    if (word(tokens[0], 'CREATE') && (word(tokens[1], 'FUNCTION') || word(tokens[1], 'TRIGGER')
        || (word(tokens[1], 'OR') && word(tokens[2], 'REPLACE')))) continue
    if (word(tokens[0], 'DROP') && word(tokens[1], 'TRIGGER')) {
      const dropped = dropTrigger(tokens)
      if (!triggers.some(item => item.name === dropped.name && item.table === dropped.table)) reject()
      continue
    }
    if (word(tokens[0], 'CREATE') && word(tokens[1], 'UNIQUE') && word(tokens[2], 'INDEX')) {
      // A unique index can only fail or block on existing rows; a table created
      // by this same migration has none.
      let index = nameEnd(tokens, optional(tokens, 3, ['IF', 'NOT', 'EXISTS']))
      index = expect(tokens, index, 'ON')
      const table = qualifiedName(tokens, optional(tokens, index, ['ONLY']))
      if (!createdTables.has(table.name)) reject()
      newTableIndex(tokens, table.end)
      continue
    }
    if (word(tokens[0], 'CREATE') && word(tokens[1], 'INDEX') && tokens.some(token => word(token, 'WHERE'))) {
      let index = optional(tokens, 2, ['CONCURRENTLY'])
      index = nameEnd(tokens, optional(tokens, index, ['IF', 'NOT', 'EXISTS']))
      index = expect(tokens, index, 'ON')
      const table = qualifiedName(tokens, optional(tokens, index, ['ONLY']))
      if (!createdTables.has(table.name)) reject()
      newTableIndex(tokens, table.end)
      continue
    }
    if (tokens.some(token => token.kind === 'dollar')) reject()
    const words = tokens.filter(token => token.kind === 'word').map(token => token.value)
    if (words.some(value => ['DROP', 'TRUNCATE', 'INSERT', 'MERGE', 'EXECUTE', 'CALL', 'DO', 'FUNCTION', 'PROCEDURE',
      'TRIGGER', 'RULE', 'REPLACE', 'RENAME', 'COPY', 'SELECT', 'GRANT', 'REVOKE'].includes(value))) reject()
    for (let index = 0; index < tokens.length; index++) if (word(tokens[index], 'DELETE') || word(tokens[index], 'UPDATE'))
      if (!word(tokens[index - 1], 'ON')) reject()

    if (word(tokens[0], 'SET')) {
      if (!(word(tokens[1], 'LOCAL') && ['LOCK_TIMEOUT', 'STATEMENT_TIMEOUT'].some(value => word(tokens[2], value))
          && tokens[3]?.value === '=' && tokens.length === 5 && ['literal', 'number'].includes(tokens[4].kind)
          && /^[1-9][0-9]*(?:ms|s|min|h)?$/.test(tokens[4].value))) reject()
      continue
    }
    if (word(tokens[0], 'CREATE') && word(tokens[1], 'TABLE')) {
      const index = nameEnd(tokens, optional(tokens, 2, ['IF', 'NOT', 'EXISTS']))
      if (tokens[index]?.value !== '(' || tokens.at(-1)?.value !== ')') reject()
      // No CREATE TABLE AS, partition attachment, or statement after the definition.
      let depth = 0
      for (let at = index; at < tokens.length; at++) {
        if (tokens[at].value === '(') depth++
        if (tokens[at].value === ')') depth--
        if (depth === 0 && at !== tokens.length - 1) reject()
      }
      continue
    }
    if (word(tokens[0], 'CREATE') && word(tokens[1], 'INDEX')) {
      let index = optional(tokens, 2, ['CONCURRENTLY'])
      index = nameEnd(tokens, optional(tokens, index, ['IF', 'NOT', 'EXISTS']))
      if (!word(tokens[index++], 'ON')) reject()
      index = nameEnd(tokens, optional(tokens, index, ['ONLY']))
      if (tokens[index]?.value !== '(' || tokens.at(-1)?.value !== ')') reject()
      // Column names and ordering only: expressions and operator classes may
      // execute stored functions while PostgreSQL indexes existing rows.
      additiveIndexFields(tokens.slice(index + 1, -1))
      continue
    }
    if (word(tokens[0], 'ALTER') && word(tokens[1], 'TABLE')) {
      let index = nameEnd(tokens, optional(tokens, 2, ['ONLY']))
      const clauses = [], clause = []; let depth = 0
      for (const token of tokens.slice(index)) {
        if (token.value === '(') depth++
        if (token.value === ')') depth--
        if (token.value === ',' && depth === 0) clauses.push(clause.splice(0))
        else clause.push(token)
      }
      clauses.push(clause)
      for (const fields of clauses) additiveColumn(fields)
      continue
    }
    if (word(tokens[0], 'CREATE') && word(tokens[1], 'TYPE')) {
      const index = nameEnd(tokens, 2)
      if (!(word(tokens[index], 'AS') && word(tokens[index + 1], 'ENUM') && tokens[index + 2]?.value === '(' && tokens.at(-1)?.value === ')'
          && tokens.slice(index + 3, -1).every(token => token.kind === 'literal' || token.value === ','))) reject()
      continue
    }
    if (word(tokens[0], 'ALTER') && word(tokens[1], 'TYPE')) {
      let index = nameEnd(tokens, 2)
      if (!(word(tokens[index++], 'ADD') && word(tokens[index++], 'VALUE'))) reject()
      index = optional(tokens, index, ['IF', 'NOT', 'EXISTS'])
      if (tokens[index++]?.kind !== 'literal') reject()
      if (index < tokens.length) {
        if (!['BEFORE', 'AFTER'].some(value => word(tokens[index], value))) reject()
        index++
        if (tokens[index++]?.kind !== 'literal') reject()
      }
      if (index !== tokens.length) reject()
      continue
    }
    reject()
  }
  return parsed.length
}

// A data-changing migration (backfill, DROP INDEX, DO block) runs automatically
// once its own reviewed PR marks it in the file header:
//   -- migrate: reviewed-data #<PR> <what it changes>
// Contract migrations keep their owner window. Alex, 2026-11-24: review data
// migrations at PR time instead of stopping the pipeline after merge.
const reviewedDataHeader = /^--\s*migrate:\s*reviewed-data\s+#[1-9]\d*\s+\S.*$/i
const contractHeader = /^--\s*migrate:\s*contract\b/i

// Published before the header existed; already applied in production by its
// owner (Settings > Models v6) and reviewed for the pipeline on 2026-11-24.
// Bound to the exact bytes, so an edit cannot inherit the review.
export const reviewedDataMigrations = Object.freeze({
  '20261124010135_multi_api_keys_and_default_effort.sql': '5b3e514d3bfdf4b018f5ae0b1bcf661e0bdd2c386d97d6ce42eaf6544bc36b80',
})

function leadingComments(sql) {
  const lines = []
  for (const line of sql.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '' && !trimmed.startsWith('--')) break
    lines.push(trimmed)
  }
  return lines
}

/** The one automatic-migration rule, shared by zero-writer admission and the
 * deploy step: additive SQL, or a data migration its reviewed PR marked.
 * Returns 'additive' or 'reviewed-data'; anything else throws. */
export function assertAutomaticSql(name, sql) {
  const header = leadingComments(sql)
  if (header.some(line => contractHeader.test(line))) assert.fail('Contract migrations require the separate owner window')
  const digest = createHash('sha256').update(sql).digest('hex')
  if (header.some(line => reviewedDataHeader.test(line)) || reviewedDataMigrations[name] === digest) {
    statements(sql) // Still one lexable SQL file; the product migrator runs its bytes.
    return 'reviewed-data'
  }
  assertAdditiveSql(sql)
  return 'additive'
}

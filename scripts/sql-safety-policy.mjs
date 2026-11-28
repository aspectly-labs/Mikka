// Static SQL safety policy gate: prevents PostgreSQL 500 crashes from unsafe
// JSONB text-to-scalar casts such as `(m.message->>'mikkaSuperseded')::boolean`
// or unguarded `(col->>'id')::int|uuid|numeric`.
// Safe primitives live in `lib/primitives/jsonb-predicates.ts`.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const self = 'scripts/sql-safety-policy.mjs'

export const sqlSafetyRules = {
  unsafeJsonbBooleanCast: 'sql-safety/unsafe-jsonb-boolean-cast',
  unguardedJsonbScalarCast: 'sql-safety/unguarded-jsonb-scalar-cast',
}

export const unsafeBooleanCastMessage =
  'Never cast a JSONB text extraction (->> / #>>) to ::boolean — non-boolean values (such as a revision UUID string) crash PostgreSQL with 500. Use jsonbFlagIsTrue, jsonbFlagIsNotTrue, jsonbFlagIsNotFalse, jsonbSafeBool, or jsonbUnsetOrFalse from lib/primitives/jsonb-predicates.ts.'

export const unguardedScalarCastMessage =
  'Unguarded JSONB text extraction (->> / #>>) cast to a scalar type crashes PostgreSQL with 500 on malformed values. Use jsonbSafeInt / jsonbSafeBigInt / jsonbSafeNumeric / jsonbSafeDouble / jsonbSafeUuid from lib/primitives/jsonb-predicates.ts (or guard inside CASE WHEN ... ~ / pg_input_is_valid / jsonb_typeof).'

const BOOLEAN_CAST_TYPES = new Set(['boolean', 'bool'])
const SCALAR_TYPE_PATTERN =
  '(?:pg_catalog\\.)?(?:boolean|bool|double\\s+precision|integer|bigint|smallint|int2|int4|int8|int|uuid|numeric|decimal|real|float4|float8|float)(?:\\s*\\(\\s*\\d+(?:\\s*,\\s*\\d+)?\\s*\\))?'
const SCALAR_CAST_RE = new RegExp(`::\\s*(${SCALAR_TYPE_PATTERN})(?![A-Za-z0-9_])`, 'gi')
const CAST_TYPE_TAIL_RE = new RegExp(`\\bAS\\s+(${SCALAR_TYPE_PATTERN})\\s*$`, 'i')

const UNCONSTRAINED_NUMERIC_TYPES = new Set(['numeric', 'decimal'])

const PG_INPUT_COMPATIBLE_TYPES = {
  smallint: new Set(['smallint', 'int2']),
  int2: new Set(['smallint', 'int2']),
  int: new Set(['int', 'int4', 'integer', 'smallint', 'int2']),
  int4: new Set(['int', 'int4', 'integer', 'smallint', 'int2']),
  integer: new Set(['int', 'int4', 'integer', 'smallint', 'int2']),
  bigint: new Set(['bigint', 'int8', 'int', 'int4', 'integer', 'smallint', 'int2']),
  int8: new Set(['bigint', 'int8', 'int', 'int4', 'integer', 'smallint', 'int2']),
  uuid: new Set(['uuid']),
  numeric: new Set(['numeric', 'decimal', 'bigint', 'int8', 'int', 'int4', 'integer', 'smallint', 'int2']),
  decimal: new Set(['numeric', 'decimal', 'bigint', 'int8', 'int', 'int4', 'integer', 'smallint', 'int2']),
  real: new Set(['real', 'float4', 'smallint', 'int2']),
  float4: new Set(['real', 'float4', 'smallint', 'int2']),
  'double precision': new Set(['double precision', 'float8', 'float', 'real', 'float4', 'bigint', 'int8', 'int', 'int4', 'integer', 'smallint', 'int2']),
  float8: new Set(['double precision', 'float8', 'float', 'real', 'float4', 'bigint', 'int8', 'int', 'int4', 'integer', 'smallint', 'int2']),
  float: new Set(['double precision', 'float8', 'float', 'real', 'float4', 'bigint', 'int8', 'int', 'int4', 'integer', 'smallint', 'int2']),
}

function normalizeCastType(raw) {
  return raw
    .toLowerCase()
    .replace(/^pg_catalog\./, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s*\)/g, ')')
    .trim()
}

const SAFE_AGGREGATE_OR_METADATA_FUNCTIONS = new Set([
  'count',
  'sum',
  'avg',
  'length',
  'char_length',
  'character_length',
  'octet_length',
  'bit_length',
  'jsonb_array_length',
  'array_length',
  'cardinality',
  'extract',
  'floor',
  'ceil',
  'ceiling',
  'round',
  'trunc',
  'abs',
  'sign',
  'position',
  'strpos',
  'date_part',
  'to_timestamp',
  'now',
  'clock_timestamp',
  'regexp_match',
  'regexp_matches',
  'to_jsonb',
  'jsonb_build_object',
  'jsonb_build_array',
  'jsonb_agg',
  'jsonb_typeof',
])

const PASSTHROUGH_FUNCTIONS = new Set([
  'coalesce',
  'nullif',
  'btrim',
  'trim',
  'ltrim',
  'rtrim',
  'lower',
  'upper',
  'min',
  'max',
  'greatest',
  'least',
  'substr',
  'substring',
  'left',
  'right',
  'split_part',
  'replace',
])

const SQL_KEYWORDS_BEFORE_PAREN = new Set([
  'all',
  'always',
  'and',
  'any',
  'as',
  'between',
  'by',
  'case',
  'check',
  'constraint',
  'default',
  'distinct',
  'else',
  'except',
  'exists',
  'filter',
  'for',
  'from',
  'generated',
  'group',
  'groups',
  'having',
  'ilike',
  'in',
  'intersect',
  'into',
  'is',
  'join',
  'lateral',
  'like',
  'limit',
  'not',
  'offset',
  'on',
  'only',
  'or',
  'order',
  'over',
  'partition',
  'range',
  'recursive',
  'returning',
  'rows',
  'select',
  'set',
  'similar',
  'some',
  'stored',
  'then',
  'to',
  'union',
  'using',
  'values',
  'when',
  'where',
  'with',
  'within',
])

/** Strip SQL comments outside single-quoted literals while preserving string length and line breaks. */
function stripSqlComments(sql) {
  let out = ''
  let i = 0
  let inSingle = false
  let inDouble = false
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (inSingle) {
      out += ch
      if (ch === "'" && next === "'") {
        out += next
        i += 2
        continue
      }
      if (ch === "'") inSingle = false
      i++
      continue
    }
    if (inDouble) {
      out += ch
      if (ch === '"' && next === '"') {
        out += next
        i += 2
        continue
      }
      if (ch === '"') inDouble = false
      i++
      continue
    }
    if (ch === "'") {
      inSingle = true
      out += ch
      i++
      continue
    }
    if (ch === '"') {
      inDouble = true
      out += ch
      i++
      continue
    }
    if (ch === '-' && next === '-') {
      out += '  '
      i += 2
      while (i < sql.length && sql[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (ch === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < sql.length) {
        out += '  '
        i += 2
      }
      continue
    }
    out += ch
    i++
  }
  return out
}

/** Build boolean array marking character indices inside single-quoted SQL strings. */
function singleQuoteMask(sql) {
  const mask = new Uint8Array(sql.length)
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (inSingle) {
      mask[i] = 1
      if (ch === "'" && next === "'") {
        mask[i + 1] = 1
        i++
        continue
      }
      if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (ch === '"' && next === '"') {
        i++
        continue
      }
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === "'") {
      inSingle = true
      mask[i] = 1
    } else if (ch === '"') {
      inDouble = true
    }
  }
  return mask
}

function findMatchingOpenParen(sql, closeIdx, mask) {
  let depth = 0
  for (let i = closeIdx; i >= 0; i--) {
    if (mask[i]) continue
    const ch = sql[i]
    if (ch === ')') depth++
    else if (ch === '(') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function findMatchingCloseParen(sql, openIdx, mask) {
  let depth = 0
  for (let i = openIdx; i < sql.length; i++) {
    if (mask[i]) continue
    const ch = sql[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function stripOuterParens(expr) {
  let s = expr.trim()
  while (s.startsWith('(') && s.endsWith(')')) {
    const m = singleQuoteMask(s)
    if (findMatchingCloseParen(s, 0, m) === s.length - 1) {
      s = s.slice(1, -1).trim()
    } else {
      break
    }
  }
  return s
}

function splitTopLevelCommas(expr) {
  const m = singleQuoteMask(expr)
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < expr.length; i++) {
    if (m[i]) continue
    const ch = expr[i]
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      parts.push(expr.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(expr.slice(start).trim())
  return parts.filter(Boolean)
}

/** Check if an expression has a top-level boolean/comparison operator (excluding JSONB -> / ->> / #> / #>>). */
function hasTopLevelComparison(expr) {
  const s = stripOuterParens(expr)
  const m = singleQuoteMask(s)
  let depth = 0
  let inDouble = false
  for (let i = 0; i < s.length; i++) {
    if (m[i]) continue
    const ch = s[i]
    if (inDouble) {
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === '"') {
      inDouble = true
      continue
    }
    if (ch === '(' || ch === '[') { depth++; continue }
    if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); continue }
    if (depth > 0) continue

    // Skip JSONB operators ->, ->>, #>, #>>, @>, <@
    if ((ch === '-' || ch === '#') && s[i + 1] === '>') {
      i += s[i + 2] === '>' ? 2 : 1
      continue
    }
    if ((ch === '@' && s[i + 1] === '>') || (ch === '<' && s[i + 1] === '@')) {
      i++
      continue
    }
    if (ch === '=' || ch === '<' || ch === '>' || ch === '~' || (ch === '!' && s[i + 1] === '=')) {
      return true
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1
      while (end < s.length && /[A-Za-z0-9_]/.test(s[end])) end++
      const word = s.slice(i, end).toLowerCase()
      if (word === 'and' || word === 'or' || word === 'is' || word === 'in' || word === 'like' || word === 'ilike') {
        return true
      }
      i = end - 1
    }
  }
  return false
}

/** Check if an expression directly contains a top-level JSONB text extraction operator (->> or #>>). */
function hasTopLevelJsonbTextExtract(expr) {
  const s = stripOuterParens(expr)
  if (!s || /^(?:select|with)\b/i.test(s)) return false
  if (hasTopLevelComparison(s)) return false
  const m = singleQuoteMask(s)
  let depth = 0
  let inDouble = false
  for (let i = 0; i < s.length; i++) {
    if (m[i]) continue
    const ch = s[i]
    if (inDouble) {
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === '"') {
      inDouble = true
      continue
    }
    if (ch === '(' || ch === '[') { depth++; continue }
    if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); continue }
    if (depth === 0 && (ch === '-' || ch === '#') && s[i + 1] === '>' && s[i + 2] === '>') {
      return true
    }
  }
  return false
}

/** Normalize an expression string for comparing guarded expressions in CASE WHEN vs THEN. */
function normalizeSqlExpr(expr) {
  let s = stripOuterParens(expr)
  // Normalize whitespace outside quotes and collapse spaces around operators.
  let out = ''
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    const next = s[i + 1]
    if (inSingle) {
      out += ch
      if (ch === "'" && next === "'") { out += next; i++; continue }
      if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      out += ch
      if (ch === '"' && next === '"') { out += next; i++; continue }
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === "'") { inSingle = true; out += ch; continue }
    if (ch === '"') { inDouble = true; out += ch; continue }
    if (/\s/.test(ch)) {
      if (out.length && !out.endsWith(' ')) out += ' '
    } else {
      out += ch
    }
  }
  return out
    .trim()
    .replace(/\s*(#>>|->>|#>|->|::|\(|\)|,|\[|\])\s*/g, '$1')
}

/** Convert a `->>` / `#>>` expression into the equivalent JSONB node path (`->` / `#>`) for `jsonb_typeof` checks. */
function toJsonbNodeExpr(normTextExpr) {
  const lastTextArrow = Math.max(normTextExpr.lastIndexOf('->>'), normTextExpr.lastIndexOf('#>>'))
  if (lastTextArrow === -1) return null
  const op = normTextExpr.slice(lastTextArrow, lastTextArrow + 3)
  const replacement = op === '->>' ? '->' : '#>'
  return normTextExpr.slice(0, lastTextArrow) + replacement + normTextExpr.slice(lastTextArrow + 3)
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Extract top-level required `AND` conjuncts from a SQL boolean expression.
 * Returns `[]` if any top-level `OR` is present (since an `OR` branch is not guaranteed to hold),
 * recursively flattens parenthesized `AND` groups, and excludes negated (`NOT ...`) conjuncts.
 */
function extractRequiredConjuncts(clause) {
  const s = stripOuterParens(clause)
  if (!s) return []
  const m = singleQuoteMask(s)
  let depth = 0
  let inDouble = false
  const andSplits = []
  for (let i = 0; i < s.length; i++) {
    if (m[i]) continue
    const ch = s[i]
    if (inDouble) {
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === '"') { inDouble = true; continue }
    if (ch === '(' || ch === '[') { depth++; continue }
    if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); continue }
    if (depth > 0) continue
    if (!/[A-Za-z_]/.test(ch)) continue
    let end = i + 1
    while (end < s.length && /[A-Za-z0-9_]/.test(s[end])) end++
    const prev = i > 0 ? s[i - 1] : ''
    const word = s.slice(i, end).toLowerCase()
    if (prev !== '.') {
      if (word === 'or') return []
      if (word === 'and') andSplits.push([i, end])
    }
    i = end - 1
  }
  if (andSplits.length === 0) {
    if (/^not\b/i.test(s)) return []
    return [s]
  }
  const parts = []
  let start = 0
  for (const [splitStart, splitEnd] of andSplits) {
    parts.push(s.slice(start, splitStart).trim())
    start = splitEnd
  }
  parts.push(s.slice(start).trim())
  return parts.flatMap(part => extractRequiredConjuncts(part))
}

/** Check whether a WHEN condition guarantees `extractedExpr` is valid for `castType`. */
function whenGuardsExpression(whenClause, extractedExpr, castType) {
  const normExpr = normalizeSqlExpr(extractedExpr)
  if (!normExpr) return false

  const conjuncts = extractRequiredConjuncts(whenClause)
  if (conjuncts.length === 0) return false

  const normCastType = normalizeCastType(castType)
  const hasModifier = normCastType.includes('(')
  const baseType = hasModifier ? normCastType.slice(0, normCastType.indexOf('(')) : normCastType

  const exprVariants = [normExpr]
  // Allow unwrapping inner parens around base: `((a->'b')->>'c')` vs `a->'b'->>'c'`
  const unwrapped = normExpr.replace(/^\(([^()]+)\)(->>|#>>)/, '$1$2')
  if (unwrapped !== normExpr) exprVariants.push(unwrapped)

  for (const rawConjunct of conjuncts) {
    const normConjunct = normalizeSqlExpr(rawConjunct)
    if (!normConjunct || /^not\b/i.test(normConjunct)) continue

    for (const variant of exprVariants) {
      const escaped = escapeRegExp(variant)

      // 1. PostgreSQL 16+ `pg_input_is_valid(expr, 'target_type')` with compatible target type
      const pgValidMatch = new RegExp(`^pg_input_is_valid\\(\\s*\\(*${escaped}\\)*\\s*,\\s*'([^']+)'\\s*\\)$`, 'i').exec(normConjunct)
      if (pgValidMatch) {
        const validatedType = normalizeCastType(pgValidMatch[1])
        if (hasModifier) {
          if (validatedType === normCastType) return true
        } else if (PG_INPUT_COMPATIBLE_TYPES[baseType]?.has(validatedType)) {
          return true
        }
      }

      // 2. Regex match guard: `expr ~ '...'` or `(expr) ~* ...` (only for unconstrained types)
      if (!hasModifier && new RegExp(`^\\(*${escaped}\\)*\\s*~\\*?\\s*`, 'i').test(normConjunct)) {
        return true
      }

      // 3. `jsonb_typeof(col->'k') = 'number'` (only safe for unconstrained numeric/decimal, not integer types)
      if (!hasModifier && UNCONSTRAINED_NUMERIC_TYPES.has(baseType)) {
        const nodeVariant = toJsonbNodeExpr(variant)
        if (nodeVariant) {
          const escapedNode = escapeRegExp(nodeVariant)
          if (new RegExp(`^jsonb_typeof\\(\\s*\\(*${escapedNode}\\)*\\s*\\)\\s*=\\s*'number'$`, 'i').test(normConjunct)) {
            return true
          }
        }
      }
    }
  }
  return false
}

/** Walk SQL tokens up to `targetIdx` and return active `CASE ... WHEN <cond> THEN` conditions enclosing `targetIdx`. */
function enclosingWhenClauses(sql, targetIdx, mask) {
  const stack = []
  let inDouble = false
  for (let i = 0; i < targetIdx; i++) {
    if (mask[i]) continue
    const ch = sql[i]
    if (inDouble) {
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === '"') { inDouble = true; continue }
    if (!/[A-Za-z_]/.test(ch)) continue
    let end = i + 1
    while (end < targetIdx && /[A-Za-z0-9_]/.test(sql[end])) end++
    const word = sql.slice(i, end).toLowerCase()
    // Ensure not part of a qualified identifier after '.'
    const prevNonSpace = sql.slice(0, i).trimEnd()
    if (prevNonSpace.endsWith('.')) { i = end - 1; continue }

    if (word === 'case') {
      stack.push({ state: 'case', whenStart: -1, whenText: '' })
    } else if (word === 'when' && stack.length > 0) {
      const top = stack[stack.length - 1]
      top.state = 'when'
      top.whenStart = end
      top.whenText = ''
    } else if (word === 'then' && stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top.state === 'when' && top.whenStart >= 0) {
        top.whenText = sql.slice(top.whenStart, i)
        top.state = 'then'
      }
    } else if (word === 'else' && stack.length > 0) {
      const top = stack[stack.length - 1]
      top.state = 'else'
      top.whenText = ''
    } else if (word === 'end' && stack.length > 0) {
      stack.pop()
    }
    i = end - 1
  }
  return stack.filter(frame => frame.state === 'then' && frame.whenText).map(frame => frame.whenText)
}

/**
 * Inspect a `(CASE WHEN ... THEN ... [ELSE ...] END)::type` expression.
 * Returns any unguarded JSONB text extractions returned by branches of that CASE.
 */
function inspectCaseExpressionForCast(caseBody, castType) {
  const s = stripOuterParens(caseBody)
  const m = singleQuoteMask(s)
  const tokens = []
  let depth = 0
  let inDouble = false
  for (let i = 0; i < s.length; i++) {
    if (m[i]) continue
    const ch = s[i]
    if (inDouble) {
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === '"') { inDouble = true; continue }
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue }
    if (depth > 0) continue
    if (!/[A-Za-z_]/.test(ch)) continue
    let end = i + 1
    while (end < s.length && /[A-Za-z0-9_]/.test(s[end])) end++
    const word = s.slice(i, end).toLowerCase()
    if (word === 'case' || word === 'when' || word === 'then' || word === 'else' || word === 'end') {
      tokens.push({ word, start: i, end })
    }
    i = end - 1
  }

  // Track depth of nested CASE...END at paren depth 0.
  const branches = []
  let caseDepth = 0
  let currentWhen = null
  let branchStart = -1
  let branchKind = null
  for (const tok of tokens) {
    if (tok.word === 'case') {
      caseDepth++
      continue
    }
    if (tok.word === 'end') {
      if (caseDepth === 1 && branchStart >= 0) {
        branches.push({ kind: branchKind, when: currentWhen, expr: s.slice(branchStart, tok.start).trim() })
        branchStart = -1
      }
      caseDepth--
      continue
    }
    if (caseDepth !== 1) continue
    if (tok.word === 'when') {
      if (branchStart >= 0) {
        branches.push({ kind: branchKind, when: currentWhen, expr: s.slice(branchStart, tok.start).trim() })
        branchStart = -1
      }
      currentWhen = { start: tok.end, text: '' }
      branchKind = null
    } else if (tok.word === 'then') {
      if (currentWhen) currentWhen.text = s.slice(currentWhen.start, tok.start).trim()
      branchKind = 'then'
      branchStart = tok.end
    } else if (tok.word === 'else') {
      if (branchStart >= 0) {
        branches.push({ kind: branchKind, when: currentWhen, expr: s.slice(branchStart, tok.start).trim() })
      }
      currentWhen = null
      branchKind = 'else'
      branchStart = tok.end
    }
  }

  const unguarded = []
  for (const branch of branches) {
    const extracted = extractJsonbTextOperands(branch.expr)
    for (const op of extracted) {
      if (BOOLEAN_CAST_TYPES.has(castType)) {
        unguarded.push(op)
      } else if (branch.kind !== 'then' || !branch.when?.text || !whenGuardsExpression(branch.when.text, op, castType)) {
        unguarded.push(op)
      }
    }
  }
  return unguarded
}

/** Extract direct JSONB text-extraction operands from an expression (recursing through pass-through functions). */
function extractJsonbTextOperands(expr) {
  const s = stripOuterParens(expr)
  if (!s) return []
  if (hasTopLevelJsonbTextExtract(s)) return [s]
  const fnMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(s)
  if (fnMatch) {
    const fnName = fnMatch[1].toLowerCase()
    const openIdx = s.indexOf('(')
    const m = singleQuoteMask(s)
    const closeIdx = findMatchingCloseParen(s, openIdx, m)
    if (closeIdx === s.length - 1) {
      if (SAFE_AGGREGATE_OR_METADATA_FUNCTIONS.has(fnName)) return []
      if (PASSTHROUGH_FUNCTIONS.has(fnName)) {
        const args = splitTopLevelCommas(s.slice(openIdx + 1, closeIdx))
        return args.flatMap(arg => extractJsonbTextOperands(arg))
      }
    }
  }
  return []
}

/** Find all unsafe JSONB casts inside a single SQL string. Returns offsets relative to `sql`. */
export function scanSqlForUnsafeJsonbCasts(rawSql) {
  if (!rawSql.includes('->>') && !rawSql.includes('#>>')) return []
  const sql = stripSqlComments(rawSql)
  const mask = singleQuoteMask(sql)
  const findings = []
  const seen = new Set()

  const record = (offset, castType, snippet, rule) => {
    const key = `${offset}:${rule}`
    if (seen.has(key)) return
    seen.add(key)
    findings.push({
      offset,
      rule,
      castType,
      snippet: snippet.replace(/\s+/g, ' ').trim(),
      message: rule === sqlSafetyRules.unsafeJsonbBooleanCast ? unsafeBooleanCastMessage : unguardedScalarCastMessage,
    })
  }

  const checkOperand = (operand, operandStart, castEnd, rawCastType) => {
    const castType = normalizeCastType(rawCastType)
    const baseCastType = castType.includes('(') ? castType.slice(0, castType.indexOf('(')) : castType
    const isBool = BOOLEAN_CAST_TYPES.has(baseCastType)
    const rule = isBool ? sqlSafetyRules.unsafeJsonbBooleanCast : sqlSafetyRules.unguardedJsonbScalarCast
    const stripped = stripOuterParens(operand)

    // Handle `(CASE ... END)::type`
    if (/^case\b/i.test(stripped) && /\bend$/i.test(stripped)) {
      const unguarded = inspectCaseExpressionForCast(stripped, castType)
      if (unguarded.length > 0) {
        record(operandStart, castType, rawSql.slice(operandStart, castEnd), rule)
      }
      return
    }

    const targets = extractJsonbTextOperands(operand)
    if (targets.length === 0) return

    if (isBool) {
      record(operandStart, castType, rawSql.slice(operandStart, castEnd), rule)
      return
    }

    const whens = enclosingWhenClauses(sql, operandStart, mask)
    for (const target of targets) {
      const guarded = whens.some(whenClause => whenGuardsExpression(whenClause, target, castType))
      if (!guarded) {
        record(operandStart, castType, rawSql.slice(operandStart, castEnd), rule)
        break
      }
    }
  }

  // 1. Scan PostgreSQL `::type` casts
  SCALAR_CAST_RE.lastIndex = 0
  let match
  while ((match = SCALAR_CAST_RE.exec(sql)) !== null) {
    const castIdx = match.index
    if (mask[castIdx]) continue
    const castType = match[1]
    const castEnd = castIdx + match[0].length

    // Skip trailing whitespace before `::`
    let leftEnd = castIdx - 1
    while (leftEnd >= 0 && /\s/.test(sql[leftEnd])) leftEnd--
    if (leftEnd < 0) continue

    if (sql[leftEnd] === ')') {
      const openIdx = findMatchingOpenParen(sql, leftEnd, mask)
      if (openIdx < 0) continue

      // Check if preceded by a function name
      let fnStart = openIdx
      let scan = openIdx - 1
      while (scan >= 0 && /\s/.test(sql[scan])) scan--
      let fnName = ''
      if (scan >= 0 && /[A-Za-z0-9_]/.test(sql[scan])) {
        const idEnd = scan + 1
        while (scan >= 0 && /[A-Za-z0-9_]/.test(sql[scan])) scan--
        fnName = sql.slice(scan + 1, idEnd).toLowerCase()
        fnStart = scan + 1
      }

      if (fnName && !SQL_KEYWORDS_BEFORE_PAREN.has(fnName)) {
        if (SAFE_AGGREGATE_OR_METADATA_FUNCTIONS.has(fnName)) continue
        if (PASSTHROUGH_FUNCTIONS.has(fnName)) {
          const operand = sql.slice(fnStart, leftEnd + 1)
          checkOperand(operand, fnStart, castEnd, castType)
        }
        continue
      }

      const operand = sql.slice(openIdx, leftEnd + 1)
      checkOperand(operand, openIdx, castEnd, castType)
    } else if (/\bend$/i.test(sql.slice(0, leftEnd + 1))) {
      // Unparenthesized `CASE ... END::type`: walk backward to matching CASE
      const prefix = sql.slice(0, leftEnd + 1)
      const caseMatch = /\bcase\b[\s\S]*\bend$/i.exec(prefix)
      if (caseMatch) {
        checkOperand(caseMatch[0], caseMatch.index, castEnd, castType)
      }
    }
  }

  // 2. Scan SQL standard `CAST(<expr> AS <type>)`
  const castFuncRe = /\bCAST\s*\(/gi
  while ((match = castFuncRe.exec(sql)) !== null) {
    const startIdx = match.index
    if (mask[startIdx]) continue
    const openIdx = sql.indexOf('(', startIdx)
    const closeIdx = findMatchingCloseParen(sql, openIdx, mask)
    if (closeIdx < 0) continue
    const inner = sql.slice(openIdx + 1, closeIdx)
    const tailMatch = CAST_TYPE_TAIL_RE.exec(inner)
    if (!tailMatch) continue
    const operand = inner.slice(0, tailMatch.index).trim()
    checkOperand(operand, startIdx, closeIdx + 1, tailMatch[1])
  }

  return findings
}

function constantModuleSpecifier(node) {
  if (!node) return null
  if (ts.isStringLiteralLike(node)) return node.text
  return null
}

/**
 * Purely assemble `{ segments, nodes, dynamicExprs }` from a string literal, template literal, or `+` concatenation
 * without speculatively mutating `consumed`. Dynamic operands inside `+` become `__EXPR__` and are still returned
 * in `dynamicExprs` so nested SQL expressions (e.g. ternaries) are scanned too.
 */
function assembleStringExpression(node, tree) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return {
      hasLiteral: true,
      segments: [{ text: node.text, start: node.getStart(tree) + 1 }],
      nodes: [node],
      dynamicExprs: [],
    }
  }
  if (ts.isTemplateExpression(node)) {
    const segments = [{ text: node.head.text, start: node.head.getStart(tree) + 1 }]
    const nodes = [node]
    const dynamicExprs = []
    for (const span of node.templateSpans) {
      const exprSegments = tryInlineConstantSegments(span.expression, tree)
      if (exprSegments) {
        segments.push(...exprSegments)
        nodes.push(span.expression)
      } else {
        segments.push({ text: '__EXPR__', start: span.expression.getStart(tree) })
        dynamicExprs.push(span.expression)
      }
      segments.push({ text: span.literal.text, start: span.literal.getStart(tree) + 1 })
    }
    return { hasLiteral: true, segments, nodes, dynamicExprs }
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = assembleStringExpression(node.left, tree)
    const right = assembleStringExpression(node.right, tree)
    if (!left.hasLiteral && !right.hasLiteral) {
      return {
        hasLiteral: false,
        segments: [{ text: '__EXPR__', start: node.getStart(tree) }],
        nodes: [],
        dynamicExprs: [node],
      }
    }
    return {
      hasLiteral: true,
      segments: [...left.segments, ...right.segments],
      nodes: [node, ...left.nodes, ...right.nodes],
      dynamicExprs: [...left.dynamicExprs, ...right.dynamicExprs],
    }
  }
  return {
    hasLiteral: false,
    segments: [{ text: '__EXPR__', start: node.getStart(tree) }],
    nodes: [],
    dynamicExprs: [node],
  }
}

function tryInlineConstantSegments(node, tree) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [{ text: node.text, start: node.getStart(tree) + 1 }]
  }
  return null
}

function mapOffsetToSource(segments, targetOffset) {
  let cursor = 0
  for (const seg of segments) {
    const next = cursor + seg.text.length
    if (targetOffset < next) {
      return seg.start + (targetOffset - cursor)
    }
    cursor = next
  }
  return segments.length ? segments[segments.length - 1].start : 0
}

/** Find all unsafe JSONB cast violations in a single JS/TS source file. */
export function findSqlSafetyViolations(file, source) {
  if (!source.includes('->>') && !source.includes('#>>')) return []
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const declarations = tree.statements.filter(ts.isImportDeclaration)
  if (declarations.some(node => /^(?:node:test|vitest|bun:test|@playwright\/test)$/.test(constantModuleSpecifier(node.moduleSpecifier) ?? ''))) {
    return []
  }

  const consumed = new Set()
  const findings = []
  const seen = new Set()

  const addFinding = (sourceOffset, item) => {
    const before = source.slice(0, sourceOffset)
    const line = before.split('\n').length
    const column = sourceOffset - before.lastIndexOf('\n')
    const key = `${line}:${column}:${item.rule}`
    if (seen.has(key)) return
    seen.add(key)
    findings.push({
      file,
      line,
      column,
      rule: item.rule,
      castType: item.castType,
      snippet: item.snippet,
      message: item.message,
    })
  }

  const visit = node => {
    if (!consumed.has(node) && (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node) ||
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    )) {
      const assembled = assembleStringExpression(node, tree)
      if (assembled.hasLiteral) {
        for (const consumedNode of assembled.nodes) consumed.add(consumedNode)
        const text = assembled.segments.map(s => s.text).join('')
        for (const item of scanSqlForUnsafeJsonbCasts(text)) {
          addFinding(mapOffsetToSource(assembled.segments, item.offset), item)
        }
        for (const expr of assembled.dynamicExprs) visit(expr)
        return
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(tree)
  return findings.sort((a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule))
}

export function auditSqlSafety(file, source) {
  return findSqlSafetyViolations(file, source)
}

export function sqlSafetyPolicyFiles(root = process.cwd()) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(
      file =>
        file &&
        file !== self &&
        /\.(?:[cm]?[jt]sx?)$/.test(file) &&
        !/(?:^|\/)(?:node_modules|\.next|dist|out|build|__tests__|tests?|e2e|__fixtures__|fixtures|\.claude|\.codex|\.hosted-ui)\//.test(file) &&
        !/\.(?:test|spec|fixture|stories)\.[cm]?[jt]sx?$/.test(file) &&
        !file.endsWith('.d.ts') &&
        existsSync(resolve(root, file)),
    )
}

export function auditSqlSafetyRepository(root = process.cwd()) {
  const files = sqlSafetyPolicyFiles(root)
  const findings = files.flatMap(file => auditSqlSafety(file, readFileSync(resolve(root, file), 'utf8')))
  return { files: files.length, findings }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = auditSqlSafetyRepository()
  for (const finding of result.findings) {
    console.error(`${finding.file}:${finding.line}:${finding.column} ${finding.rule} (${finding.castType}): ${finding.snippet}\n  ${finding.message}`)
  }
  if (result.findings.length > 0) {
    console.error(`\nsql safety policy: ${result.findings.length} violation(s) found across ${result.files} files`)
    process.exitCode = 1
  } else {
    console.log(`sql safety policy: ${result.files} files scanned, 0 unsafe JSONB casts found`)
  }
}

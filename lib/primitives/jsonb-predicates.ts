import { Column, is, sql, type SQL, type SQLWrapper } from 'drizzle-orm'

export type JsonbColumn = SQLWrapper
export type JsonbPathSegment = string | number

export const JSONB_INT_PATTERN = '^-?[0-9]+$'
export const JSONB_NUMERIC_PATTERN = '^-?[0-9]+(\\.[0-9]+)?$'
export const JSONB_DOUBLE_PATTERN = '^-?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$'
export const JSONB_UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

const SIMPLE_SQL_IDENTIFIER = /^[A-Za-z_"][A-Za-z0-9_."]*$/
const UNSAFE_SQL_FRAGMENT = /[\0;]|--|\/\*|\*\//

function assertValidKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0 || key.includes('\0')) {
    throw new RangeError('JSONB key must be a non-empty string without NUL bytes')
  }
  return key
}

function formatSegmentSql(segment: JsonbPathSegment): string {
  if (typeof segment === 'number') {
    if (!Number.isSafeInteger(segment) || segment < 0) {
      throw new RangeError('JSONB array index must be a non-negative safe integer')
    }
    return String(segment)
  }
  const key = assertValidKey(segment)
  return `'${key.replaceAll("'", "''")}'`
}

function assertValidSqlExpr(expr: string): string {
  const trimmed = expr.trim()
  if (!trimmed || UNSAFE_SQL_FRAGMENT.test(trimmed)) {
    throw new RangeError('JSONB SQL expression must be a non-empty SQL expression without statement terminators or comments')
  }
  return trimmed
}

function wrapSqlExpr(expr: string): string {
  const valid = assertValidSqlExpr(expr)
  return SIMPLE_SQL_IDENTIFIER.test(valid) ? valid : `(${valid})`
}

function wrapDrizzleExpr(column: JsonbColumn): SQL {
  return is(column, Column) ? sql`${column}` : sql`(${column})`
}

function segmentRaw(segment: JsonbPathSegment): SQL {
  return sql.raw(formatSegmentSql(segment))
}

function jsonbTextExpr(column: JsonbColumn, key: JsonbPathSegment): SQL {
  return sql`${wrapDrizzleExpr(column)}->>${segmentRaw(key)}`
}

/** Traverse nested JSONB keys or array indices (`col->'a'->'b'`) for composition with predicates. */
export function jsonbPath(column: JsonbColumn, ...segments: readonly [JsonbPathSegment, ...JsonbPathSegment[]]): SQL {
  if (segments.length === 0) {
    throw new RangeError('jsonbPath requires at least one path segment')
  }
  let current = wrapDrizzleExpr(column)
  for (const segment of segments) {
    current = sql`${current}->${segmentRaw(segment)}`
  }
  return current
}

/**
 * True only when `column->key` is the JSON boolean `true`.
 * Missing keys, JSON `null`, `false`, strings (such as revision UUIDs), numbers, objects and arrays return `false` without throwing.
 */
export function jsonbFlagIsTrue(column: JsonbColumn, key: string): SQL<boolean> {
  return sql<boolean>`COALESCE(${wrapDrizzleExpr(column)}->${segmentRaw(assertValidKey(key))}, 'false'::jsonb) = 'true'::jsonb`
}

/**
 * True whenever `column->key` is NOT the JSON boolean `true`.
 * Safe for keys that may contain non-boolean values (e.g., strings, numbers, objects, JSON `null`).
 */
export function jsonbFlagIsNotTrue(column: JsonbColumn, key: string): SQL<boolean> {
  return sql<boolean>`COALESCE(${wrapDrizzleExpr(column)}->${segmentRaw(assertValidKey(key))}, 'false'::jsonb) IS DISTINCT FROM 'true'::jsonb`
}

/**
 * Opt-out / default-true boolean flag: true unless `column->key` is explicitly the JSON boolean `false`.
 * Missing keys, JSON `null`, `true`, and non-boolean values all evaluate to `true` without throwing.
 */
export function jsonbFlagIsNotFalse(column: JsonbColumn, key: string): SQL<boolean> {
  return sql<boolean>`COALESCE(${wrapDrizzleExpr(column)}->${segmentRaw(assertValidKey(key))}, 'true'::jsonb) IS DISTINCT FROM 'false'::jsonb`
}

/**
 * Tri-state JSONB boolean projection: `'true'::jsonb` -> `true`, `'false'::jsonb` -> `false`,
 * missing / JSON `null` / non-boolean values -> `NULL` without throwing.
 */
export function jsonbSafeBool(column: JsonbColumn, key: string): SQL<boolean | null> {
  const target = wrapDrizzleExpr(column)
  const k = segmentRaw(assertValidKey(key))
  return sql<boolean | null>`CASE WHEN ${target}->${k} = 'true'::jsonb THEN true WHEN ${target}->${k} = 'false'::jsonb THEN false ELSE NULL END`
}

/**
 * True when `column->key` is missing, JSON `null`, JSON `false`, or the empty string `""`.
 * False for `true` or any non-empty truthy marker (such as a revision UUID string in `mikkaSuperseded`), without casting to `boolean`.
 */
export function jsonbUnsetOrFalse(column: JsonbColumn, key: string): SQL<boolean> {
  return sql<boolean>`COALESCE(${wrapDrizzleExpr(column)}->${segmentRaw(assertValidKey(key))}, 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb, '""'::jsonb)`
}

/** Safe text extraction (`column->>key`) returning `string | null`. */
export function jsonbText(column: JsonbColumn, key: JsonbPathSegment): SQL<string | null> {
  return sql<string | null>`${jsonbTextExpr(column, key)}`
}

/** Regex-guarded 32-bit integer projection from JSONB text extraction; malformed values yield `NULL`. */
export function jsonbSafeInt(column: JsonbColumn, key: JsonbPathSegment): SQL<number | null> {
  const extracted = jsonbTextExpr(column, key)
  return sql<number | null>`CASE WHEN (${extracted}) ~ ${sql.raw(`'${JSONB_INT_PATTERN}'`)} THEN (${extracted})::integer ELSE NULL END`
}

/** Regex-guarded 64-bit integer projection from JSONB text extraction; malformed values yield `NULL`. */
export function jsonbSafeBigInt(column: JsonbColumn, key: JsonbPathSegment): SQL<string | null> {
  const extracted = jsonbTextExpr(column, key)
  return sql<string | null>`CASE WHEN (${extracted}) ~ ${sql.raw(`'${JSONB_INT_PATTERN}'`)} THEN (${extracted})::bigint ELSE NULL END`
}

/** Regex-guarded arbitrary-precision numeric projection from JSONB text extraction; malformed values yield `NULL`. */
export function jsonbSafeNumeric(column: JsonbColumn, key: JsonbPathSegment): SQL<string | null> {
  const extracted = jsonbTextExpr(column, key)
  return sql<string | null>`CASE WHEN (${extracted}) ~ ${sql.raw(`'${JSONB_NUMERIC_PATTERN}'`)} THEN (${extracted})::numeric ELSE NULL END`
}

/** Regex-guarded double precision projection from JSONB text extraction; malformed values yield `NULL`. */
export function jsonbSafeDouble(column: JsonbColumn, key: JsonbPathSegment): SQL<number | null> {
  const extracted = jsonbTextExpr(column, key)
  return sql<number | null>`CASE WHEN (${extracted}) ~ ${sql.raw(`'${JSONB_DOUBLE_PATTERN}'`)} THEN (${extracted})::double precision ELSE NULL END`
}

/** Regex-guarded UUID projection from JSONB text extraction; malformed values yield `NULL`. */
export function jsonbSafeUuid(column: JsonbColumn, key: JsonbPathSegment): SQL<string | null> {
  const extracted = jsonbTextExpr(column, key)
  return sql<string | null>`CASE WHEN (${extracted}) ~* ${sql.raw(`'${JSONB_UUID_PATTERN}'`)} THEN (${extracted})::uuid ELSE NULL END`
}

// --- Raw SQL fragment equivalents for pg Pool/PoolClient queries ---

/** Raw SQL equivalent of `jsonbFlagIsTrue`. */
export function jsonbFlagIsTrueSql(expr: string, key: string): string {
  return `COALESCE(${wrapSqlExpr(expr)}->${formatSegmentSql(assertValidKey(key))}, 'false'::jsonb) = 'true'::jsonb`
}

/** Raw SQL equivalent of `jsonbFlagIsNotTrue`. */
export function jsonbFlagIsNotTrueSql(expr: string, key: string): string {
  return `COALESCE(${wrapSqlExpr(expr)}->${formatSegmentSql(assertValidKey(key))}, 'false'::jsonb) IS DISTINCT FROM 'true'::jsonb`
}

/** Raw SQL equivalent of `jsonbFlagIsNotFalse`. */
export function jsonbFlagIsNotFalseSql(expr: string, key: string): string {
  return `COALESCE(${wrapSqlExpr(expr)}->${formatSegmentSql(assertValidKey(key))}, 'true'::jsonb) IS DISTINCT FROM 'false'::jsonb`
}

/** Raw SQL equivalent of `jsonbSafeBool`. */
export function jsonbSafeBoolSql(expr: string, key: string): string {
  const target = wrapSqlExpr(expr)
  const k = formatSegmentSql(assertValidKey(key))
  return `CASE WHEN ${target}->${k} = 'true'::jsonb THEN true WHEN ${target}->${k} = 'false'::jsonb THEN false ELSE NULL END`
}

/** Raw SQL equivalent of `jsonbUnsetOrFalse`. */
export function jsonbUnsetOrFalseSql(expr: string, key: string): string {
  return `COALESCE(${wrapSqlExpr(expr)}->${formatSegmentSql(assertValidKey(key))}, 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb, '""'::jsonb)`
}

/** Raw SQL equivalent of `jsonbText`. */
export function jsonbTextSql(expr: string, key: JsonbPathSegment): string {
  return `${wrapSqlExpr(expr)}->>${formatSegmentSql(key)}`
}

/** Regex-guarded integer cast over an arbitrary JSONB text-extraction SQL expression (e.g. dynamic keys or `#>>`). */
export function jsonbSafeIntExprSql(textExpr: string): string {
  const valid = assertValidSqlExpr(textExpr)
  return `CASE WHEN (${valid}) ~ '${JSONB_INT_PATTERN}' THEN (${valid})::integer ELSE NULL END`
}

/** Regex-guarded bigint cast over an arbitrary JSONB text-extraction SQL expression. */
export function jsonbSafeBigIntExprSql(textExpr: string): string {
  const valid = assertValidSqlExpr(textExpr)
  return `CASE WHEN (${valid}) ~ '${JSONB_INT_PATTERN}' THEN (${valid})::bigint ELSE NULL END`
}

/** Regex-guarded numeric cast over an arbitrary JSONB text-extraction SQL expression. */
export function jsonbSafeNumericExprSql(textExpr: string): string {
  const valid = assertValidSqlExpr(textExpr)
  return `CASE WHEN (${valid}) ~ '${JSONB_NUMERIC_PATTERN}' THEN (${valid})::numeric ELSE NULL END`
}

/** Regex-guarded double precision cast over an arbitrary JSONB text-extraction SQL expression. */
export function jsonbSafeDoubleExprSql(textExpr: string): string {
  const valid = assertValidSqlExpr(textExpr)
  return `CASE WHEN (${valid}) ~ '${JSONB_DOUBLE_PATTERN}' THEN (${valid})::double precision ELSE NULL END`
}

/** Regex-guarded UUID cast over an arbitrary JSONB text-extraction SQL expression. */
export function jsonbSafeUuidExprSql(textExpr: string): string {
  const valid = assertValidSqlExpr(textExpr)
  return `CASE WHEN (${valid}) ~* '${JSONB_UUID_PATTERN}' THEN (${valid})::uuid ELSE NULL END`
}

/** Raw SQL equivalent of `jsonbSafeInt`. */
export function jsonbSafeIntSql(expr: string, key: JsonbPathSegment): string {
  return jsonbSafeIntExprSql(jsonbTextSql(expr, key))
}

/** Raw SQL equivalent of `jsonbSafeBigInt`. */
export function jsonbSafeBigIntSql(expr: string, key: JsonbPathSegment): string {
  return jsonbSafeBigIntExprSql(jsonbTextSql(expr, key))
}

/** Raw SQL equivalent of `jsonbSafeNumeric`. */
export function jsonbSafeNumericSql(expr: string, key: JsonbPathSegment): string {
  return jsonbSafeNumericExprSql(jsonbTextSql(expr, key))
}

/** Raw SQL equivalent of `jsonbSafeDouble`. */
export function jsonbSafeDoubleSql(expr: string, key: JsonbPathSegment): string {
  return jsonbSafeDoubleExprSql(jsonbTextSql(expr, key))
}

/** Raw SQL equivalent of `jsonbSafeUuid`. */
export function jsonbSafeUuidSql(expr: string, key: JsonbPathSegment): string {
  return jsonbSafeUuidExprSql(jsonbTextSql(expr, key))
}

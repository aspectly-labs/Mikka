import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { sql } from 'drizzle-orm'
import { jsonb, pgTable, uuid } from 'drizzle-orm/pg-core'
import { PgDialect } from 'drizzle-orm/pg-core/dialect'
import {
  JSONB_DOUBLE_PATTERN,
  JSONB_INT_PATTERN,
  JSONB_NUMERIC_PATTERN,
  JSONB_UUID_PATTERN,
  jsonbFlagIsNotFalse,
  jsonbFlagIsNotFalseSql,
  jsonbFlagIsNotTrue,
  jsonbFlagIsNotTrueSql,
  jsonbFlagIsTrue,
  jsonbFlagIsTrueSql,
  jsonbPath,
  jsonbSafeBigInt,
  jsonbSafeBigIntExprSql,
  jsonbSafeBigIntSql,
  jsonbSafeBool,
  jsonbSafeBoolSql,
  jsonbSafeDouble,
  jsonbSafeDoubleSql,
  jsonbSafeInt,
  jsonbSafeIntSql,
  jsonbSafeNumeric,
  jsonbSafeNumericExprSql,
  jsonbSafeNumericSql,
  jsonbSafeUuid,
  jsonbSafeUuidExprSql,
  jsonbSafeUuidSql,
  jsonbText,
  jsonbTextSql,
  jsonbUnsetOrFalse,
  jsonbUnsetOrFalseSql,
} from './jsonb-predicates'

const dialect = new PgDialect()

const messages = pgTable('coordinator_messages', {
  id: uuid('id').primaryKey(),
  message: jsonb('message').notNull(),
})

const issues = pgTable('issues', {
  id: uuid('id').primaryKey(),
  content: jsonb('content').notNull(),
})

function render(expr: Parameters<PgDialect['sqlToQuery']>[0]): string {
  const rendered = dialect.sqlToQuery(expr)
  assert.deepEqual(rendered.params, [])
  return rendered.sql
}

describe('Drizzle JSONB predicate helpers', () => {
  test('jsonbFlagIsTrue emits safe jsonb equality without ::boolean cast', () => {
    const out = render(jsonbFlagIsTrue(messages.message, 'mikkaRetried'))
    assert.equal(out, `COALESCE("coordinator_messages"."message"->'mikkaRetried', 'false'::jsonb) = 'true'::jsonb`)
    assert.doesNotMatch(out, /::bool(?:ean)?\b/i)
  })

  test('jsonbFlagIsNotTrue emits IS DISTINCT FROM true::jsonb', () => {
    const out = render(jsonbFlagIsNotTrue(messages.message, 'mikkaRetried'))
    assert.equal(out, `COALESCE("coordinator_messages"."message"->'mikkaRetried', 'false'::jsonb) IS DISTINCT FROM 'true'::jsonb`)
  })

  test('jsonbFlagIsNotFalse treats missing, null, and non-false values as true', () => {
    const out = render(jsonbFlagIsNotFalse(messages.message, 'enabled'))
    assert.equal(out, `COALESCE("coordinator_messages"."message"->'enabled', 'true'::jsonb) IS DISTINCT FROM 'false'::jsonb`)
  })

  test('jsonbSafeBool emits tri-state CASE without ::boolean cast', () => {
    const out = render(jsonbSafeBool(jsonbPath(messages.message, 'modelDispatch'), 'followed'))
    assert.equal(
      out,
      `CASE WHEN ("coordinator_messages"."message"->'modelDispatch')->'followed' = 'true'::jsonb THEN true WHEN ("coordinator_messages"."message"->'modelDispatch')->'followed' = 'false'::jsonb THEN false ELSE NULL END`,
    )
    assert.doesNotMatch(out, /::bool(?:ean)?\b/i)
  })

  test('jsonbUnsetOrFalse safely excludes non-empty strings like revision UUIDs in mikkaSuperseded', () => {
    const out = render(jsonbUnsetOrFalse(messages.message, 'mikkaSuperseded'))
    assert.equal(
      out,
      `COALESCE("coordinator_messages"."message"->'mikkaSuperseded', 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb, '""'::jsonb)`,
    )
    assert.doesNotMatch(out, /::bool(?:ean)?\b/i)
  })

  test('jsonbText supports string keys and non-negative array indices', () => {
    assert.equal(render(jsonbText(messages.message, 'role')), `"coordinator_messages"."message"->>'role'`)
    assert.equal(render(jsonbText(sql`q.v`, 0)), `(q.v)->>0`)
  })

  test('jsonbSafeInt wraps compound expressions and guards ::integer with regex + pg_input_is_valid', () => {
    const out = render(jsonbSafeInt(sql`coalesce(${issues.content}->'attrs'->'mikka', ${issues.content}->'attrs'->'orvilo')`, 'number'))
    assert.equal(
      out,
      `CASE WHEN ((coalesce("issues"."content"->'attrs'->'mikka', "issues"."content"->'attrs'->'orvilo'))->>'number') ~ '${JSONB_INT_PATTERN}' AND pg_input_is_valid(((coalesce("issues"."content"->'attrs'->'mikka', "issues"."content"->'attrs'->'orvilo'))->>'number'), 'integer') THEN ((coalesce("issues"."content"->'attrs'->'mikka', "issues"."content"->'attrs'->'orvilo'))->>'number')::integer ELSE NULL END`,
    )
  })

  test('jsonbSafeBigInt, jsonbSafeNumeric, jsonbSafeDouble, jsonbSafeUuid emit regex- and range-guarded casts', () => {
    assert.equal(
      render(jsonbSafeBigInt(messages.message, 'seq')),
      `CASE WHEN ("coordinator_messages"."message"->>'seq') ~ '${JSONB_INT_PATTERN}' AND pg_input_is_valid(("coordinator_messages"."message"->>'seq'), 'bigint') THEN ("coordinator_messages"."message"->>'seq')::bigint ELSE NULL END`,
    )
    assert.equal(
      render(jsonbSafeNumeric(messages.message, 'amount')),
      `CASE WHEN ("coordinator_messages"."message"->>'amount') ~ '${JSONB_NUMERIC_PATTERN}' AND pg_input_is_valid(("coordinator_messages"."message"->>'amount'), 'numeric') THEN ("coordinator_messages"."message"->>'amount')::numeric ELSE NULL END`,
    )
    assert.equal(
      render(jsonbSafeDouble(messages.message, 'until')),
      `CASE WHEN ("coordinator_messages"."message"->>'until') ~ '${JSONB_DOUBLE_PATTERN}' AND pg_input_is_valid(("coordinator_messages"."message"->>'until'), 'double precision') THEN ("coordinator_messages"."message"->>'until')::double precision ELSE NULL END`,
    )
    assert.equal(
      render(jsonbSafeUuid(messages.message, 'runId')),
      `CASE WHEN ("coordinator_messages"."message"->>'runId') ~* '${JSONB_UUID_PATTERN}' THEN ("coordinator_messages"."message"->>'runId')::uuid ELSE NULL END`,
    )
  })

  test('escapes single quotes in JSONB keys and rejects invalid keys/indices', () => {
    assert.equal(
      render(jsonbFlagIsTrue(messages.message, "o'reilly")),
      `COALESCE("coordinator_messages"."message"->'o''reilly', 'false'::jsonb) = 'true'::jsonb`,
    )
    assert.throws(() => jsonbFlagIsTrue(messages.message, ''), RangeError)
    assert.throws(() => jsonbFlagIsTrue(messages.message, 'bad\0key'), RangeError)
    assert.throws(() => jsonbText(messages.message, -1), RangeError)
    assert.throws(() => jsonbText(messages.message, 1.5), RangeError)
  })
})

describe('Raw SQL fragment helpers', () => {
  test('boolean helpers wrap compound expressions and preserve bare identifiers', () => {
    assert.equal(
      jsonbFlagIsTrueSql('m.lifecycle', 'sponsoredUnfunded'),
      `COALESCE(m.lifecycle->'sponsoredUnfunded', 'false'::jsonb) = 'true'::jsonb`,
    )
    assert.equal(
      jsonbFlagIsNotTrueSql('m.message', 'mikkaRetried'),
      `COALESCE(m.message->'mikkaRetried', 'false'::jsonb) IS DISTINCT FROM 'true'::jsonb`,
    )
    assert.equal(
      jsonbFlagIsNotFalseSql('to_jsonb(dev)', 'computerUseEnabled'),
      `COALESCE((to_jsonb(dev))->'computerUseEnabled', 'true'::jsonb) IS DISTINCT FROM 'false'::jsonb`,
    )
    assert.equal(
      jsonbSafeBoolSql('r."agentDefinition"', 'readOnly'),
      `CASE WHEN r."agentDefinition"->'readOnly' = 'true'::jsonb THEN true WHEN r."agentDefinition"->'readOnly' = 'false'::jsonb THEN false ELSE NULL END`,
    )
    assert.equal(
      jsonbUnsetOrFalseSql('m.message', 'mikkaSuperseded'),
      `COALESCE(m.message->'mikkaSuperseded', 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb, '""'::jsonb)`,
    )
  })

  test('scalar helpers emit regex- and range-guarded casts for simple, nested, and dynamic expressions', () => {
    assert.equal(jsonbTextSql('m.lifecycle', 'phase'), `m.lifecycle->>'phase'`)
    assert.equal(
      jsonbSafeIntSql("f.patch->'file'", 'additions'),
      `CASE WHEN ((f.patch->'file')->>'additions') ~ '${JSONB_INT_PATTERN}' AND pg_input_is_valid(((f.patch->'file')->>'additions'), 'integer') THEN ((f.patch->'file')->>'additions')::integer ELSE NULL END`,
    )
    assert.equal(
      jsonbSafeBigIntSql('lifecycle', 'reconcileVersion'),
      `CASE WHEN (lifecycle->>'reconcileVersion') ~ '${JSONB_INT_PATTERN}' AND pg_input_is_valid((lifecycle->>'reconcileVersion'), 'bigint') THEN (lifecycle->>'reconcileVersion')::bigint ELSE NULL END`,
    )
    assert.equal(
      jsonbSafeBigIntExprSql('u."planAllocations"->>g.id::text'),
      `CASE WHEN (u."planAllocations"->>g.id::text) ~ '${JSONB_INT_PATTERN}' AND pg_input_is_valid((u."planAllocations"->>g.id::text), 'bigint') THEN (u."planAllocations"->>g.id::text)::bigint ELSE NULL END`,
    )
    assert.equal(
      jsonbSafeNumericSql('$4::jsonb', 'id'),
      `CASE WHEN (($4::jsonb)->>'id') ~ '${JSONB_NUMERIC_PATTERN}' AND pg_input_is_valid((($4::jsonb)->>'id'), 'numeric') THEN (($4::jsonb)->>'id')::numeric ELSE NULL END`,
    )
    assert.equal(
      jsonbSafeNumericExprSql(`p."pullRequest"#>>ARRAY['reviewChecks','entries',$3,'id']`),
      `CASE WHEN (p."pullRequest"#>>ARRAY['reviewChecks','entries',$3,'id']) ~ '${JSONB_NUMERIC_PATTERN}' AND pg_input_is_valid((p."pullRequest"#>>ARRAY['reviewChecks','entries',$3,'id']), 'numeric') THEN (p."pullRequest"#>>ARRAY['reviewChecks','entries',$3,'id'])::numeric ELSE NULL END`,
    )
    assert.equal(
      jsonbSafeDoubleSql('m.lifecycle', 'reconcileUntil'),
      `CASE WHEN (m.lifecycle->>'reconcileUntil') ~ '${JSONB_DOUBLE_PATTERN}' AND pg_input_is_valid((m.lifecycle->>'reconcileUntil'), 'double precision') THEN (m.lifecycle->>'reconcileUntil')::double precision ELSE NULL END`,
    )
    assert.equal(
      jsonbSafeUuidSql('e.scope', 'factoryTaskId'),
      `CASE WHEN (e.scope->>'factoryTaskId') ~* '${JSONB_UUID_PATTERN}' THEN (e.scope->>'factoryTaskId')::uuid ELSE NULL END`,
    )
    assert.equal(
      jsonbSafeUuidExprSql('q.v->>0'),
      `CASE WHEN (q.v->>0) ~* '${JSONB_UUID_PATTERN}' THEN (q.v->>0)::uuid ELSE NULL END`,
    )
  })

  test('regex patterns accept valid inputs and reject crash-inducing values', () => {
    const intRe = new RegExp(JSONB_INT_PATTERN)
    assert.equal(intRe.test('0'), true)
    assert.equal(intRe.test('42'), true)
    assert.equal(intRe.test('-17'), true)
    assert.equal(intRe.test(''), false)
    assert.equal(intRe.test('3.14'), false)
    assert.equal(intRe.test('true'), false)
    assert.equal(intRe.test('550e8400-e29b-41d4-a716-446655440000'), false)

    const numRe = new RegExp(JSONB_NUMERIC_PATTERN)
    assert.equal(numRe.test('123456789012345'), true)
    assert.equal(numRe.test('-0.25'), true)
    assert.equal(numRe.test('1.'), false)
    assert.equal(numRe.test('NaN'), false)

    const dblRe = new RegExp(JSONB_DOUBLE_PATTERN)
    assert.equal(dblRe.test('1795465200000'), true)
    assert.equal(dblRe.test('1.5e12'), true)
    assert.equal(dblRe.test('Infinity'), false)

    const uuidRe = new RegExp(JSONB_UUID_PATTERN, 'i')
    assert.equal(uuidRe.test('550e8400-e29b-41d4-a716-446655440000'), true)
    assert.equal(uuidRe.test('550E8400-E29B-41D4-A716-446655440000'), true)
    assert.equal(uuidRe.test('not-a-uuid'), false)
    assert.equal(uuidRe.test(''), false)
  })

  test('rejects unsafe SQL expressions with terminators or comments', () => {
    assert.throws(() => jsonbFlagIsTrueSql('', 'a'), RangeError)
    assert.throws(() => jsonbFlagIsTrueSql('m.x; DROP TABLE users', 'a'), RangeError)
    assert.throws(() => jsonbSafeIntSql('m.x -- comment', 'a'), RangeError)
    assert.throws(() => jsonbSafeUuidSql('m.x /* comment */', 'a'), RangeError)
  })
})

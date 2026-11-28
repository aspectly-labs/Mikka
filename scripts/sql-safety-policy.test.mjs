import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import {
  auditSqlSafety,
  auditSqlSafetyRepository,
  findSqlSafetyViolations,
  scanSqlForUnsafeJsonbCasts,
  sqlSafetyRules,
} from './sql-safety-policy.mjs'

describe('sql-safety-policy: unsafe JSONB ::boolean casts', () => {
  test('flags the mikkaSuperseded ::boolean crash pattern', () => {
    const source = "const q = `SELECT * FROM coordinator_messages m WHERE COALESCE((m.message->>'mikkaSuperseded')::boolean, false) = false`"
    const findings = findSqlSafetyViolations('lib/example.ts', source)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].rule, sqlSafetyRules.unsafeJsonbBooleanCast)
    assert.equal(findings[0].castType, 'boolean')
    assert.equal(findings[0].line, 1)
  })

  test('flags ::bool, #>>, Drizzle tagged templates, COALESCE(...)::boolean, WHEN (...)::boolean, and CAST(... AS boolean)', () => {
    const cases = [
      "const q = `SELECT (col->>'flag')::bool`",
      "const q = `SELECT (col#>>'{nested,flag}')::boolean`",
      "const q = sql`(${agentRuns.agentDefinition}->'modelDispatch'->>'followed')::boolean`",
      "const q = `SELECT COALESCE(m.message->>'mikkaSuperseded', 'false')::boolean`",
      "const q = `SELECT CASE WHEN (m.lifecycle->>'sponsoredUnfunded')::boolean IS TRUE THEN 0 ELSE 1 END`",
      "const q = `SELECT CAST(m.message->>'flag' AS boolean)`",
      "const q = `SELECT CASE WHEN (m.message->>'flag') ~ '^(true|false)$' THEN (m.message->>'flag')::boolean END`",
      "const q = `SELECT (CASE WHEN x THEN m.message->>'flag' END)::boolean`",
    ]
    for (const source of cases) {
      const findings = findSqlSafetyViolations('lib/example.ts', source)
      assert.equal(findings.length, 1, `expected 1 boolean violation for: ${source}`)
      assert.equal(findings[0].rule, sqlSafetyRules.unsafeJsonbBooleanCast, source)
    }
  })

  test('allows safe native JSONB boolean predicates without ::boolean casts', () => {
    const safe = `
      const a = sql\`COALESCE(\${col}->'mikkaRetried', 'false'::jsonb) = 'true'::jsonb\`
      const b = sql\`COALESCE(\${col}->'mikkaRetried', 'false'::jsonb) IS DISTINCT FROM 'true'::jsonb\`
      const c = sql\`COALESCE(\${col}->'mikkaSuperseded', 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb, '""'::jsonb)\`
      const d = \`SELECT COALESCE((to_jsonb(u))->'hostedModelEnabled', 'true'::jsonb) IS DISTINCT FROM 'false'::jsonb\`
      const e = \`SELECT CASE WHEN col->'followed' = 'true'::jsonb THEN true WHEN col->'followed' = 'false'::jsonb THEN false ELSE NULL END\`
      const f = \`SELECT (col->>'role' = 'user')::boolean\`
    `
    assert.deepEqual(findSqlSafetyViolations('lib/example.ts', safe), [])
  })
})

describe('sql-safety-policy: unguarded JSONB scalar casts', () => {
  test('flags unguarded ::int, ::integer, ::bigint, ::uuid, ::numeric, ::double precision, pg_catalog.*, parameterized numeric, and CAST(...)', () => {
    const cases = [
      ["const q = `SELECT (col->>'n')::int`", 'int'],
      ["const q = `SELECT (col->>'n')::integer`", 'integer'],
      ["const q = `SELECT (col->>'n')::bigint`", 'bigint'],
      ["const q = `SELECT (col->>'n')::pg_catalog.int4`", 'int4'],
      ["const q = `SELECT (col->>'id')::uuid`", 'uuid'],
      ["const q = `SELECT (col#>>ARRAY['a','id'])::numeric`", 'numeric'],
      ["const q = `SELECT (col->>'amount')::numeric(8, 2)`", 'numeric(8,2)'],
      ["const q = `SELECT (col->>'until')::double precision`", 'double precision'],
      ["const q = `SELECT * FROM t WHERE x AND (definition#>>'{webhook,batchMinutes}')::int > 0`", 'int'],
      ["const q = `SELECT DISTINCT (result->>'id')::uuid FROM t`", 'uuid'],
      ["const q = `SELECT COALESCE(col->>'n', '0')::int`", 'int'],
      ["const q = `SELECT CAST(col->>'n' AS integer)`", 'integer'],
      ["const q = `SELECT CAST(doc->>'amount' AS numeric(8,2))`", 'numeric(8,2)'],
      ["const q = `SELECT MAX(col->>'n')::int`", 'int'],
    ]
    for (const [source, expectedType] of cases) {
      const findings = findSqlSafetyViolations('lib/example.ts', source)
      assert.equal(findings.length, 1, `expected 1 scalar violation for: ${source}`)
      assert.equal(findings[0].rule, sqlSafetyRules.unguardedJsonbScalarCast, source)
      assert.equal(findings[0].castType, expectedType, source)
    }
  })

  test('allows properly guarded CASE WHEN casts (~ / ~* / pg_input_is_valid / jsonb_typeof for numeric)', () => {
    const safe = `
      const a = \`SELECT CASE WHEN (col->>'n') ~ '^-?[0-9]+$' AND pg_input_is_valid((col->>'n'), 'integer') THEN (col->>'n')::integer ELSE NULL END\`
      const b = \`SELECT CASE WHEN (col->>'id') ~* '^[0-9a-f-]{36}$' THEN (col->>'id')::uuid END\`
      const c = \`SELECT CASE WHEN pg_input_is_valid(o.result->>'id', 'uuid') THEN (o.result->>'id')::uuid END\`
      const d = \`SELECT CASE WHEN jsonb_typeof(e.result->'task'->'amount')='number' THEN (e.result->'task'->>'amount')::numeric END\`
      const e = sql\`on e.id=(case when m.message#>>'{mikkaUserEvent,id}' ~* \${UUID} then m.message#>>'{mikkaUserEvent,id}' end)::uuid\`
      const f = \`SELECT
        CASE WHEN r."questionContinuation"->>'originRunId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          THEN (r."questionContinuation"->>'originRunId')::uuid END AS origin\`
      const g = \`SELECT CASE WHEN pg_input_is_valid(doc->>'amount', 'numeric(8,2)') THEN (doc->>'amount')::numeric(8,2) END\`
    `
    assert.deepEqual(findSqlSafetyViolations('lib/example.ts', safe), [])
  })

  test('rejects insufficient or bypassed CASE guards', () => {
    const unsafe = [
      // Null-check does not guard format
      "const q = `SELECT CASE WHEN col->>'n' IS NOT NULL THEN (col->>'n')::integer END`",
      // Guarded a different key than the one cast
      "const q = `SELECT CASE WHEN (col->>'a') ~ '^[0-9]+$' THEN (col->>'b')::integer END`",
      // Cast occurs in unguarded ELSE branch
      "const q = `SELECT CASE WHEN (col->>'a') ~ '^[0-9]+$' THEN 1 ELSE (col->>'a')::integer END`",
      // Cast on CASE with unguarded ELSE branch
      "const q = `SELECT (CASE WHEN col->>'id' ~* '^[0-9a-f-]+$' THEN col->>'id' ELSE col->>'fallback' END)::uuid`",
      // Guard bypassed via OR branch
      "const q = `SELECT CASE WHEN (col->>'n') ~ '^[0-9]+$' OR true THEN (col->>'n')::integer END`",
      // pg_input_is_valid checked incompatible target type
      "const q = `SELECT CASE WHEN pg_input_is_valid(col->>'n', 'text') THEN (col->>'n')::integer END`",
      "const q = `SELECT CASE WHEN pg_input_is_valid(col->>'n', 'numeric') THEN (col->>'n')::numeric(8,2) END`",
      // jsonb_typeof = 'number' allows fractions like 1.5 which crash ::integer
      "const q = `SELECT CASE WHEN jsonb_typeof(e.result->'task'->'revision')='number' THEN (e.result->'task'->>'revision')::integer END`",
      // Negated guard
      "const q = `SELECT CASE WHEN NOT pg_input_is_valid(col->>'n', 'integer') THEN (col->>'n')::integer END`",
    ]
    for (const source of unsafe) {
      const findings = findSqlSafetyViolations('lib/example.ts', source)
      assert.equal(findings.length, 1, `expected violation for bypassed guard: ${source}`)
      assert.equal(findings[0].rule, sqlSafetyRules.unguardedJsonbScalarCast, source)
    }
  })

  test('does not false-positive on safe aggregates, array index params, subqueries, comments, or test files', () => {
    const safe = `
      // Example in comment: COALESCE((m.message->>'mikkaSuperseded')::boolean, false)
      /* Block comment: (col->>'n')::int */
      const a = \`SELECT count(DISTINCT c->>'id')::int FROM t\`
      const b = \`SELECT jsonb_array_length(trigger->'webhook'->'requests')::int FROM t\`
      const c = \`SELECT (regexp_match(p."pullRequest"->>'url', '/pull/([0-9]+)'))[1]::integer FROM t\`
      const d = \`SELECT (SELECT count(*) FROM run_chunks d WHERE d.chunk->>'toolCallId'=i.chunk->>'toolCallId')::int FROM t\`
      const e = \`SELECT arr->>$1::int FROM t\`
      const f = \`SELECT COALESCE(sum(COALESCE(CASE WHEN (x->>'n') ~ '^[0-9]+$' THEN (x->>'n')::int END, 0)), 0)::int FROM t\`
      const g = \`SELECT payload->>'text' FROM coordinator_events WHERE id=$1::uuid -- (col->>'x')::boolean\`
    `
    assert.deepEqual(findSqlSafetyViolations('lib/example.ts', safe), [])

    // Files importing node:test are skipped
    const testSource = "import { test } from 'node:test'\nconst q = `SELECT (m.message->>'x')::boolean`"
    assert.deepEqual(auditSqlSafety('lib/example.ts', testSource), [])

    // Direct SQL comment stripping check
    assert.deepEqual(scanSqlForUnsafeJsonbCasts("SELECT 1 -- (m.message->>'x')::boolean\n/* (col->>'n')::int */"), [])
  })

  test('catches unsafe SQL inside template interpolation branches and string concatenation (static and dynamic)', () => {
    const ternary = "const q = `SELECT 1 ${flag ? `AND (m.message->>'bad')::boolean` : ''}`"
    const concat = "const q = 'SELECT ' + \"(m.message->>'bad')::uuid\""
    const dynRight = "const q = query + \" AND (doc->>'amount')::numeric > 0\""
    const dynLeft = "const q = \"SELECT (doc->>'amount')::numeric \" + suffix"
    const dynNested = "const q = base + (flag ? \" AND (doc->>'id')::uuid = $1\" : '') + ' LIMIT 1'"
    assert.equal(findSqlSafetyViolations('lib/a.ts', ternary).length, 1)
    assert.equal(findSqlSafetyViolations('lib/b.ts', concat).length, 1)
    assert.equal(findSqlSafetyViolations('lib/c.ts', dynRight).length, 1)
    assert.equal(findSqlSafetyViolations('lib/d.ts', dynLeft).length, 1)
    assert.equal(findSqlSafetyViolations('lib/e.ts', dynNested).length, 1)
  })
})

describe('sql-safety-policy: repository and CI gate enforcement', () => {
  test('current repository passes with zero unsafe JSONB casts', () => {
    const result = auditSqlSafetyRepository()
    assert.ok(result.files > 100, 'expected repository scan to cover production source files')
    assert.deepEqual(result.findings, [])
  })

  test('wired into package.json and source-checks CI workflow', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    const workflow = readFileSync('.github/workflows/ui-policy.yml', 'utf8')
    const sourceChecks = workflow.split('\n  source-checks:\n')[1]?.split(/\n  [a-z][a-z0-9-]+:\n/)[0] ?? ''

    assert.equal(
      pkg.scripts['check:sql-safety'],
      'node --import tsx --test lib/primitives/jsonb-predicates.test.ts && node scripts/sql-safety-policy.mjs && node --test scripts/sql-safety-policy.test.mjs',
    )
    assert.ok(pkg.scripts.check.split(' && ').includes('pnpm check:sql-safety'))
    assert.match(sourceChecks, /run: pnpm check:sql-safety/)
  })
})

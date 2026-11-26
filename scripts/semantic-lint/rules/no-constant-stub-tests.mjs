/**
 * Semantic lint rule: no-constant-stub-tests
 *
 * Scans test files for tautological constant-stub assertions where a test
 * declares a local hardcoded business/pricing/plan/model/stub constant (or
 * trivial literal-returning helper) and asserts equality directly against
 * static literal values without exercising any production module under test
 * (Issue #3342).
 */
import ts from 'typescript'

export const RULE_NAME = 'no-constant-stub-tests'

export const ALLOWLIST = Object.freeze([])

const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/

const NON_PRODUCTION_SPECIFIER_RE =
  /^(?:node:|vitest(?:\/|$)|jest(?:\/|$)|@playwright\/test(?:\/|$)|assert(?:\/|$)|fs(?:\/|$)|path(?:\/|$)|os(?:\/|$)|url(?:\/|$)|util(?:\/|$)|crypto(?:\/|$)|child_process(?:\/|$)|http(?:\/|$)|https(?:\/|$)|net(?:\/|$)|stream(?:\/|$)|events(?:\/|$)|timers(?:\/|$)|buffer(?:\/|$)|module(?:\/|$)|zod(?:\/|$)|typescript(?:\/|$))/

const TEST_RUNNER_CALLEES = new Set(['test', 'it', 'describe', 'before', 'after', 'beforeEach', 'afterEach'])

const ASSERT_EQUALITY_METHODS = new Set([
  'equal',
  'strictEqual',
  'deepEqual',
  'deepStrictEqual',
  'notEqual',
  'notStrictEqual',
  'match',
])

const EXPECT_MATCHER_METHODS = new Set([
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toContain',
  'toMatch',
  'toMatchObject',
])

const PURE_GLOBAL_OBJECTS = new Set(['Object', 'Array', 'JSON', 'Math', 'Number', 'String', 'Boolean'])

const STUB_OR_BUSINESS_WORDS = new Set([
  'expected',
  'mock',
  'fake',
  'stub',
  'dummy',
  'hardcoded',
  'price',
  'prices',
  'pricing',
  'plan',
  'plans',
  'tier',
  'tiers',
  'limit',
  'limits',
  'quota',
  'quotas',
  'catalog',
  'catalogue',
  'model',
  'models',
  'trial',
  'promo',
  'discount',
  'offer',
  'offers',
  'billing',
  'credit',
  'credits',
  'entitlement',
  'entitlements',
  'seat',
  'seats',
  'fee',
  'fees',
  'rate',
  'rates',
])

function hasStubOrBusinessWord(name) {
  if (!name) return false
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  return words.some(word => STUB_OR_BUSINESS_WORDS.has(word))
}

const BUSINESS_PROPERTY_KEY_RE =
  /^(?:price|prices|monthlyPrice|annualPrice|yearlyPrice|priceCents|amountCents|plan|planId|planName|tier|subscriptionTier|limit|quota|maxInFlight|approvalTemplateLimit|activeHumanLimit|trialDays|promoDays|discount|discountPercent|discountRate|offer|catalog|model|modelId|models|credits|seats|seatLimit)$/i

const BUSINESS_STRING_VALUE_RE =
  /(?:^\s*\$\d+(?:\.\d{1,2})?\s*$|\$\d+\.\d{2}\b|\$\d+(?:\.\d+)?\s*\/\s*(?:mo|month|yr|year|seat|user)\b|\b(?:claude-|gpt-|gemini-)[a-z0-9._-]+)/i

const PREFILTER_ASSERT_RE =
  /\b(?:assert(?:\s*\(|\s*\.\s*(?:equal|strictEqual|deepEqual|deepStrictEqual|notEqual|notStrictEqual|match|ok))|expect\s*\()/

const PREFILTER_TAINTED_VAR_RE =
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:expected|mock|fake|stub|dummy|hardcoded|price|prices|pricing|plan|plans|tier|tiers|limit|limits|quota|quotas|catalog|catalogue|model|models|trial|promo|discount|offer|offers|billing|credit|credits|entitlement|entitlements|seat|seats|fee|fees|rate|rates)[\w$]*\s*(?::[^=\n]+)?=\s*(?:['"`\d+-]|true\b|false\b|null\b|\{|\[|Object\.freeze|\([^)]*\)\s*=>|function\b)/i

const PREFILTER_TAINTED_FN_RE =
  /\bfunction\s+[A-Za-z_$][\w$]*(?:expected|mock|fake|stub|dummy|hardcoded|price|prices|pricing|plan|plans|tier|tiers|limit|limits|quota|quotas|catalog|catalogue|model|models|trial|promo|discount|offer|offers|billing|credit|credits|entitlement|entitlements|seat|seats|fee|fees|rate|rates)[\w$]*\s*\(/i

const PREFILTER_BUSINESS_PROP_RE =
  /\b(?:price|prices|monthlyPrice|annualPrice|yearlyPrice|priceCents|amountCents|plan|planId|planName|tier|subscriptionTier|limit|quota|maxInFlight|approvalTemplateLimit|activeHumanLimit|trialDays|promoDays|discount|discountPercent|discountRate|offer|catalog|credits|seats|seatLimit)\s*:\s*(?:['"`\d+-]|true\b|false\b|\{|\[)/

const PREFILTER_BUSINESS_LITERAL_RE =
  /(?:=|=>|\breturn\b|:)\s*(?:Object\.freeze\s*\(\s*)?[[{(\s]*['"`](?:[^'"`\n]*(?:\$\d+\.\d{2}\b|\$\d+(?:\.\d+)?\s*\/\s*(?:mo|month|yr|year|seat|user)\b|\b(?:claude-|gpt-|gemini-)[a-z0-9._-]+)|\s*\$\d+(?:\.\d{1,2})?\s*)['"`]/i

const EQUALITY_OPS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
])

function unwrapExpr(node) {
  let current = node
  while (current) {
    if (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isNonNullExpression(current)
    ) {
      current = current.expression
      continue
    }
    if (
      ts.isCallExpression(current)
      && current.arguments.length === 1
      && ts.isPropertyAccessExpression(current.expression)
      && ts.isIdentifier(current.expression.expression)
      && current.expression.expression.text === 'Object'
      && current.expression.name.text === 'freeze'
    ) {
      current = current.arguments[0]
      continue
    }
    break
  }
  return current
}

function getStaticString(node) {
  const expr = unwrapExpr(node)
  if (!expr) return null
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
  return null
}

function getPropertyKeyName(nameNode) {
  if (!nameNode) return null
  if (ts.isIdentifier(nameNode)) return nameNode.text
  if (ts.isStringLiteral(nameNode) || ts.isNoSubstitutionTemplateLiteral(nameNode)) return nameNode.text
  if (ts.isComputedPropertyName(nameNode)) return getStaticString(nameNode.expression)
  return null
}

function collectImportInfo(sf) {
  const productionBindings = new Set()
  const nonProductionBindings = new Set()

  const addClauseBindings = (clause, targetSet) => {
    if (!clause || clause.isTypeOnly) return
    if (clause.name) targetSet.add(clause.name.text)
    const nb = clause.namedBindings
    if (!nb) return
    if (ts.isNamespaceImport(nb)) {
      targetSet.add(nb.name.text)
    } else if (ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (!el.isTypeOnly) targetSet.add(el.name.text)
      }
    }
  }

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = getStaticString(stmt.moduleSpecifier)
      if (!spec) continue
      const isProd = !NON_PRODUCTION_SPECIFIER_RE.test(spec)
      addClauseBindings(stmt.importClause, isProd ? productionBindings : nonProductionBindings)
    }
  }

  return { productionBindings, nonProductionBindings }
}

/**
 * Evaluate whether an expression is strictly composed of literals, static local
 * bindings, property accesses on them, and calls to trivial static helpers.
 * Returns `{ isStatic, tainted, usesStaticBinding }`.
 */
function analyzeExpression(node, staticBindings, trivialHelpers, seenHelpers = new Set()) {
  const expr = unwrapExpr(node)
  if (!expr) return { isStatic: false, tainted: false, usesStaticBinding: false }

  if (
    ts.isNumericLiteral(expr)
    || ts.isBigIntLiteral(expr)
    || expr.kind === ts.SyntaxKind.TrueKeyword
    || expr.kind === ts.SyntaxKind.FalseKeyword
    || expr.kind === ts.SyntaxKind.NullKeyword
  ) {
    return { isStatic: true, tainted: false, usesStaticBinding: false }
  }

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return {
      isStatic: true,
      tainted: BUSINESS_STRING_VALUE_RE.test(expr.text),
      usesStaticBinding: false,
    }
  }

  if (ts.isTemplateExpression(expr)) {
    let tainted = BUSINESS_STRING_VALUE_RE.test(expr.head.text)
    let usesStaticBinding = false
    for (const span of expr.templateSpans) {
      const sub = analyzeExpression(span.expression, staticBindings, trivialHelpers, seenHelpers)
      if (!sub.isStatic) return { isStatic: false, tainted: false, usesStaticBinding: false }
      if (sub.tainted || BUSINESS_STRING_VALUE_RE.test(span.literal.text)) tainted = true
      if (sub.usesStaticBinding) usesStaticBinding = true
    }
    return { isStatic: true, tainted, usesStaticBinding }
  }

  if (ts.isIdentifier(expr)) {
    if (expr.text === 'undefined') return { isStatic: true, tainted: false, usesStaticBinding: false }
    const binding = staticBindings.get(expr.text)
    if (!binding) return { isStatic: false, tainted: false, usesStaticBinding: false }
    return {
      isStatic: true,
      tainted: binding.tainted || hasStubOrBusinessWord(expr.text),
      usesStaticBinding: true,
    }
  }

  if (ts.isPrefixUnaryExpression(expr)) {
    return analyzeExpression(expr.operand, staticBindings, trivialHelpers, seenHelpers)
  }

  if (ts.isBinaryExpression(expr)) {
    const left = analyzeExpression(expr.left, staticBindings, trivialHelpers, seenHelpers)
    const right = analyzeExpression(expr.right, staticBindings, trivialHelpers, seenHelpers)
    if (!left.isStatic || !right.isStatic) return { isStatic: false, tainted: false, usesStaticBinding: false }
    return {
      isStatic: true,
      tainted: left.tainted || right.tainted,
      usesStaticBinding: left.usesStaticBinding || right.usesStaticBinding,
    }
  }

  if (ts.isConditionalExpression(expr)) {
    const cond = analyzeExpression(expr.condition, staticBindings, trivialHelpers, seenHelpers)
    const whenTrue = analyzeExpression(expr.whenTrue, staticBindings, trivialHelpers, seenHelpers)
    const whenFalse = analyzeExpression(expr.whenFalse, staticBindings, trivialHelpers, seenHelpers)
    if (!cond.isStatic || !whenTrue.isStatic || !whenFalse.isStatic) {
      return { isStatic: false, tainted: false, usesStaticBinding: false }
    }
    return {
      isStatic: true,
      tainted: cond.tainted || whenTrue.tainted || whenFalse.tainted,
      usesStaticBinding: cond.usesStaticBinding || whenTrue.usesStaticBinding || whenFalse.usesStaticBinding,
    }
  }

  if (ts.isArrayLiteralExpression(expr)) {
    let tainted = false
    let usesStaticBinding = false
    for (const el of expr.elements) {
      const target = ts.isSpreadElement(el) ? el.expression : el
      const sub = analyzeExpression(target, staticBindings, trivialHelpers, seenHelpers)
      if (!sub.isStatic) return { isStatic: false, tainted: false, usesStaticBinding: false }
      if (sub.tainted) tainted = true
      if (sub.usesStaticBinding) usesStaticBinding = true
    }
    return { isStatic: true, tainted, usesStaticBinding }
  }

  if (ts.isObjectLiteralExpression(expr)) {
    let tainted = false
    let usesStaticBinding = false
    for (const prop of expr.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const key = getPropertyKeyName(prop.name)
        if (key && BUSINESS_PROPERTY_KEY_RE.test(key)) tainted = true
        const sub = analyzeExpression(prop.initializer, staticBindings, trivialHelpers, seenHelpers)
        if (!sub.isStatic) return { isStatic: false, tainted: false, usesStaticBinding: false }
        if (sub.tainted) tainted = true
        if (sub.usesStaticBinding) usesStaticBinding = true
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        if (BUSINESS_PROPERTY_KEY_RE.test(prop.name.text)) tainted = true
        const sub = analyzeExpression(prop.name, staticBindings, trivialHelpers, seenHelpers)
        if (!sub.isStatic) return { isStatic: false, tainted: false, usesStaticBinding: false }
        if (sub.tainted) tainted = true
        if (sub.usesStaticBinding) usesStaticBinding = true
      } else if (ts.isSpreadAssignment(prop)) {
        const sub = analyzeExpression(prop.expression, staticBindings, trivialHelpers, seenHelpers)
        if (!sub.isStatic) return { isStatic: false, tainted: false, usesStaticBinding: false }
        if (sub.tainted) tainted = true
        if (sub.usesStaticBinding) usesStaticBinding = true
      } else {
        return { isStatic: false, tainted: false, usesStaticBinding: false }
      }
    }
    return { isStatic: true, tainted, usesStaticBinding }
  }

  if (ts.isPropertyAccessExpression(expr)) {
    const obj = analyzeExpression(expr.expression, staticBindings, trivialHelpers, seenHelpers)
    if (!obj.isStatic) return { isStatic: false, tainted: false, usesStaticBinding: false }
    const propTainted = BUSINESS_PROPERTY_KEY_RE.test(expr.name.text)
    return {
      isStatic: true,
      tainted: obj.tainted || propTainted,
      usesStaticBinding: obj.usesStaticBinding,
    }
  }

  if (ts.isElementAccessExpression(expr)) {
    const obj = analyzeExpression(expr.expression, staticBindings, trivialHelpers, seenHelpers)
    const arg = analyzeExpression(expr.argumentExpression, staticBindings, trivialHelpers, seenHelpers)
    if (!obj.isStatic || !arg.isStatic) return { isStatic: false, tainted: false, usesStaticBinding: false }
    return {
      isStatic: true,
      tainted: obj.tainted || arg.tainted,
      usesStaticBinding: obj.usesStaticBinding || arg.usesStaticBinding,
    }
  }

  if (ts.isCallExpression(expr)) {
    const callee = unwrapExpr(expr.expression)
    if (callee && ts.isIdentifier(callee) && trivialHelpers.has(callee.text) && !seenHelpers.has(callee.text)) {
      const helper = trivialHelpers.get(callee.text)
      for (const arg of expr.arguments) {
        const sub = analyzeExpression(arg, staticBindings, trivialHelpers, seenHelpers)
        if (!sub.isStatic) return { isStatic: false, tainted: false, usesStaticBinding: false }
      }
      return {
        isStatic: true,
        tainted: helper.tainted || hasStubOrBusinessWord(callee.text),
        usesStaticBinding: true,
      }
    }
  }

  return { isStatic: false, tainted: false, usesStaticBinding: false }
}

/**
 * Determine whether a local function/arrow returns only a static expression
 * without performing side effects or calling non-trivial functions.
 */
function analyzeTrivialHelper(fnNode, name, staticBindings, trivialHelpers) {
  if (!fnNode || fnNode.parameters.length > 0) {
    // Allow zero-arg or ignored-arg stub helpers only if body does not depend on parameters.
    if (!fnNode) return null
  }
  const paramNames = new Set()
  for (const param of fnNode.parameters) {
    if (ts.isIdentifier(param.name)) paramNames.add(param.name.text)
  }

  let returnExpr = null
  if (ts.isArrowFunction(fnNode) && !ts.isBlock(fnNode.body)) {
    returnExpr = fnNode.body
  } else if (fnNode.body && ts.isBlock(fnNode.body)) {
    const stmts = fnNode.body.statements
    if (stmts.length !== 1 || !ts.isReturnStatement(stmts[0]) || !stmts[0].expression) {
      return null
    }
    returnExpr = stmts[0].expression
  } else {
    return null
  }

  // If the return expression references any parameter, it's transforming input, not returning a constant stub.
  let usesParam = false
  const checkParams = (n, parent) => {
    if (ts.isIdentifier(n) && paramNames.has(n.text)) {
      // Skip property access name position (e.g., obj.paramName)
      if (!(parent && ts.isPropertyAccessExpression(parent) && parent.name === n)) {
        usesParam = true
      }
    }
    ts.forEachChild(n, child => checkParams(child, n))
  }
  if (paramNames.size > 0) checkParams(returnExpr, fnNode)
  if (usesParam) return null

  const analyzed = analyzeExpression(returnExpr, staticBindings, trivialHelpers, new Set([name]))
  if (!analyzed.isStatic) return null
  return {
    tainted: analyzed.tainted || hasStubOrBusinessWord(name),
  }
}

function registerBindingPattern(nameNode, analyzed, staticBindings) {
  if (ts.isIdentifier(nameNode)) {
    staticBindings.set(nameNode.text, {
      tainted: analyzed.tainted || hasStubOrBusinessWord(nameNode.text),
    })
  } else if (ts.isObjectBindingPattern(nameNode)) {
    for (const el of nameNode.elements) {
      const propKey = el.propertyName ? getPropertyKeyName(el.propertyName) : null
      const propTainted = Boolean(propKey && BUSINESS_PROPERTY_KEY_RE.test(propKey))
      registerBindingPattern(
        el.name,
        { isStatic: true, tainted: analyzed.tainted || propTainted },
        staticBindings,
      )
    }
  } else if (ts.isArrayBindingPattern(nameNode)) {
    for (const el of nameNode.elements) {
      if (ts.isBindingElement(el)) {
        registerBindingPattern(el.name, analyzed, staticBindings)
      }
    }
  }
}

function collectScopeBindings(statements, baseStaticBindings, baseTrivialHelpers) {
  const staticBindings = new Map(baseStaticBindings)
  const trivialHelpers = new Map(baseTrivialHelpers)

  // Two passes allow local helper declarations to reference constants declared below/above.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const stmt of statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        const helper = analyzeTrivialHelper(stmt, stmt.name.text, staticBindings, trivialHelpers)
        if (helper) trivialHelpers.set(stmt.name.text, helper)
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!decl.initializer) continue
          const init = unwrapExpr(decl.initializer)
          if (
            ts.isIdentifier(decl.name)
            && init
            && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
          ) {
            const helper = analyzeTrivialHelper(init, decl.name.text, staticBindings, trivialHelpers)
            if (helper) trivialHelpers.set(decl.name.text, helper)
            continue
          }
          const analyzed = analyzeExpression(decl.initializer, staticBindings, trivialHelpers)
          if (analyzed.isStatic) {
            registerBindingPattern(decl.name, analyzed, staticBindings)
          }
        }
      }
    }
  }

  return { staticBindings, trivialHelpers }
}

function isAssertOrExpectCall(node) {
  if (!ts.isCallExpression(node)) return false
  const callee = unwrapExpr(node.expression)
  if (!callee) return false

  if (ts.isIdentifier(callee) && (callee.text === 'assert' || callee.text === 'expect')) {
    return true
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const obj = unwrapExpr(callee.expression)
    if (obj && ts.isIdentifier(obj) && obj.text === 'assert') return true
    if (
      obj
      && ts.isCallExpression(obj)
      && ts.isIdentifier(obj.expression)
      && obj.expression.text === 'expect'
    ) {
      return true
    }
    if (
      obj
      && ts.isPropertyAccessExpression(obj)
      && obj.name.text === 'not'
      && ts.isCallExpression(obj.expression)
      && ts.isIdentifier(obj.expression.expression)
      && obj.expression.expression.text === 'expect'
    ) {
      return true
    }
  }
  return false
}

function extractAssertionPair(node) {
  if (!ts.isCallExpression(node)) return null
  const callee = unwrapExpr(node.expression)
  if (!callee) return null

  // assert.equal(a, b), assert.strictEqual(a, b), assert.deepEqual(a, b), ...
  if (
    ts.isPropertyAccessExpression(callee)
    && ts.isIdentifier(callee.expression)
    && callee.expression.text === 'assert'
  ) {
    const method = callee.name.text
    if (ASSERT_EQUALITY_METHODS.has(method) && node.arguments.length >= 2) {
      return { left: node.arguments[0], right: node.arguments[1] }
    }
    if (method === 'ok' && node.arguments.length >= 1) {
      const arg = unwrapExpr(node.arguments[0])
      if (arg && ts.isBinaryExpression(arg) && EQUALITY_OPS.has(arg.operatorToken.kind)) {
        return { left: arg.left, right: arg.right }
      }
    }
  }

  // assert(a === b)
  if (ts.isIdentifier(callee) && callee.text === 'assert' && node.arguments.length >= 1) {
    const arg = unwrapExpr(node.arguments[0])
    if (arg && ts.isBinaryExpression(arg) && EQUALITY_OPS.has(arg.operatorToken.kind)) {
      return { left: arg.left, right: arg.right }
    }
  }

  // expect(a).toBe(b), expect(a).toEqual(b), expect(a).not.toBe(b)
  if (ts.isPropertyAccessExpression(callee) && EXPECT_MATCHER_METHODS.has(callee.name.text) && node.arguments.length >= 1) {
    let target = unwrapExpr(callee.expression)
    if (target && ts.isPropertyAccessExpression(target) && target.name.text === 'not') {
      target = unwrapExpr(target.expression)
    }
    if (
      target
      && ts.isCallExpression(target)
      && ts.isIdentifier(target.expression)
      && target.expression.text === 'expect'
      && target.arguments.length >= 1
    ) {
      return { left: target.arguments[0], right: node.arguments[0] }
    }
  }

  return null
}

function blockExercisesRealCode(bodyNode, productionBindings, trivialHelpers) {
  let exercisesReal = false

  const visit = (node, parent) => {
    if (exercisesReal) return

    // Dynamic import() or require()
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        exercisesReal = true
        return
      }
      const callee = unwrapExpr(node.expression)
      if (callee && ts.isIdentifier(callee)) {
        const name = callee.text
        if (name === 'require') {
          exercisesReal = true
          return
        }
        if (productionBindings.has(name)) {
          exercisesReal = true
          return
        }
        if (
          !isAssertOrExpectCall(node)
          && !TEST_RUNNER_CALLEES.has(name)
          && !trivialHelpers.has(name)
          && !PURE_GLOBAL_OBJECTS.has(name)
        ) {
          // Non-trivial function call (e.g. fetch, helper wrapping production code, etc.)
          exercisesReal = true
          return
        }
      } else if (callee && ts.isPropertyAccessExpression(callee)) {
        if (!isAssertOrExpectCall(node)) {
          const root = unwrapExpr(callee.expression)
          const isTestRunnerMethod = root && ts.isIdentifier(root) && TEST_RUNNER_CALLEES.has(root.text)
          const isPureGlobalMethod = root && ts.isIdentifier(root) && PURE_GLOBAL_OBJECTS.has(root.text)
          if (!isTestRunnerMethod && !isPureGlobalMethod) {
            exercisesReal = true
            return
          }
        }
      } else if (callee) {
        exercisesReal = true
        return
      }
    }

    if (ts.isNewExpression(node)) {
      const callee = unwrapExpr(node.expression)
      if (!callee || !ts.isIdentifier(callee) || !new Set(['Set', 'Map', 'Date', 'RegExp', 'URL']).has(callee.text)) {
        exercisesReal = true
        return
      }
    }

    if (ts.isIdentifier(node) && productionBindings.has(node.text)) {
      if (!(parent && ts.isPropertyAccessExpression(parent) && parent.name === node)) {
        exercisesReal = true
        return
      }
    }

    ts.forEachChild(node, child => visit(child, node))
  }

  visit(bodyNode, null)
  return exercisesReal
}

function getTestBlockCallback(node) {
  if (!ts.isCallExpression(node)) return null
  const callee = unwrapExpr(node.expression)
  if (!callee) return null

  let isTestCall = false
  if (ts.isIdentifier(callee) && (callee.text === 'test' || callee.text === 'it')) {
    isTestCall = true
  } else if (
    ts.isPropertyAccessExpression(callee)
    && ts.isIdentifier(callee.expression)
    && (callee.expression.text === 'test' || callee.expression.text === 'it')
    && (callee.name.text === 'only' || callee.name.text === 'todo' || callee.name.text === 'skip')
  ) {
    isTestCall = true
  }

  if (!isTestCall) return null
  for (let i = node.arguments.length - 1; i >= 0; i -= 1) {
    const arg = unwrapExpr(node.arguments[i])
    if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
      return arg
    }
  }
  return null
}

function inspectAssertionsInNode(rootNode, staticBindings, trivialHelpers, report) {
  const visit = node => {
    const pair = extractAssertionPair(node)
    if (pair) {
      const left = analyzeExpression(pair.left, staticBindings, trivialHelpers)
      const right = analyzeExpression(pair.right, staticBindings, trivialHelpers)
      if (
        left.isStatic
        && right.isStatic
        && (left.tainted || right.tainted)
        && (left.usesStaticBinding || right.usesStaticBinding)
      ) {
        report(
          node,
          'Constant-stub test assertion compares hardcoded local stub constants against static literals without calling any production module under test; import and exercise real production code instead.',
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(rootNode)
}

export const noConstantStubTestsRule = Object.freeze({
  name: RULE_NAME,
  description:
    'Disallow constant-stub tests that assert hardcoded local business/pricing/plan/model constants against literals or trivial stub helpers without exercising any production module.',
  allowlist: ALLOWLIST,
  matchesFile(relPath) {
    return TEST_FILE_RE.test(relPath)
  },
  mightMatch(source) {
    return (
      PREFILTER_ASSERT_RE.test(source)
      && (
        PREFILTER_TAINTED_VAR_RE.test(source)
        || PREFILTER_TAINTED_FN_RE.test(source)
        || PREFILTER_BUSINESS_PROP_RE.test(source)
        || PREFILTER_BUSINESS_LITERAL_RE.test(source)
      )
    )
  },
  check(ctx) {
    if (!TEST_FILE_RE.test(ctx.relPath)) return
    const sf = ctx.getSourceFile()
    const { productionBindings } = collectImportInfo(sf)
    const topLevel = collectScopeBindings(sf.statements, new Map(), new Map())

    let foundTestBlock = false
    const visit = node => {
      const callback = getTestBlockCallback(node)
      if (callback) {
        foundTestBlock = true
        const stmts = ts.isBlock(callback.body) ? callback.body.statements : []
        const scoped = collectScopeBindings(stmts, topLevel.staticBindings, topLevel.trivialHelpers)
        if (!blockExercisesRealCode(callback.body, productionBindings, scoped.trivialHelpers)) {
          inspectAssertionsInNode(callback.body, scoped.staticBindings, scoped.trivialHelpers, ctx.report)
        }
        return
      }
      ts.forEachChild(node, visit)
    }

    visit(sf)

    // Also inspect top-level bare test scripts that do not wrap assertions in test()/it()
    if (!foundTestBlock && !blockExercisesRealCode(sf, productionBindings, topLevel.trivialHelpers)) {
      inspectAssertionsInNode(sf, topLevel.staticBindings, topLevel.trivialHelpers, ctx.report)
    }
  },
})

export default noConstantStubTestsRule

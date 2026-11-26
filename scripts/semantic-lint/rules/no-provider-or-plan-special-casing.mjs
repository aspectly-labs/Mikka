/**
 * Semantic lint rule: no-provider-or-plan-special-casing
 *
 * Flags scattered AI model provider comparisons/switches and plan-tier
 * special-casing (including tier/plan-alias identifiers that evade G3) outside
 * provider adapters, model catalog/gateway, OAuth/credential/subscription
 * adapters, billing, and governance policy modules (Issue #3342).
 */
import ts from 'typescript'

export const RULE_NAME = 'no-provider-or-plan-special-casing'

export const ALLOWLIST = Object.freeze([
  'lib/model-catalog*.ts',
  'lib/model-gateway/**',
  'lib/model-api-key*.ts',
  'lib/model-routing.ts',
  'lib/model-order.ts',
  'lib/run-credential-source.ts',
  'lib/chat-attachments/transcribe.ts',
  'lib/subscription-*.ts',
  'lib/credentials/**',
  'lib/plugins/**',
  'lib/operations/**',
  'lib/auth*.ts',
  'lib/google-link.ts',
  'lib/eve/factory/providers.ts',
  'lib/governance/policy.ts',
  'lib/governance/capabilities.ts',
  'lib/governance/provisioning.ts',
  'lib/enterprise/provisioning.ts',
  'lib/billing/**',
  'packages/protocol/src/subscription.ts',
  'apps/desktop/src/main/bundled-auth.ts',
  'tests/**',
  '**/test/**',
  '**/tests/**',
  '**/fixtures/**',
  '**/*.test.*',
  '**/*.db.test.*',
  '**/*.spec.*',
  '**/*.fixture.*',
  '**/*.bench.*',
  '**/testing/**',
])

export const PROVIDER_LITERALS = Object.freeze([
  'openai',
  'anthropic',
  'google',
  'vertex',
  'bedrock',
  'gemini',
  'xai',
  'deepseek',
  'mistral',
  'cohere',
  'groq',
  'openrouter',
  'together',
  'fireworks',
  'azure',
  'perplexity',
  'moonshot',
  'kimi',
  'qwen',
  'zhipu',
  'minimax',
])

export const PLAN_TIER_LITERALS = Object.freeze([
  'free',
  'pro',
  'enterprise',
  'starter',
  'max',
  'team_free',
  'team_pro',
  'business',
  'hobby',
  'scale',
])

const PROVIDER_LITERAL_SET = new Set(PROVIDER_LITERALS)
const PLAN_TIER_LITERAL_SET = new Set(PLAN_TIER_LITERALS)

const PROVIDER_IDENTIFIER_RE =
  /^(?:provider|vendor|modelProvider|aiProvider|llmProvider|upstreamProvider|modelVendor|providerId|providerName|providerKey|providerSlug|providerType|[a-z][A-Za-z0-9]*(?:Provider|Vendor|ProviderId|ProviderName|ProviderKey|ProviderSlug|ProviderType)|[a-z0-9_]+_(?:provider|vendor|provider_id|provider_name))$/

const PLAN_TIER_IDENTIFIER_RE =
  /^(?:tier|subscriptionTier|planTier|billingTier|accountTier|workspaceTier|orgTier|customerTier|pricingTier|membershipTier|planSlug|planCode|planType|subscriptionPlan|planLevel|tariff|plan|entitlementPlan|billingPlan|workspacePlan|currentPlan|orgPlan|planId|planName|[a-z0-9_]+_(?:tier|plan|plan_id|plan_name|plan_slug|plan_code))$/i

const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
])

const STRING_NORM_METHODS = new Set([
  'toLowerCase',
  'toUpperCase',
  'trim',
  'trimStart',
  'trimEnd',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
])

const PREFILTER_STEM =
  '(?:openai|anthropic|google|vertex|bedrock|gemini|xai|deepseek|mistral|cohere|groq|openrouter|together|fireworks|azure|perplexity|moonshot|kimi|qwen|zhipu|minimax|free|pro|enterprise|starter|max|team_free|team_pro|business|hobby|scale)'

const PREFILTER_QUOTED_RE = new RegExp(`['"\`]${PREFILTER_STEM}['"\`]`, 'i')
const PREFILTER_OBJ_KEY_RE = new RegExp(
  `(?<![.\\w$])${PREFILTER_STEM}\\s*(?::|[,}]|\\([^)]*\\)\\s*(?::[^{;]+)?\\{|\\/[/*])`,
  'i',
)

const PREFILTER_RE = {
  test(source) {
    return PREFILTER_QUOTED_RE.test(source) || (source.includes('{') && PREFILTER_OBJ_KEY_RE.test(source))
  },
}

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

function unwrapNormalizedStringExpr(node) {
  let current = unwrapExpr(node)
  while (current) {
    if (
      ts.isCallExpression(current)
      && current.arguments.length === 0
      && ts.isPropertyAccessExpression(current.expression)
      && STRING_NORM_METHODS.has(current.expression.name.text)
    ) {
      current = unwrapExpr(current.expression.expression)
      continue
    }
    break
  }
  return current
}

function getStaticString(node) {
  const expr = unwrapExpr(node)
  if (!expr) return null
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text
  }
  return null
}

function getPropertyKeyName(nameNode) {
  if (!nameNode) return null
  if (ts.isIdentifier(nameNode)) return nameNode.text
  if (ts.isStringLiteral(nameNode) || ts.isNoSubstitutionTemplateLiteral(nameNode)) return nameNode.text
  if (ts.isComputedPropertyName(nameNode)) return getStaticString(nameNode.expression)
  return null
}

function matchesIdentifierPattern(node, pattern) {
  const expr = unwrapNormalizedStringExpr(node)
  if (!expr) return false
  if (ts.isIdentifier(expr)) return pattern.test(expr.text)
  if (ts.isPropertyAccessExpression(expr)) return pattern.test(expr.name.text)
  if (ts.isElementAccessExpression(expr)) {
    const key = getStaticString(expr.argumentExpression)
    return key !== null && pattern.test(key)
  }
  if (
    ts.isBinaryExpression(expr)
    && (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return matchesIdentifierPattern(expr.left, pattern)
  }
  return false
}

function isProviderReference(node) {
  return matchesIdentifierPattern(node, PROVIDER_IDENTIFIER_RE)
}

function isPlanTierReference(node) {
  return matchesIdentifierPattern(node, PLAN_TIER_IDENTIFIER_RE)
}

function getLiteralInSet(node, set) {
  const value = getStaticString(node)
  return value !== null && set.has(value) ? value : null
}

function arrayContainsLiteralInSet(node, set) {
  const expr = unwrapExpr(node)
  if (!expr || !ts.isArrayLiteralExpression(expr)) return false
  return expr.elements.some(el => !ts.isSpreadElement(el) && getLiteralInSet(el, set) !== null)
}

const EMPTY_BINDING = Object.freeze({
  providerArray: false,
  providerSet: false,
  providerObject: false,
  tierArray: false,
  tierSet: false,
  tierObject: false,
})

function isLiteralSetExpression(node, set) {
  const expr = unwrapExpr(node)
  if (!expr || !ts.isNewExpression(expr)) return false
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== 'Set') return false
  const args = expr.arguments ?? []
  return args.length >= 1 && arrayContainsLiteralInSet(args[0], set)
}

function isObjectWithMinKeys(node, set, minKeys = 2) {
  const expr = unwrapExpr(node)
  if (!expr || !ts.isObjectLiteralExpression(expr)) return false
  const matched = new Set()
  for (const prop of expr.properties) {
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) {
      const key = getPropertyKeyName(prop.name)
      if (key !== null && set.has(key)) matched.add(key)
    }
  }
  return matched.size >= minKeys
}

function classifyInitializer(init) {
  if (!init) return EMPTY_BINDING
  const providerArray = arrayContainsLiteralInSet(init, PROVIDER_LITERAL_SET)
  const providerSet = isLiteralSetExpression(init, PROVIDER_LITERAL_SET)
  const providerObject = isObjectWithMinKeys(init, PROVIDER_LITERAL_SET, 2)
  const tierArray = arrayContainsLiteralInSet(init, PLAN_TIER_LITERAL_SET)
  const tierSet = isLiteralSetExpression(init, PLAN_TIER_LITERAL_SET)
  const tierObject = isObjectWithMinKeys(init, PLAN_TIER_LITERAL_SET, 2)
  if (!providerArray && !providerSet && !providerObject && !tierArray && !tierSet && !tierObject) {
    return EMPTY_BINDING
  }
  return { providerArray, providerSet, providerObject, tierArray, tierSet, tierObject }
}

function collectBindingNames(nameNode, out = []) {
  if (!nameNode) return out
  if (ts.isIdentifier(nameNode)) {
    out.push(nameNode.text)
  } else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const el of nameNode.elements) {
      if (ts.isBindingElement(el)) collectBindingNames(el.name, out)
    }
  }
  return out
}

function isFunctionLikeNode(node) {
  return (
    ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node)
  )
}

function isBlockScopedVarList(declList) {
  return Boolean(declList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using))
}

function recordDeclarationList(declList, scope) {
  for (const decl of declList.declarations) {
    if (ts.isIdentifier(decl.name)) {
      scope.set(decl.name.text, classifyInitializer(decl.initializer))
    } else {
      for (const name of collectBindingNames(decl.name)) {
        scope.set(name, EMPTY_BINDING)
      }
    }
  }
}

function populateHoistedVars(rootNode, targetScope) {
  const walk = node => {
    if (node !== rootNode && isFunctionLikeNode(node)) return
    if (ts.isVariableDeclarationList(node) && !isBlockScopedVarList(node)) {
      recordDeclarationList(node, targetScope)
    }
    ts.forEachChild(node, walk)
  }
  walk(rootNode)
}

function populateStatementScope(statements, scope) {
  for (const stmt of statements) {
    if (ts.isVariableStatement(stmt)) {
      if (isBlockScopedVarList(stmt.declarationList)) {
        recordDeclarationList(stmt.declarationList, scope)
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      scope.set(stmt.name.text, EMPTY_BINDING)
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      scope.set(stmt.name.text, EMPTY_BINDING)
    } else if (ts.isImportDeclaration(stmt) && stmt.importClause && !stmt.importClause.isTypeOnly) {
      const clause = stmt.importClause
      if (clause.name) scope.set(clause.name.text, EMPTY_BINDING)
      const nb = clause.namedBindings
      if (nb && ts.isNamespaceImport(nb)) {
        scope.set(nb.name.text, EMPTY_BINDING)
      } else if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          if (!el.isTypeOnly) scope.set(el.name.text, EMPTY_BINDING)
        }
      }
    }
  }
}

function resolveBinding(scopeStack, name) {
  for (let i = scopeStack.length - 1; i >= 0; i -= 1) {
    if (scopeStack[i].has(name)) return scopeStack[i].get(name)
  }
  return EMPTY_BINDING
}

export const noProviderOrPlanSpecialCasingRule = Object.freeze({
  name: RULE_NAME,
  description:
    'Disallow scattered AI provider or plan-tier special-casing outside provider adapters, model catalog/gateway, billing, and governance policy modules.',
  allowlist: ALLOWLIST,
  mightMatch(source) {
    return PREFILTER_RE.test(source)
  },
  check(ctx) {
    const sf = ctx.getSourceFile()
    const scopeStack = []

    const visitChildren = node => {
      ts.forEachChild(node, visit)
    }

    const withScope = (scope, fn) => {
      scopeStack.push(scope)
      try {
        fn()
      } finally {
        scopeStack.pop()
      }
    }

    const inspectNode = node => {
      // 1. Binary equality comparisons: provider === 'openai', tier === 'pro'
      if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
        const leftIsProvider = isProviderReference(node.left)
        const rightIsProvider = isProviderReference(node.right)
        const matchedProvider = leftIsProvider
          ? getLiteralInSet(node.right, PROVIDER_LITERAL_SET)
          : rightIsProvider
            ? getLiteralInSet(node.left, PROVIDER_LITERAL_SET)
            : null
        if (matchedProvider !== null) {
          ctx.report(
            node,
            `Avoid scattered provider special-casing for "${matchedProvider}"; encapsulate provider differences inside a model gateway, catalog, or provider adapter module.`,
          )
        } else {
          const leftIsTier = isPlanTierReference(node.left)
          const rightIsTier = isPlanTierReference(node.right)
          const matchedTier = leftIsTier
            ? getLiteralInSet(node.right, PLAN_TIER_LITERAL_SET)
            : rightIsTier
              ? getLiteralInSet(node.left, PLAN_TIER_LITERAL_SET)
              : null
          if (matchedTier !== null) {
            ctx.report(
              node,
              `Avoid plan-tier special-casing for "${matchedTier}"; check declarative workspace capabilities from lib/governance/capabilities.ts instead.`,
            )
          }
        }
      }

      // 2. Switch statements on provider or plan-tier
      if (ts.isSwitchStatement(node)) {
        const providerCases = []
        const tierCases = []
        for (const clause of node.caseBlock.clauses) {
          if (!ts.isCaseClause(clause)) continue
          const prov = getLiteralInSet(clause.expression, PROVIDER_LITERAL_SET)
          if (prov !== null) providerCases.push({ clause, literal: prov })
          const tier = getLiteralInSet(clause.expression, PLAN_TIER_LITERAL_SET)
          if (tier !== null) tierCases.push({ clause, literal: tier })
        }

        if (providerCases.length >= 2 || (isProviderReference(node.expression) && providerCases.length >= 1)) {
          for (const item of providerCases) {
            ctx.report(
              item.clause,
              `Avoid switching on provider literal "${item.literal}"; delegate provider behavior to a dedicated adapter or model gateway module.`,
            )
          }
        } else if (isPlanTierReference(node.expression) && tierCases.length >= 1) {
          for (const item of tierCases) {
            ctx.report(
              item.clause,
              `Avoid switching on plan-tier literal "${item.literal}"; check declarative workspace capabilities from lib/governance/capabilities.ts instead.`,
            )
          }
        }
      }

      // 3. Array.includes(provider|tier) and Set.has(provider|tier)
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.arguments.length >= 1
      ) {
        const method = node.expression.name.text
        const target = unwrapExpr(node.expression.expression)
        const arg = node.arguments[0]

        if (isProviderReference(arg)) {
          if (method === 'includes') {
            const isMatch =
              arrayContainsLiteralInSet(target, PROVIDER_LITERAL_SET)
              || (target && ts.isIdentifier(target) && resolveBinding(scopeStack, target.text).providerArray)
            if (isMatch) {
              ctx.report(
                node,
                'Avoid branching on provider arrays with .includes(); encapsulate provider capabilities inside a provider adapter or model catalog.',
              )
            }
          } else if (method === 'has') {
            const isMatch =
              isLiteralSetExpression(target, PROVIDER_LITERAL_SET)
              || (target && ts.isIdentifier(target) && resolveBinding(scopeStack, target.text).providerSet)
            if (isMatch) {
              ctx.report(
                node,
                'Avoid branching on provider sets with .has(); encapsulate provider capabilities inside a provider adapter or model catalog.',
              )
            }
          }
        } else if (isPlanTierReference(arg)) {
          if (method === 'includes') {
            const isMatch =
              arrayContainsLiteralInSet(target, PLAN_TIER_LITERAL_SET)
              || (target && ts.isIdentifier(target) && resolveBinding(scopeStack, target.text).tierArray)
            if (isMatch) {
              ctx.report(
                node,
                'Avoid branching on plan-tier arrays with .includes(); check declarative workspace capabilities from lib/governance/capabilities.ts instead.',
              )
            }
          } else if (method === 'has') {
            const isMatch =
              isLiteralSetExpression(target, PLAN_TIER_LITERAL_SET)
              || (target && ts.isIdentifier(target) && resolveBinding(scopeStack, target.text).tierSet)
            if (isMatch) {
              ctx.report(
                node,
                'Avoid branching on plan-tier sets with .has(); check declarative workspace capabilities from lib/governance/capabilities.ts instead.',
              )
            }
          }
        }
      }

      // 4. Provider-keyed or plan-tier-keyed computed object lookup
      if (ts.isElementAccessExpression(node)) {
        const target = unwrapExpr(node.expression)
        const keyExpr = node.argumentExpression
        if (isProviderReference(keyExpr)) {
          const isMatch =
            isObjectWithMinKeys(target, PROVIDER_LITERAL_SET, 2)
            || (target && ts.isIdentifier(target) && resolveBinding(scopeStack, target.text).providerObject)
          if (isMatch) {
            ctx.report(
              node,
              'Avoid provider-keyed object lookup outside adapters; read provider configuration from a dedicated adapter or model catalog.',
            )
          }
        } else if (isPlanTierReference(keyExpr)) {
          const isMatch =
            isObjectWithMinKeys(target, PLAN_TIER_LITERAL_SET, 2)
            || (target && ts.isIdentifier(target) && resolveBinding(scopeStack, target.text).tierObject)
          if (isMatch) {
            ctx.report(
              node,
              'Avoid plan-tier-keyed object lookup; read explicit limits or capabilities from lib/governance/capabilities.ts instead.',
            )
          }
        }
      }
    }

    const visit = node => {
      if (ts.isSourceFile(node)) {
        const scope = new Map()
        populateHoistedVars(node, scope)
        populateStatementScope(node.statements, scope)
        withScope(scope, () => visitChildren(node))
        return
      }

      if (isFunctionLikeNode(node)) {
        const scope = new Map()
        if (ts.isFunctionExpression(node) && node.name) {
          scope.set(node.name.text, EMPTY_BINDING)
        }
        for (const param of node.parameters) {
          for (const name of collectBindingNames(param.name)) {
            scope.set(name, EMPTY_BINDING)
          }
        }
        if (node.body) {
          populateHoistedVars(node.body, scope)
        }
        withScope(scope, () => {
          inspectNode(node)
          visitChildren(node)
        })
        return
      }

      if (ts.isBlock(node) || ts.isModuleBlock(node)) {
        const scope = new Map()
        populateStatementScope(node.statements, scope)
        withScope(scope, () => {
          inspectNode(node)
          visitChildren(node)
        })
        return
      }

      if (ts.isCaseBlock(node)) {
        const scope = new Map()
        for (const clause of node.clauses) {
          populateStatementScope(clause.statements, scope)
        }
        withScope(scope, () => {
          inspectNode(node)
          visitChildren(node)
        })
        return
      }

      if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
        const scope = new Map()
        if (node.initializer && ts.isVariableDeclarationList(node.initializer) && isBlockScopedVarList(node.initializer)) {
          recordDeclarationList(node.initializer, scope)
        }
        withScope(scope, () => {
          inspectNode(node)
          visitChildren(node)
        })
        return
      }

      if (ts.isCatchClause(node)) {
        const scope = new Map()
        if (node.variableDeclaration) {
          for (const name of collectBindingNames(node.variableDeclaration.name)) {
            scope.set(name, EMPTY_BINDING)
          }
        }
        withScope(scope, () => {
          inspectNode(node)
          visitChildren(node)
        })
        return
      }

      inspectNode(node)
      visitChildren(node)
    }

    visit(sf)
  },
})

export default noProviderOrPlanSpecialCasingRule

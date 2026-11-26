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

function arrayHasOnlyLiteralsInSet(node, set) {
  const expr = unwrapExpr(node)
  if (!expr || !ts.isArrayLiteralExpression(expr) || expr.elements.length === 0) return false
  return expr.elements.every(el => !ts.isSpreadElement(el) && getLiteralInSet(el, set) !== null)
}

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
    const providerArrayVars = new Set()
    const providerSetVars = new Set()
    const providerObjectVars = new Set()
    const tierArrayVars = new Set()
    const tierSetVars = new Set()
    const tierObjectVars = new Set()
    const deferredChecks = []

    const visit = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (arrayHasOnlyLiteralsInSet(node.initializer, PROVIDER_LITERAL_SET)) providerArrayVars.add(node.name.text)
        if (isLiteralSetExpression(node.initializer, PROVIDER_LITERAL_SET)) providerSetVars.add(node.name.text)
        if (isObjectWithMinKeys(node.initializer, PROVIDER_LITERAL_SET, 2)) providerObjectVars.add(node.name.text)

        if (arrayHasOnlyLiteralsInSet(node.initializer, PLAN_TIER_LITERAL_SET)) tierArrayVars.add(node.name.text)
        if (isLiteralSetExpression(node.initializer, PLAN_TIER_LITERAL_SET)) tierSetVars.add(node.name.text)
        if (isObjectWithMinKeys(node.initializer, PLAN_TIER_LITERAL_SET, 2)) tierObjectVars.add(node.name.text)
      }

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
            if (arrayContainsLiteralInSet(target, PROVIDER_LITERAL_SET)) {
              ctx.report(
                node,
                'Avoid branching on provider arrays with .includes(); encapsulate provider capabilities inside a provider adapter or model catalog.',
              )
            } else if (target && ts.isIdentifier(target)) {
              deferredChecks.push({
                kind: 'providerArray',
                name: target.text,
                node,
                message:
                  'Avoid branching on provider arrays with .includes(); encapsulate provider capabilities inside a provider adapter or model catalog.',
              })
            }
          } else if (method === 'has') {
            if (isLiteralSetExpression(target, PROVIDER_LITERAL_SET)) {
              ctx.report(
                node,
                'Avoid branching on provider sets with .has(); encapsulate provider capabilities inside a provider adapter or model catalog.',
              )
            } else if (target && ts.isIdentifier(target)) {
              deferredChecks.push({
                kind: 'providerSet',
                name: target.text,
                node,
                message:
                  'Avoid branching on provider sets with .has(); encapsulate provider capabilities inside a provider adapter or model catalog.',
              })
            }
          }
        } else if (isPlanTierReference(arg)) {
          if (method === 'includes') {
            if (arrayContainsLiteralInSet(target, PLAN_TIER_LITERAL_SET)) {
              ctx.report(
                node,
                'Avoid branching on plan-tier arrays with .includes(); check declarative workspace capabilities from lib/governance/capabilities.ts instead.',
              )
            } else if (target && ts.isIdentifier(target)) {
              deferredChecks.push({
                kind: 'tierArray',
                name: target.text,
                node,
                message:
                  'Avoid branching on plan-tier arrays with .includes(); check declarative workspace capabilities from lib/governance/capabilities.ts instead.',
              })
            }
          } else if (method === 'has') {
            if (isLiteralSetExpression(target, PLAN_TIER_LITERAL_SET)) {
              ctx.report(
                node,
                'Avoid branching on plan-tier sets with .has(); check declarative workspace capabilities from lib/governance/capabilities.ts instead.',
              )
            } else if (target && ts.isIdentifier(target)) {
              deferredChecks.push({
                kind: 'tierSet',
                name: target.text,
                node,
                message:
                  'Avoid branching on plan-tier sets with .has(); check declarative workspace capabilities from lib/governance/capabilities.ts instead.',
              })
            }
          }
        }
      }

      // 4. Provider-keyed or plan-tier-keyed computed object lookup
      if (ts.isElementAccessExpression(node)) {
        const target = unwrapExpr(node.expression)
        const keyExpr = node.argumentExpression
        if (isProviderReference(keyExpr)) {
          if (isObjectWithMinKeys(target, PROVIDER_LITERAL_SET, 2)) {
            ctx.report(
              node,
              'Avoid provider-keyed object lookup outside adapters; read provider configuration from a dedicated adapter or model catalog.',
            )
          } else if (target && ts.isIdentifier(target)) {
            deferredChecks.push({
              kind: 'providerObject',
              name: target.text,
              node,
              message:
                'Avoid provider-keyed object lookup outside adapters; read provider configuration from a dedicated adapter or model catalog.',
            })
          }
        } else if (isPlanTierReference(keyExpr)) {
          if (isObjectWithMinKeys(target, PLAN_TIER_LITERAL_SET, 2)) {
            ctx.report(
              node,
              'Avoid plan-tier-keyed object lookup; read explicit limits or capabilities from lib/governance/capabilities.ts instead.',
            )
          } else if (target && ts.isIdentifier(target)) {
            deferredChecks.push({
              kind: 'tierObject',
              name: target.text,
              node,
              message:
                'Avoid plan-tier-keyed object lookup; read explicit limits or capabilities from lib/governance/capabilities.ts instead.',
            })
          }
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sf)

    for (const check of deferredChecks) {
      const matched =
        (check.kind === 'providerArray' && providerArrayVars.has(check.name))
        || (check.kind === 'providerSet' && providerSetVars.has(check.name))
        || (check.kind === 'providerObject' && providerObjectVars.has(check.name))
        || (check.kind === 'tierArray' && tierArrayVars.has(check.name))
        || (check.kind === 'tierSet' && tierSetVars.has(check.name))
        || (check.kind === 'tierObject' && tierObjectVars.has(check.name))
      if (matched) ctx.report(check.node, check.message)
    }
  },
})

export default noProviderOrPlanSpecialCasingRule

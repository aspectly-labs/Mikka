/**
 * Semantic lint rule: no-hardcoded-business-policy
 *
 * Flags hardcoded business, pricing, trial, promotional cutoff, and plan-quota
 * constants baked into application logic outside T3/T4 policy, catalog,
 * pricing, and runtime-config modules (Issue #3342).
 */
import ts from 'typescript'

export const RULE_NAME = 'no-hardcoded-business-policy'

export const ALLOWLIST = Object.freeze([
  'lib/billing/**',
  'lib/runtime-config/**',
  'lib/governance/policy.ts',
  'lib/governance/capabilities.ts',
  'lib/cloud-computer/machine-pricing.ts',
  'lib/abuse/policy.ts',
  'migrations/**',
  '**/migrations/**',
  'drizzle/**',
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

const TRIAL_DURATION_NAME_RE =
  /^(?:(?:DEFAULT_)?(?:TRIAL_DAYS|PROMO_DAYS|INTRO_DAYS|GRACE_PERIOD_DAYS|TRIAL_DURATION(?:_[A-Z0-9]+)?|PROMO_DURATION(?:_[A-Z0-9]+)?|INTRO_DURATION(?:_[A-Z0-9]+)?|FREE_TRIAL_[A-Z0-9_]+)|(?:default)?(?:TrialDays|PromoDays|IntroDays|GracePeriodDays|FreeTrial[A-Z][A-Za-z0-9]*|TrialDuration[A-Za-z0-9]*|PromoDuration[A-Za-z0-9]*|IntroDuration[A-Za-z0-9]*)|(?:trialDays|promoDays|introDays|gracePeriodDays|freeTrial[A-Z][A-Za-z0-9]*|trialDuration[A-Za-z0-9]*|promoDuration[A-Za-z0-9]*|introDuration[A-Za-z0-9]*))$/

const PRICING_DISCOUNT_NAME_RE =
  /^(?:(?:DEFAULT_)?(?:DISCOUNT_PERCENT|DISCOUNT_PCT|DISCOUNT_RATE|DISCOUNT_AMOUNT(?:_[A-Z0-9_]+)?|INTRO_PRICE(?:_[A-Z0-9_]+)?|PLAN_PRICE(?:_[A-Z0-9_]+)?|MONTHLY_PRICE(?:_[A-Z0-9_]+)?|ANNUAL_PRICE(?:_[A-Z0-9_]+)?|YEARLY_PRICE(?:_[A-Z0-9_]+)?|PROMO_AMOUNT(?:_[A-Z0-9_]+)?|PROMO_PRICE(?:_[A-Z0-9_]+)?|PROMO_DISCOUNT(?:_[A-Z0-9_]+)?|SEAT_PRICE(?:_[A-Z0-9_]+)?|SUBSCRIPTION_PRICE(?:_[A-Z0-9_]+)?)|(?:discountPercent|discountPct|discountRate|discountAmount[A-Za-z0-9]*|introPrice(?:[A-Z][A-Za-z0-9]*)?|planPrice(?:[A-Z][A-Za-z0-9]*)?|monthlyPrice(?:[A-Z][A-Za-z0-9]*)?|annualPrice(?:[A-Z][A-Za-z0-9]*)?|yearlyPrice(?:[A-Z][A-Za-z0-9]*)?|promoAmount(?:[A-Z][A-Za-z0-9]*)?|promoPrice(?:[A-Z][A-Za-z0-9]*)?|promoDiscount[A-Za-z0-9]*|seatPrice(?:[A-Z][A-Za-z0-9]*)?|subscriptionPrice(?:[A-Z][A-Za-z0-9]*)?))$/

const CAMPAIGN_DATE_NAME_RE =
  /^(?:(?:PROMO_END_AT|PROMO_END_DATE|PROMO_END_[A-Z0-9_]+|OFFER_END_AT|OFFER_END_DATE|OFFER_END_[A-Z0-9_]+|CAMPAIGN_END_[A-Z0-9_]+|PROMO_START_[A-Z0-9_]+|OFFER_START_[A-Z0-9_]+|CAMPAIGN_START_[A-Z0-9_]+|INTRO_END_[A-Z0-9_]+|INTRO_START_[A-Z0-9_]+)|(?:promoEndAt|promoEndDate|promoEnd[A-Z][A-Za-z0-9]*|offerEndAt|offerEndDate|offerEnd[A-Z][A-Za-z0-9]*|campaignEnd[A-Z][A-Za-z0-9]*|promoStart[A-Z][A-Za-z0-9]*|offerStart[A-Z][A-Za-z0-9]*|campaignStart[A-Z][A-Za-z0-9]*|introEnd[A-Z][A-Za-z0-9]*|introStart[A-Z][A-Za-z0-9]*))$/

const NON_BUSINESS_FREE_POOL_RE =
  /^(?:MAX_FREE_(?:SOCKETS|MEMORY|BYTES|CONNECTIONS|HANDLES|BUFFERS|PAGES|BLOCKS|SPACE|SLOTS|HEAP|POOL)|maxFree(?:Sockets|Memory|Bytes|Connections|Handles|Buffers|Pages|Blocks|Space|Slots|Heap|Pool))$/

const PLAN_QUOTA_NAME_RE =
  /^(?:(?:FREE_PLAN_LIMIT(?:_[A-Z0-9]+)?|PRO_PLAN_LIMIT(?:_[A-Z0-9]+)?|STARTER_PLAN_LIMIT(?:_[A-Z0-9]+)?|ENTERPRISE_LIMIT(?:_[A-Z0-9]+)?|ENTERPRISE_PLAN_LIMIT(?:_[A-Z0-9]+)?|MAX_FREE_[A-Z0-9_]+|MAX_PRO_[A-Z0-9_]+|MAX_ENTERPRISE_[A-Z0-9_]+|FREE_TIER_LIMIT(?:_[A-Z0-9]+)?|PRO_TIER_LIMIT(?:_[A-Z0-9]+)?|ENTERPRISE_TIER_LIMIT(?:_[A-Z0-9]+)?|FREE_QUOTA_[A-Z0-9_]+|PRO_QUOTA_[A-Z0-9_]+|ENTERPRISE_QUOTA_[A-Z0-9_]+)|(?:freePlanLimit[A-Za-z0-9]*|proPlanLimit[A-Za-z0-9]*|starterPlanLimit[A-Za-z0-9]*|enterpriseLimit[A-Za-z0-9]*|enterprisePlanLimit[A-Za-z0-9]*|maxFree[A-Z][A-Za-z0-9]*|maxPro[A-Z][A-Za-z0-9]*|maxEnterprise[A-Z][A-Za-z0-9]*|freeTierLimit[A-Za-z0-9]*|proTierLimit[A-Za-z0-9]*|enterpriseTierLimit[A-Za-z0-9]*|freeQuota[A-Z][A-Za-z0-9]*|proQuota[A-Z][A-Za-z0-9]*|enterpriseQuota[A-Z][A-Za-z0-9]*))$/

const PREFILTER_RE =
  /(?:TRIAL|PROMO|INTRO|GRACE_PERIOD|DISCOUNT|PLAN_PRICE|MONTHLY_PRICE|ANNUAL_PRICE|YEARLY_PRICE|SEAT_PRICE|SUBSCRIPTION_PRICE|OFFER_END|OFFER_START|CAMPAIGN_END|CAMPAIGN_START|FREE_PLAN_LIMIT|PRO_PLAN_LIMIT|STARTER_PLAN_LIMIT|ENTERPRISE_LIMIT|ENTERPRISE_PLAN_LIMIT|MAX_FREE|MAX_PRO|MAX_ENTERPRISE|FREE_TIER_LIMIT|PRO_TIER_LIMIT|ENTERPRISE_TIER_LIMIT|FREE_QUOTA|PRO_QUOTA|ENTERPRISE_QUOTA|trialDays|promoDays|introDays|gracePeriodDays|freeTrial|trialDuration|promoDuration|introDuration|discountPercent|discountPct|discountRate|discountAmount|introPrice|planPrice|monthlyPrice|annualPrice|yearlyPrice|promoAmount|promoPrice|promoDiscount|seatPrice|subscriptionPrice|promoEnd|offerEnd|campaignEnd|promoStart|offerStart|campaignStart|introEnd|introStart|freePlanLimit|proPlanLimit|starterPlanLimit|enterpriseLimit|enterprisePlanLimit|maxFree|maxPro|maxEnterprise|freeTierLimit|proTierLimit|enterpriseTierLimit|freeQuota|proQuota|enterpriseQuota)/i

const ISO_OR_DATE_LITERAL_RE =
  /^(?:\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:UTC|GMT|[A-Z]{2,4}))?)?|\d{4}\/\d{2}\/\d{2})$/i

const PRICE_STRING_RE = /^(?:[$\u20AC\u00A3\u00A5]\s*\d+(?:[.,]\d+)?(?:\s*\/\s*(?:mo|month|yr|year|seat|user))?|\d+(?:\.\d+)?\s*(?:USD|EUR|GBP|CNY))$/i

const ARITHMETIC_OPS = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
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
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text
  }
  return null
}

function isStaticNumericExpr(node) {
  const expr = unwrapExpr(node)
  if (!expr) return false
  if (ts.isNumericLiteral(expr)) return true
  if (
    ts.isPrefixUnaryExpression(expr)
    && (expr.operator === ts.SyntaxKind.MinusToken || expr.operator === ts.SyntaxKind.PlusToken)
  ) {
    return isStaticNumericExpr(expr.operand)
  }
  if (ts.isBinaryExpression(expr) && ARITHMETIC_OPS.has(expr.operatorToken.kind)) {
    return isStaticNumericExpr(expr.left) && isStaticNumericExpr(expr.right)
  }
  return false
}

function isStaticDateExpr(node) {
  const expr = unwrapExpr(node)
  if (!expr) return false
  const str = getStaticString(expr)
  if (str !== null && ISO_OR_DATE_LITERAL_RE.test(str.trim())) return true

  // new Date('2026-12-31T23:59:59Z') or new Date(2026, 11, 31)
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'Date') {
    const args = expr.arguments ?? []
    if (args.length === 1) {
      const argStr = getStaticString(args[0])
      if (argStr !== null && ISO_OR_DATE_LITERAL_RE.test(argStr.trim())) return true
    }
    if (args.length >= 2 && args.every(isStaticNumericExpr)) return true
  }

  // Date.parse('2026-12-31...') or Date.UTC(2026, 11, 31)
  if (
    ts.isCallExpression(expr)
    && ts.isPropertyAccessExpression(expr.expression)
    && ts.isIdentifier(expr.expression.expression)
    && expr.expression.expression.text === 'Date'
  ) {
    const method = expr.expression.name.text
    if (method === 'parse' && expr.arguments.length === 1) {
      const argStr = getStaticString(expr.arguments[0])
      if (argStr !== null && ISO_OR_DATE_LITERAL_RE.test(argStr.trim())) return true
    }
    if (method === 'UTC' && expr.arguments.length >= 2 && expr.arguments.every(isStaticNumericExpr)) {
      return true
    }
  }

  return false
}

function isPriceStringExpr(node) {
  const str = getStaticString(node)
  return str !== null && PRICE_STRING_RE.test(str.trim())
}

function getPropertyKeyName(nameNode) {
  if (!nameNode) return null
  if (ts.isIdentifier(nameNode)) return nameNode.text
  if (ts.isStringLiteral(nameNode) || ts.isNoSubstitutionTemplateLiteral(nameNode)) return nameNode.text
  if (ts.isComputedPropertyName(nameNode)) return getStaticString(nameNode.expression)
  return null
}

function inspectBinding(name, initializer, reportNode, report) {
  if (!name || !initializer) return

  if (TRIAL_DURATION_NAME_RE.test(name) && isStaticNumericExpr(initializer)) {
    report(
      reportNode,
      `Hardcoded trial/promo duration "${name}" must not be baked into application logic; read time-bounded offers from Tier-4 runtime config (lib/runtime-config/) or Tier-3 billing/governance policy instead.`,
    )
    return
  }

  if (
    PRICING_DISCOUNT_NAME_RE.test(name)
    && (isStaticNumericExpr(initializer) || isPriceStringExpr(initializer))
  ) {
    report(
      reportNode,
      `Hardcoded pricing/discount policy "${name}" must not be baked into application logic; source pricing from Tier-3 billing catalog (lib/billing/catalog.ts) or Tier-4 runtime config (lib/runtime-config/) instead.`,
    )
    return
  }

  if (CAMPAIGN_DATE_NAME_RE.test(name) && isStaticDateExpr(initializer)) {
    report(
      reportNode,
      `Hardcoded promotional campaign date "${name}" must not be baked into application logic; drive active offer windows from Tier-4 runtime config (lib/runtime-config/) instead.`,
    )
    return
  }

  if (
    PLAN_QUOTA_NAME_RE.test(name)
    && !NON_BUSINESS_FREE_POOL_RE.test(name)
    && isStaticNumericExpr(initializer)
  ) {
    report(
      reportNode,
      `Hardcoded plan quota ceiling "${name}" must not be baked into application logic; read declarative workspace capabilities from Tier-3 governance (lib/governance/capabilities.ts) instead.`,
    )
  }
}

export const noHardcodedBusinessPolicyRule = Object.freeze({
  name: RULE_NAME,
  description:
    'Disallow hardcoded trial/promo durations, discount rates, pricing constants, campaign cutoff dates, and plan quota ceilings outside T3/T4 policy, billing, and runtime-config modules.',
  allowlist: ALLOWLIST,
  mightMatch(source) {
    return PREFILTER_RE.test(source)
  },
  check(ctx) {
    const sf = ctx.getSourceFile()
    const visit = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        inspectBinding(node.name.text, node.initializer, node, ctx.report)
      } else if (ts.isPropertyAssignment(node) && node.initializer) {
        inspectBinding(getPropertyKeyName(node.name), node.initializer, node, ctx.report)
      } else if (ts.isPropertyDeclaration(node) && node.initializer) {
        inspectBinding(getPropertyKeyName(node.name), node.initializer, node, ctx.report)
      } else if (ts.isEnumMember(node) && node.initializer) {
        inspectBinding(getPropertyKeyName(node.name), node.initializer, node, ctx.report)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  },
})

export default noHardcodedBusinessPolicyRule

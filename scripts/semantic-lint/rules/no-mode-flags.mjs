/**
 * Semantic lint rule: no-mode-flags
 *
 * Flags host/deployment/surface mode boolean flags and multi-branch mode
 * switches/if-else chains inside application logic instead of declarative
 * workspace capabilities or platform adapters (Issue #3342).
 */
import ts from 'typescript'

export const RULE_NAME = 'no-mode-flags'

export const ALLOWLIST = Object.freeze([
  'lib/edition.ts',
  'lib/governance/edition.ts',
  'lib/governance/policy.ts',
  'lib/governance/capabilities.ts',
  'lib/env/**',
  'lib/deployment-stage.mjs',
  'lib/deployment-switches.ts',
  'lib/feature-flags.ts',
  'lib/platform/**',
  'lib/server-info.ts',
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

const MODE_FLAG_IDENTIFIER_RE =
  /^(?:isHostedMode|isCloudMode|isSelfHostMode|isSelfHostedMode|isCommunityMode|hostedMode|cloudMode|selfHostMode|selfHostedMode|communityMode|surfaceMode|deploymentModeFlag|hostModeFlag|cloudModeFlag|hostedModeFlag|selfHostModeFlag|IS_HOSTED_MODE|IS_CLOUD_MODE|IS_SELF_HOST_MODE|IS_SELF_HOSTED_MODE|IS_COMMUNITY_MODE|HOSTED_MODE|CLOUD_MODE|SELF_HOST_MODE|SELF_HOSTED_MODE|COMMUNITY_MODE|SURFACE_MODE|DEPLOYMENT_MODE_FLAG)$/

const MODE_SUBJECT_IDENTIFIER_RE =
  /^(?:mode|deploymentMode|hostMode|surfaceMode|runtimeMode|appMode|envMode|edition|workspaceEdition|serverEdition|mikkaEdition|deployment)$/i

const DEPLOYMENT_MODE_LITERALS = new Set([
  'cloud',
  'hosted',
  'selfhost',
  'self-hosted',
  'self_hosted',
  'community',
])

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

const PREFILTER_FLAG_RE =
  /(?:isHostedMode|isCloudMode|isSelfHostMode|isSelfHostedMode|isCommunityMode|hostedMode|cloudMode|selfHostMode|selfHostedMode|communityMode|surfaceMode|deploymentModeFlag|hostModeFlag|cloudModeFlag|hostedModeFlag|selfHostModeFlag|IS_HOSTED_MODE|IS_CLOUD_MODE|IS_SELF_HOST_MODE|IS_SELF_HOSTED_MODE|IS_COMMUNITY_MODE|HOSTED_MODE|CLOUD_MODE|SELF_HOST_MODE|SELF_HOSTED_MODE|COMMUNITY_MODE|SURFACE_MODE|DEPLOYMENT_MODE_FLAG)/

const PREFILTER_MODE_LITERAL_RE =
  /['"`](?:cloud|hosted|selfhost|self-hosted|self_hosted|community)['"`]/

const PREFILTER_BRANCH_RE = /\b(?:else|switch)\b/

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

function isModeSubject(node) {
  const expr = unwrapNormalizedStringExpr(node)
  if (!expr) return false
  if (ts.isIdentifier(expr)) return MODE_SUBJECT_IDENTIFIER_RE.test(expr.text)
  if (ts.isPropertyAccessExpression(expr)) return MODE_SUBJECT_IDENTIFIER_RE.test(expr.name.text)
  if (ts.isElementAccessExpression(expr)) {
    const key = getStaticString(expr.argumentExpression)
    return key !== null && MODE_SUBJECT_IDENTIFIER_RE.test(key)
  }
  return false
}

function getModeLiteral(node) {
  const str = getStaticString(node)
  if (str !== null && DEPLOYMENT_MODE_LITERALS.has(str)) return str
  return null
}

function extractModeComparisons(expr, out) {
  if (!expr) return
  const current = unwrapExpr(expr)
  if (!current) return

  if (ts.isBinaryExpression(current)) {
    const kind = current.operatorToken.kind
    if (EQUALITY_OPERATORS.has(kind)) {
      const leftLit = getModeLiteral(current.left)
      const rightLit = getModeLiteral(current.right)
      if (rightLit !== null && isModeSubject(current.left)) {
        out.add(rightLit)
      } else if (leftLit !== null && isModeSubject(current.right)) {
        out.add(leftLit)
      }
      return
    }
    if (
      kind === ts.SyntaxKind.AmpersandAmpersandToken
      || kind === ts.SyntaxKind.BarBarToken
    ) {
      extractModeComparisons(current.left, out)
      extractModeComparisons(current.right, out)
      return
    }
  }

  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
    extractModeComparisons(current.operand, out)
  }
}

function inspectBindingPattern(binding, report) {
  if (ts.isIdentifier(binding)) {
    if (MODE_FLAG_IDENTIFIER_RE.test(binding.text)) {
      report(
        binding,
        `Mode flag "${binding.text}" couples application logic to host/deployment/surface mode; inject declarative capabilities (lib/governance/capabilities.ts) or a platform adapter instead.`,
      )
    }
    return
  }
  if (ts.isObjectBindingPattern(binding)) {
    for (const el of binding.elements) {
      const propName = el.propertyName ? getPropertyKeyName(el.propertyName) : null
      if (propName && MODE_FLAG_IDENTIFIER_RE.test(propName)) {
        report(
          el,
          `Mode flag property "${propName}" couples application logic to host/deployment/surface mode; inject declarative capabilities (lib/governance/capabilities.ts) or a platform adapter instead.`,
        )
      } else {
        inspectBindingPattern(el.name, report)
      }
    }
  } else if (ts.isArrayBindingPattern(binding)) {
    for (const el of binding.elements) {
      if (ts.isBindingElement(el)) inspectBindingPattern(el.name, report)
    }
  }
}

export const noModeFlagsRule = Object.freeze({
  name: RULE_NAME,
  description:
    'Disallow host/deployment/surface mode boolean flags and multi-branch mode switches outside edition, governance, and platform adapter modules.',
  allowlist: ALLOWLIST,
  mightMatch(source) {
    return (
      PREFILTER_FLAG_RE.test(source)
      || (PREFILTER_MODE_LITERAL_RE.test(source) && PREFILTER_BRANCH_RE.test(source))
    )
  },
  check(ctx) {
    const sf = ctx.getSourceFile()
    const visitedElseIfs = new WeakSet()

    const visit = node => {
      // 1. Mode-gating variable / parameter / type-prop / class-prop declarations
      if (ts.isVariableDeclaration(node)) {
        inspectBindingPattern(node.name, ctx.report)
      } else if (ts.isParameter(node)) {
        inspectBindingPattern(node.name, ctx.report)
      } else if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
        const key = getPropertyKeyName(node.name)
        if (key && MODE_FLAG_IDENTIFIER_RE.test(key)) {
          ctx.report(
            node,
            `Mode flag "${key}" couples components or modules to host/deployment/surface mode; accept declarative capabilities or platform adapters instead.`,
          )
        }
      } else if (ts.isPropertyAssignment(node)) {
        const key = getPropertyKeyName(node.name)
        if (key && MODE_FLAG_IDENTIFIER_RE.test(key)) {
          ctx.report(
            node,
            `Mode flag property "${key}" gates behavior on host/deployment/surface mode; use declarative capabilities or platform adapters instead.`,
          )
        }
      } else if (ts.isShorthandPropertyAssignment(node)) {
        if (MODE_FLAG_IDENTIFIER_RE.test(node.name.text)) {
          ctx.report(
            node,
            `Mode flag property "${node.name.text}" gates behavior on host/deployment/surface mode; use declarative capabilities or platform adapters instead.`,
          )
        }
      }

      // 2. Multi-branch if (mode === 'cloud') ... else if (mode === 'selfhost') ...
      if (ts.isIfStatement(node) && !visitedElseIfs.has(node)) {
        const branchLiterals = new Set()
        let branchCount = 0
        let cursor = node
        while (cursor && ts.isIfStatement(cursor)) {
          if (cursor !== node) visitedElseIfs.add(cursor)
          const foundInBranch = new Set()
          extractModeComparisons(cursor.expression, foundInBranch)
          if (foundInBranch.size > 0) {
            branchCount += 1
            for (const lit of foundInBranch) branchLiterals.add(lit)
          }
          cursor = cursor.elseStatement && ts.isIfStatement(cursor.elseStatement)
            ? cursor.elseStatement
            : null
        }
        if (branchCount >= 2 && branchLiterals.size >= 2) {
          const formatted = [...branchLiterals].map(v => `'${v}'`).join(', ')
          ctx.report(
            node,
            `Multi-branch deployment/host mode check (${formatted}) belongs in edition/governance/platform resolvers, not application logic; consume declarative capabilities instead.`,
          )
        }
      }

      // 3. switch (mode) branching on 'cloud' | 'hosted' | 'selfhost' | 'community'
      if (ts.isSwitchStatement(node)) {
        const matchedLiterals = new Set()
        for (const clause of node.caseBlock.clauses) {
          if (ts.isCaseClause(clause)) {
            const lit = getModeLiteral(clause.expression)
            if (lit !== null) matchedLiterals.add(lit)
          }
        }
        const subjectMatches = isModeSubject(node.expression)
        if (matchedLiterals.size >= 2 || (subjectMatches && matchedLiterals.size >= 1)) {
          const formatted = [...matchedLiterals].map(v => `'${v}'`).join(', ')
          ctx.report(
            node,
            `Switch on deployment/host mode (${formatted}) belongs in edition/governance/platform resolvers, not application logic; consume declarative capabilities instead.`,
          )
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sf)
  },
})

export default noModeFlagsRule

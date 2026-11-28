// #2869 and #3381: API-key and managed traffic use LiteLLM. CPA owns subscription inference.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const client = 'lib/model-gateway/litellm-client.ts'
const roots = ['app/', 'apps/', 'lib/', 'packages/', 'cloudflare/', 'services/', 'workflows/']
const constructors = new Set(['createGateway', 'gateway', 'createOpenAI', 'createAnthropic', 'createOpenAICompatible'])
const providerModule = /^(?:@ai-sdk\/(?:gateway|openai|anthropic|openai-compatible)|openai|@anthropic-ai\/sdk)$/
const inferenceFunctions = new Set(['generateText', 'streamText', 'generateObject', 'streamObject', 'embed', 'embedMany', 'transcribe'])
const modelDomain = /(?:api\.openai\.com|api\.anthropic\.com|ai-gateway\.vercel\.sh|api\.deepseek\.com|api\.moonshot\.(?:cn|ai)|zero\.cat|chatgpt\.com\/backend-api\/codex|api\.cloudflare\.com\/client\/v4\/accounts\/[^\s]*\/ai)/i

// The gateway passes provider catalogue and routing metadata to LiteLLM.
const metadata = new Set(['lib/model-gateway/provider-config.ts', 'lib/audit/events.ts'])
const quotaEndpoints = new Map([
  ['packages/daemon/src/quota/claude.ts', 'https://api.anthropic.com/api/oauth/usage'],
  ['packages/daemon/src/quota/codex.ts', 'https://chatgpt.com/backend-api/wham/usage'],
])
const subscriptionEndpoints = new Map([
  ['CLAUDE_SUBSCRIPTION_ENDPOINT', 'https://api.anthropic.com/v1/messages'],
  ['CODEX_SUBSCRIPTION_ENDPOINT', 'https://chatgpt.com/backend-api/codex/responses'],
])

function isAllowedMetadata(file, node) {
  if (metadata.has(file)) return true
  if (!ts.isStringLiteralLike(node)) return false
  if (quotaEndpoints.get(file) === node.text) return true
  const declaration = node.parent
  return file === 'lib/model-admission/contract.ts'
    && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
    && declaration.initializer === node && subscriptionEndpoints.get(declaration.name.text) === node.text
}

const nativeSubscriptionBroker = 'packages/subscription-worker/native_broker.go'
const nativeProviderHost = /(?:api\.anthropic\.com|api\.openai\.com|chatgpt\.com)/i
const nativeSubscriptionDestinations = new Set([
  'endpoint = "https://api.anthropic.com/v1/messages?beta=true"',
  'endpoint = "https://api.anthropic.com/v1/messages/count_tokens?beta=true"',
  'endpoint = "https://chatgpt.com/backend-api/codex/responses"',
])

function auditNativeSubscriptionBroker(file, source) {
  return source.split('\n').flatMap((line, index) => {
    const match = nativeProviderHost.exec(line)
    return match && !nativeSubscriptionDestinations.has(line.trim()) ? [{ file, line: index + 1, column: match.index + 1,
      reason: 'native subscription inference must use a fixed CPA provider endpoint' }] : []
  })
}

export function auditLiteLlmSource(file, source) {
  if (file === nativeSubscriptionBroker) return auditNativeSubscriptionBroker(file, source)
  if (file.endsWith('.go')) return []
  if (file === client) return []
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found = []
  const report = (node, reason) => {
    const { line, character } = tree.getLineAndCharacterOfPosition(node.getStart(tree))
    found.push({ file, line: line + 1, column: character + 1, reason })
  }
  function visit(node) {
    // Reject provider imports too: renaming a factory cannot bypass the guard.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text
      const bindings = node.importClause?.namedBindings
      const factory = bindings && ts.isNamedImports(bindings)
        && bindings.elements.some(item => constructors.has((item.propertyName ?? item.name).text))
      const runtimeImport = !node.importClause?.isTypeOnly && (node.importClause?.name
        || (bindings && ts.isNamespaceImport(bindings))
        || (bindings && ts.isNamedImports(bindings) && bindings.elements.some(item => !item.isTypeOnly && !(item.propertyName ?? item.name).text.endsWith('Error'))))
      if ((providerModule.test(module) && runtimeImport) || (module === 'ai' && factory)) {
        report(node, 'provider SDK imports belong in the LiteLLM client')
      }
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      && providerModule.test(node.arguments[0].text)) {
      report(node, 'dynamic provider imports belong in the LiteLLM client')
    }
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isIdentifier(node.arguments[0])
      && subscriptionEndpoints.has(node.arguments[0].text)
      && (node.expression.getText(tree) === 'fetch' || node.expression.getText(tree) === 'globalThis.fetch')) {
      report(node, 'subscription inference requests belong in the LiteLLM client')
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && constructors.has(node.expression.text)) {
      report(node, 'model SDK construction belongs in the LiteLLM client')
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && inferenceFunctions.has(node.expression.text)) {
      const options = node.arguments[0]
      if (options && ts.isObjectLiteralExpression(options) && options.properties.some(property =>
        ts.isPropertyAssignment(property) && property.name.getText(tree) === 'model' && ts.isStringLiteralLike(property.initializer))) {
        report(node, 'string model IDs select the SDK default gateway; pass a LiteLLM model')
      }
    }
    if ((ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) && modelDomain.test(node.getText(tree)) && !isAllowedMetadata(file, node)) {
      report(node, 'provider model domains belong in LiteLLM configuration')
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

export function auditLiteLlmRepository() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(file => roots.some(root => file.startsWith(root)) && (file === nativeSubscriptionBroker || /\.[cm]?[jt]sx?$/.test(file))
      && !/(?:^|\/)(?:node_modules|dist|build|out|__tests__|tests?|e2e|fakes|fixtures)\//.test(file)
      && !/\.(?:test|spec|fixture|stories|node-test)\.[cm]?[jt]sx?$/.test(file) && !file.endsWith('.d.ts') && existsSync(file))
    .flatMap(file => auditLiteLlmSource(file, readFileSync(file, 'utf8')))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const found = auditLiteLlmRepository()
  for (const item of found) console.error(`${item.file}:${item.line}:${item.column} [litellm-only] ${item.reason}`)
  process.exitCode = found.length ? 1 : 0
}

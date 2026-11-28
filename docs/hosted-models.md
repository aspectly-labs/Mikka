# Hosted model aliases

These are the hosted LiteLLM aliases Mikka uses. The table is generated from deployment configuration; edit the source, then run `pnpm docs:generate`.

<!-- generated:hosted-models -->
Source: `deploy/litellm/config.yaml`.

| Alias | Upstream model |
| --- | --- |
| `mikka-default` | `vercel_ai_gateway/deepseek/deepseek-v4.1-flash` |
| `mikka-title` | `vercel_ai_gateway/openai/gpt-6-luna` |
| `mikka-planning` | `vercel_ai_gateway/openai/gpt-6-luna` |
| `mikka-decision` | `openai/openai/gpt-6-luna-decisions` |
| `mikka-native-responses/openai/gpt-6-luna` | `openai/openai/gpt-6-luna` |
<!-- /generated:hosted-models -->

## Bot web access

Eve exposes Web Search and Web Fetch through the Bot's configured tool permissions. Web Fetch and search admission share the account's public web rate limit. Scheduled reads keep their explicit tool allowlist, and Factory roles keep their own toolsets.

Third-party API keys and Managed Models use LiteLLM. The native search route follows the selected endpoint and its advertised capabilities. Third-party OpenAI search uses Responses, and third-party Anthropic search uses Messages. Ordinary tool calls and the existing compatible Chat Completions path remain available. The official Codex and Claude subscriptions use the independent CPA worker. CC and Codex Threads retain their own native harness and search tools.

Third-party API keys use their provider's native search when available. The account-wide Mikka Web Search setting authorizes the managed fallback and starts disabled. A completed fallback with a cost receipt appears as Web Search under external accounts. Pending or interrupted calls with an unknown cost retain an unknown receipt. Managed Model native search settles with the model call, and official subscriptions record usage against the subscription.

The approved Managed Model search routes are GPT-6 Luna over Responses and Claude Haiku 5.5 over Vercel Gateway TypeSafe. LiteLLM forwards Haiku's native Anthropic search using the existing Gateway credential. Haiku settlement reads the actual generation total, including native search charges. A pending receipt is retried briefly. If the receipt remains unavailable or the stream ends early, usage remains unknown and retains any Gateway generation ID received. [Vercel Gateway generation receipt](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#look-up-a-generation)

Firecrawl remains available on the remaining existing Coordinator search path until migration and acceptance finish.

The protocol fixtures verify native search, citation sources, ordinary tool declarations, and image inputs on the applicable path. The provider image generation and edit endpoints require an authorized route, artifact handling, and their own usage receipt. Code Interpreter requires its own provider tool and container result handling. Their existing product eligibility stays in effect.

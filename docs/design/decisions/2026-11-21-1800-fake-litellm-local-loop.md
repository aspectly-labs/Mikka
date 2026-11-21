# Fake the model at the LiteLLM boundary; local-loop needs no real key

- Date: 2026-11-21
- Source: #2884 (验收工作流)
- Rule: test/tooling, not product
- Supersedes in part: [2026-11-01-2225](2026-11-01-2225-api-cli-acceptance-and-backend-owner.md) item 2 (local acceptance required a real DeepSeek key)

1. **One fake LiteLLM.** `tests/mvp/fake-litellm.mjs` implements the endpoints
   `lib/model-gateway/litellm-client.ts` actually calls — OpenAI chat
   completions and responses, Anthropic messages, transcriptions, decisions —
   plus the provider `/models` probe the key seeder verifies against. Both
   `scripts/dev-local/services.mjs` and `tests/mvp/services.mjs` mount it, so
   the LiteLLM boundary has exactly one scripted implementation.
2. **Scripted by default.** `pnpm dev:local` points `MIKKA_LITELLM_URL` at the
   fake and seeds a placeholder workspace key (`mikka-local-scripted-key`);
   the transport never lets a `api.deepseek.com` request leave the loop.
   `MIKKA_DEV_REAL_MODELS=1` is the explicit, off-by-default switch that
   restores live-key acceptance (`DEEPSEEK_API_KEY` or Infisical
   `dev:/vercel`), including the real provider probe.
3. **Scenarios, not just echoes.** The fake answers normally, streams, and
   issues tool calls (`/tool` command). `POST /litellm/scenarios` arms a fault
   or cost matched by model alias plus a marker anywhere in the request body:
   `429`, `500`, `timeout` (holds until the caller aborts), and
   `x-litellm-response-cost`/`usage.cost` receipts. This is how local tests
   cover the failure contract without a live upstream.
4. **Not model acceptance.** The scripted boundary proves the integration
   contract (request shape, streaming, receipts, error handling), never live
   model judgment. Subscription-path acceptance still follows the live-model
   policy; a scripted local-loop run says so in its
   `externalBoundaries` record.

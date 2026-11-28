# Subscription inference uses LiteLLM

- Date: 2026-11-26
- **Status:** Superseded by [2026-11-27-2304](2026-11-27-2304-official-subscription-cpa-egress.md).
- Source: [Alex's decision in #2869](https://github.com/aspectly-labs/Mikka/issues/2869#issuecomment-7181454601), with the [Capy reference](https://github.com/aspectly-labs/Mikka/issues/2869#issuecomment-7181464840) for context.
- Supersedes the subscription inference exception in rule 7 of [2026-11-20-0530](2026-11-20-0530-litellm-only-model-egress.md). Its account-operation boundary and the other rules remain in force.

Bot chat and Coordinator subscription inference use LiteLLM. The private CPA subscription worker is the upstream for the subscription route and owns the OAuth grant, refresh, and provider authorization. The application streams the result through the LiteLLM client.

Claude Code and Codex task runs use their normal provider protocols through a run-bound Mikka gateway. The gateway sends subscription inference through LiteLLM pass-through. The OAuth access token is attached server-side and the machine receives a short-lived run token. Preserve the Claude OAuth headers and required system block, the Codex `backend-api` response path, and streaming for both. Use the selected subscription route without direct-provider fallback or a rollout switch. Each call has one usage record and trace.

Account login, refresh, and usage or quota probes keep their existing account endpoints. They represent account operations outside the inference route.

The scripted acceptance must exercise the real application path and replace only the provider HTTP boundary for the subscription protocol check. Regression tests cover the former direct subscription shim and direct inference from the account probe path. The production window covers one authorized real request per provider and confirms the corresponding usage record and trace.

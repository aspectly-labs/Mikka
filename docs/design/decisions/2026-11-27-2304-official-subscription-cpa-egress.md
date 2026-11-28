# Official subscriptions use the independent CPA worker

- Date: 2026-11-27
- **Status:** Accepted.
- Source: [#3381 and the owner's routing clarification in #3403](https://github.com/aspectly-labs/Mikka/issues/3403#issuecomment-7229851205).
- Supersedes: [2026-11-26-0300](2026-11-26-0300-subscription-inference-through-litellm.md).

BYOK and Managed Model inference use the existing LiteLLM service. Preserve
the model's real provider, the upstream endpoint protocol and supported native
tools when choosing Chat Completions, Responses or Messages.

Bot and Coordinator chats with an official Codex or Claude Code subscription
stream through the private CPA Subscription Worker to the user's authorized
provider. Claude Code and Codex Threads keep their native Harness tools. Their
run-bound Mikka gateway credential authorizes the corresponding CPA worker
request. Only the worker attaches the provider OAuth credential.

The application records subscription usage from the provider stream. An
incomplete stream or missing usage leaves the receipt unknown. The receipt
uses a Mikka call identifier. Account login, refresh and quota checks continue
to use the subscription account endpoints.

Keep the existing signed internal callback and pass-through routes available
while previous application versions remain eligible for rollback. Verify the
active release and rollback versions before removing those compatibility routes.

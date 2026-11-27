# Model keys are a person's or a workspace's; a personal key is never shared

- Date: 2026-11-27 17:40 UTC
- **Status:** Accepted (Alex, 2026-11-27)
- Source: Alex, 2026-11-27: 「第三个，个人模型共享给工作区，这个是不允许的。如果说你要共享给工作区，应该在工作区的那个地方再添加，不是我们现在就是有了呀，一个是个人 connection，一个是工作区的 connection，那么应该是分开添加才行啊，不允许直接共享。」
- Same rule as decision 2026-11-27-1700, personal MCP servers are not shareable (`2026-11-27-1700-personal-mcp-not-shareable.md`, #3392), applied to model API keys and custom providers.
- Supersedes in part: the 「分享给团队成员」 exception for API keys in [orchestration spec](2026-10-31-2300-orchestration-spec.md); "shares are only for other members' bots" in [own credentials always usable](2026-11-01-2240-own-credentials-always-usable.md) (a person's own keys still always work for that person); 「API Key 的团队分享不变」 in [subscriptions serve their owner only](2026-11-17-1400-subscriptions-owner-only.md).

An API key or custom provider in 设置 › 模型 belongs to exactly one owner:

- **你的连接 (personal).** Added by a person, sealed to that person, used by
  that person's own runs in any workspace they belong to, as before. No other
  member's run, Bot chat or model picker ever sees it.
- **工作区连接 (workspace).** Added to a team workspace by one of its admins,
  sealed to the workspace (not to the admin), used by every active member's
  runs in that workspace, and kept when the admin who added it leaves. Only
  the workspace's admins rename, rotate, refresh, turn models on or off for,
  or remove it. Members see its name, provider and models, never the key.

There is no way to move a key between the two, in either direction. A
workspace that wants a key adds its own. Like Capy, workspace keys are
managed by admins, members see that the workspace serves them, and a
person's own keys come first in their own threads, then the workspace's.
Capy also offers moving a personal key into the organization; Mikka does
not, by Alex's rule above.

What changes:

- `model_api_keys` gains `"workspaceId"` and `"addedBy"`; `"ownerId"` becomes
  nullable, and a check makes every key a person's or a workspace's, never
  both. Migration `20261127173719_model_api_keys_personal_or_workspace.sql`.
- The same migration withdraws every `model_api_key_shares` row and closes the
  table to inserts. Shares are not converted into workspace keys: the
  ciphertext is bound to its person, and converting would hand a person's key
  to the workspace without them adding it. A workspace that relied on a
  teammate's shared key re-adds it under 工作区连接. Active runs on another
  person's key are asked to stop; saved Bot chat choices and model-order
  entries that name another person's key are cleared. The table is dropped by
  a later contract migration.
- Usable keys for a run, a Bot chat or the model picker in a workspace are the
  person's own keys, then the workspace's own keys. Claim (`validateRunApiKey`)
  and the frozen execution identity accept only those; a workspace key's
  binding has access `workspace` and bills the workspace.
- `setApiKeyShare`, `removeMemberApiKeyShares` and the `api_key` kind of
  Organization resource approvals are removed. The 团队权限 › 订阅与 API Key
  switch no longer grants or stops anything.
- One release of compatibility for the hosted settings page: `createApiKey(…,
  { share: true })` adds a workspace key (admins only), the page lists
  workspace keys where it read shared keys, and `updateApiKeyShare` answers
  `apiKeySharingRetired` without changing anything.

Cost if wrong: a team that shared one member's key must have an admin add it
again as a workspace connection.

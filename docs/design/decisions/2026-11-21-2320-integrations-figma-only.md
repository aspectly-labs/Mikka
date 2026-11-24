# Paper, Revyl and Tailscale stay design-side until a real backend exists

- **Status:** Accepted

Scope: [settings backend #3110](https://github.com/alexj11324/Mikka/issues/3110),
stream WS-D item E11 (Figma frame 12 集成). Verified against `main`
`ad6c4e1e4` and the private `mikka-hosted-ui` checkout; no product code names
the three integrations.

## Findings

- **Paper** — no product-code entry anywhere. In the public repo the word is
  unrelated (bot `paper` avatar, docs, tests). In `mikka-hosted-ui` a
  hardcoded `SERVERS.paper` mock MCP server
  (`components/application/settings/settings-tools.tsx:71-77`, used at `:109`)
  renders only inside the BoardUI *template* settings modal
  (`app/multi-agent-chat`, `/templates/project-board`), never the product
  settings 连接 page. It is template filler data owned by the private repo.
- **Revyl** — Figma-only. The only repo mention is
  `docs/research/2026-11-10-capy-desktop-gap.md:81`, which lists "Revyl 云手机"
  among route/API names observed inside Capy's desktop bundle — a Capy
  product capability, not a Mikka one.
- **Tailscale** — Figma-only as a settings integration. The only code-adjacent
  mention is a planned daemon host source (`tailscale status --json` in
  `docs/design/cloud-computer-backend.md:345`) for the add-device flow —
  device discovery on the machine, not an integrations entry.

## Connect-path evidence

The plugin store has no code-owned app list: it renders Composio's live
`toolkits.list` (`lib/plugins/catalog.ts` `listStoreCatalog`, cached 1h) minus
`OWN_INTEGRATIONS` = github/linear/telegram (`lib/composio-accounts.ts:44`,
`components/plugins/connected-apps.tsx:63`). Every connect/detail path
hard-verifies catalog membership at request time:

- `POST /api/integrations/composio {toolkit}` → `assertCatalogToolkit`
  (`app/api/integrations/composio/route.ts:89`, `lib/plugins/catalog.ts:136`):
  the slug must exist in the live catalog with `connect === 'managed'`, else
  `integrationToolkitNotSupported` 400.
- Credential connect resolves Composio's own auth form via
  `readAppDetail` → `toolkits.retrieve`
  (`lib/plugins/credential-connect-server.ts:39-41`,
  `lib/plugins/credential-connect.ts:39-40`): unknown slugs 404.
- App detail `GET .../catalog/[toolkit]` → `fetchAppDetail`
  (`lib/plugins/app-detail.ts:52-55`): unknown slugs 404.

`paper`, `revyl` and `tailscale` are all well-formed slugs, so they would
connect through this generic path *only if* Composio's live catalog lists
them with a supported auth kind — which cannot be verified from the repo
(no Composio key; paid API calls out of scope). The names are Figma copies of
Capy capabilities (Revyl 云手机, Paper, Tailscale/OIDC), which Mikka owns —
if at all — as dedicated features, not store rows.

## Decision

Keep the product list as it is: no code change, nothing removed, nothing
fabricated. The three names remain design-side only; each needs an explicit
owning backend (its own integration contract, or proof that a matching
Composio toolkit exists) before it may appear in product UI. The private
`SERVERS.paper` template row is reported to the coordinator for
`mikka-hosted-ui`; removing or keeping that demo data is a private-repo call,
not a public-repo change.

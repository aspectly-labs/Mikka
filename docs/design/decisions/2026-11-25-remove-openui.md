# Remove OpenUI across Mikka and mikka-hosted-ui

- Date: 2026-11-25
- **Status:** Accepted
- Source: Alex, 2026-11-25: "还有就是我们现在不要用 OpenUI 了，麻烦删掉呢，因为移动端不支持 OpenUI"
- Rule: —
- Supersedes: [2026-10-31-1803-coordinator-openui-prompt.md](2026-10-31-1803-coordinator-openui-prompt.md)

## Decision

Remove OpenUI (`@openuidev/lang-core`, `@openuidev/react-lang`, `@openuidev/react-ui`, `lib/agent-ui-*`, `scripts/generate-agent-ui-prompt.mjs`, generated OpenUI prompt JSONs, and OpenUI UI renderers) across both `Mikka` and `mikka-hosted-ui`.

## Behavior

1. **Markdown-first replies everywhere:** Coordinator and Bot prompts instruct models to reply in clean Markdown (prose, lists, GFM tables, fenced code blocks, Mermaid fences) with native Mikka task/thread/PR citations (`[[issue:<id>]]`, `[[run:<id>]]`, Markdown links) so replies render identically across Web, Desktop and Mobile iOS (`Mikka 2.0.0`).
2. **Dependency-free historical fallback:** Existing stored rows in `coordinator_messages` or `agent_turns` that contain historical OpenUI Lang (`root = Stack([...])`) are projected into readable read-only Markdown/plain text by `lib/legacy-chat-content.ts` with zero `@openuidev/*` runtime dependencies. Historical OpenUI source is never executed and never leaked raw to users in previews, copy actions or mobile push notifications.
3. **Standard build & CI:** `generate:agent-ui` and `check:agent-ui` are retired from local builds, Dockerfiles, Cloudflare builds and CI workflows.

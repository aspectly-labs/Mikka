# Environment instructions, private Bot instructions, and pre-message preview

- **Status:** Accepted

Source: [#3110](https://github.com/aspectly-labs/Mikka/issues/3110), [#2957](https://github.com/aspectly-labs/Mikka/issues/2957) (Frame 16, WS-F).

## Context

Settings Frame 16 extends standing instructions beyond personal (`user_preferences."personalInstructions"`) and workspace-level instructions (P3, [#2974](https://github.com/aspectly-labs/Mikka/pull/2974)) with three capabilities:

1. Environment-scoped standing instructions.
2. Independent private Bot instructions.
3. Pre-first-message instruction context preview before any thread or run exists.

## Decisions

### 1. Dedicated `bots.instructions` column rather than overloading `agents.instructions` or `bots.publicRole`

- Per `AGENTS.md`, *"Bots dispatch work. Agents execute runs."*
- `agents` (`lib/db/schema.ts:455`) models a per-user, per-device local coding CLI harness role (`claude_code`, `codex`, `cursor`). A workspace `bots` entity (`lib/db/schema.ts:175`) runs on Mikka's Eve harness and has no `agents` row.
- `bots.publicRole` (`lib/db/schema.ts:185`) is visible to group chat participants (`lib/group-participants.ts`, `lib/coordinator/group-member-catalog.ts`, `lib/interop/bots.ts`) and explicitly documented as *"never populated from private instructions."*
- Private Bot instructions therefore live in `bots.instructions` (`-- target: MIKKA_DATABASE_URL`, `text NOT NULL DEFAULT ''`, `char_length(instructions) <= 2000`). Only the Bot's owner (or an active workspace administrator for a workspace-shared or orphaned non-Coordinator Bot) may read or write `bots.instructions`; ordinary workspace members, followers, and group chat participants never receive it.

### 2. Environment instructions in the Workspace database (`workspace_environments.instructions`)

- `workspace_environments` lives in the Workspace database (`-- target: DATABASE_URL`), whereas `bots.environmentId` lives in the Application database (`MIKKA_DATABASE_URL`).
- `workspace_environments.instructions` (`text NOT NULL DEFAULT ''`, `char_length(instructions) <= 2000`) is writable by active workspace administrators (rejecting archived environments and stale revisions) and readable by active workspace members.
- Prompt injection rechecks active workspace membership (`withTaskWorkspace`) and requires `archivedAt IS NULL` on every turn.

### 3. Prompt precedence and XML delimiter sanitization

Standing instructions compose in strict specificity order below platform policy:

`Platform rules -> Workspace instructions (P3) -> Environment instructions -> Bot instructions -> Personal instructions`

Each layer strips opening and closing XML instruction section delimiters (`<workspace_instructions>`, `<environment_instructions>`, `<bot_instructions>`, `<personal_instructions>`) before wrapping its section so user- or admin-authored text cannot close a section early or spoof another layer.

### 4. Pre-first-message instruction context preview

`getThreadInstructions` (`app/actions/agents.ts`) inspects `agent_runs.prompt` only after a run exists. `GET /api/settings/instructions/preview` and Desktop RPC `settings.getInstructionPreview` resolve the caller's authorized layers (`workspace`, `environment`, `bot`, `personal`, `memory`) before the first message is sent, enforcing active workspace membership, live environment ownership (`archivedAt IS NULL`), and Bot instruction read permission while omitting internal platform system prompt rules.

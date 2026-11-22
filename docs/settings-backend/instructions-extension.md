# Environment instructions, Bot instructions, and context preview

Stream WS-F ([#3110](https://github.com/aspectly-labs/Mikka/issues/3110), [#2957](https://github.com/aspectly-labs/Mikka/issues/2957), Frame 16) adds environment-level instructions, private Bot instructions, and pre-first-message instruction context preview on top of personal instructions and P3 workspace instructions ([#2974](https://github.com/aspectly-labs/Mikka/pull/2974)).

## Database split and migrations

- **Workspace DB (`DATABASE_URL`)**: `workspace_environments.instructions` (`text NOT NULL DEFAULT ''`, `CHECK (char_length(instructions) <= 2000)`).
- **Application DB (`MIKKA_DATABASE_URL`)**: `bots.instructions` (`text NOT NULL DEFAULT ''`, `CHECK (char_length(instructions) <= 2000)`).

Both migrations are additive and replayable (`ADD COLUMN IF NOT EXISTS`). Rollback reverts application code while retaining the additive columns and stored data.

## REST endpoints and Desktop RPCs

### Environment instructions

- **REST**: `GET /api/workspaces/[workspaceId]/environments/[environmentId]/instructions` and `PATCH /api/workspaces/[workspaceId]/environments/[environmentId]/instructions`
- **Desktop RPC**: `project-resources.getEnvironmentInstructions`, `project-resources.saveEnvironmentInstructions` (plus optional `instructions` in `project-resources.saveEnvironment`)
- **Access**:
  - `GET`: active workspace member (`admin` or `member`).
  - `PATCH`: active workspace `admin` only, with fresh session; rejects archived environments (`409 projectEnvironmentUnavailable`), stale revisions (`409 projectResourceConflict`), ordinary members (`403 workspaceAccessDenied`), non-members (`403 workspaceAccessDenied`), and text exceeding 2000 characters (`400 personalInstructionsTooLong`).

### Private Bot instructions

- **REST**: `GET /api/bots/[botId]/instructions` and `PATCH /api/bots/[botId]/instructions`
- **Desktop RPC**: `bots.getBotInstructions`, `bots.saveBotInstructions` (plus optional `instructions` in `botSettingsSchema` / `OwnedBotSettings` for the owner)
- **Access**:
  - Active workspace membership is required on the Bot's workspace.
  - Allowed for the Bot's owner (`bots.ownerId = caller`), or an active workspace `admin` when the Bot is workspace-shared (`resource_access_policies.visibility = 'shared'`) or orphaned (`bots.ownerId IS NULL`) and not a personal Coordinator (`coordinator_bots`).
  - Ordinary members, Bot followers, and group chat participants are rejected (`403 workspaceAccessDenied` when discoverable, `404 botNotFound` when private); `bots.publicRole` remains the only Bot description exposed to group participants.
  - `PATCH` rejects archived Bots (`409 botNotFound`).

### Pre-first-message instruction context preview

- **REST**: `GET /api/settings/instructions/preview?workspaceId=<uuid>&environmentId=<uuid>&botId=<uuid>`
- **Desktop RPC**: `settings.getInstructionPreview`
- **Access**:
  - Requires authenticated caller; reads only the caller's own `personal` and approved `memory` layers (read-only, without recording fact usage).
  - Verifies active workspace membership for `workspaceId` (or the Bot's workspace / caller's active workspace when omitted).
  - When `environmentId` is supplied, verifies it belongs to that workspace and has `archivedAt IS NULL` (`404 projectEnvironmentUnavailable` otherwise). When `environmentId` is omitted and `botId` is supplied, resolves the Bot's bound live environment if active.
  - When `botId` is supplied, enforces the exact Bot instruction read authorization above so callers cannot snoop another user's private Bot instructions.
- **Response**:
  - `{ workspaceId, environmentId, botId, layers: [{ level, source, sourceId, content, charCount }], mergedPreview }`
  - Layers appear in precedence order (`workspace -> environment -> bot -> personal -> memory`) with XML instruction delimiters sanitized, omitting internal platform system prompt rules.

# Tool calls as Claude, ChatGPT and LobeHub show them

- Date: 2026-11-22 23:00 UTC
- Status: accepted (Alex, 2026-11-22, a series of requests on the Bot chat's tool group; approval for the paid Thread block's tool rows)
- Amends: [2026-11-05-0330-error-causes](2026-11-05-0330-error-causes.md) for tool calls only: a tool call no longer keeps its raw input and output under 「原始数据」. A run's failure line keeps its code under 详情, as that record says.
- Amends: [2026-11-22-2000-chat-look-as-lobehub](2026-11-22-2000-chat-look-as-lobehub.md): the tool rows and their opened panels.

## Context

Alex read a Chinese Bot chat whose tool group showed 「read file · lib/auth/redirect.ts」 (an identifier with its underscore stripped), a crossed box before 「派发任务」, and an opened row of 「参数」 and 「结果」 over raw JSON, then a folded 「原始数据」 with the same JSON again. Claude, ChatGPT, Cursor, LobeHub and AI Elements show none of that.

## Decision

1. **Names.** A tool row names its tool in English, in title form, in every language: `Read file`, `Run command`, `Search`, `Edit file`, `Get issue`, `Dispatch run`, an MCP tool's declared title, else its name spelled out (`lib/tool-title.ts`). The surrounding words (the group's summary, 「1 个失败」, the cut notice) stay translated.
2. **Row.** 13px: the name, what it acted on in 12px mono (a path, a command, `"redirect" in lib/auth` for a search outside the workspace root), the duration at the end. No status glyph: no ✓, ⚠ or spinner on rows or the group's head. A failure is words in the error colour (`Run command · pnpm lint:ui · 退出码 1`); a running row shimmers. No rail beside an opened group; rows and panels span the text's width.
3. **Opened.** One panel, nothing twice, no raw data (LobeHub's renderers): a command is the command then its output; a file read its code; a search its matches; an edit its diff. Any other tool follows AI Elements' Tool: a small 「输入」/Parameters block only when the input holds more than the row shows, then 「输出」/Result or 「错误」/Error. Labels stay in sentence case (R-32), not AI Elements' uppercase.
4. **Mikka's own tools.** Get issue and friends open to the task chip the chat uses for citations, with the task's title; when there is nothing beyond the row, the row does not open. A dispatch never opens: its 子 Agent card stands under the reply.
5. **Whole output.** The Bot chat's reads keep 200-character previews. Opening a row reads that one call's whole input and output, each cut at 64 KB with 「输出过长，只保留了一部分」, through an owner-only read (`coordinatorToolCall`, `lib/coordinator/tool-call-read.ts`).
6. **Glyph.** A delegate row draws hugeicons' paper plane; the network glyph it had read as a crossed box at 13px.

## Consequences

- The paid Thread block's tool rows change only through `styles/globals.css` (status glyphs hidden, rail removed, row type and shimmer) and the slot's data; no patch was added.
- The run failure line's 详情 (the raw code) is unchanged; it is not a tool's raw data.

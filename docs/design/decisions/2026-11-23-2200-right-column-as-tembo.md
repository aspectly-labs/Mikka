# The right column as Tembo: one level of tabs, no Overview

- Date: 2026-11-23 22:00 UTC
- **Status:** Accepted (Alex, 2026-11-23: 「Tembo 没有做 overview，我们也不做了，做成他们这种，一目了然」; approval for the paid App Shell's work-area strip and menus)
- Supersedes: the right column's Overview tab and its inner 详情 / 任务 / PR / 电脑 tabs (#2927).

## Context

The right column beside a conversation opened on an Overview tab that held the Bot's profile, a glance and three more tabs of its own (tasks, pull requests, the computer), while Changes, Files, Setup and the browser were tabs beside it. Two levels of tabs, a profile editor in a side column, and a ＋ menu grouped into 常用 / 相关 / Crew made the column hard to read at a glance. Tembo's web app shows the same kinds of pages as one flat row of tabs, a small ＋ popover and, with nothing open, a list of what can be opened.

## Decision

1. **One tab level.** The column's tabs are kinds, in this order: Changes, Pull requests, Tasks, Computer, Files, Setup, Browser (a terminal joins when Mikka has one). Each has an icon, a name and a one-line description (`messages/*.json`, `RightColumn.kinds`). A kind opens at most once; opening an open kind brings it to the front. Nothing inside a tab has tabs of its own. The tasks and threads the chat opens still open as their own tabs.
2. **No Overview.** A Bot's profile and settings live in its 「Bot 资料」 sheet (the Bot menu). The Coordinator's crew lists are its Tasks and Pull requests.
3. **Strip.** 28px pills with a 16px icon and the name cut with a fade; the one in front is the block's raised card, the others a light fill. The close button appears over the pill's end on hover or focus and takes no width. ＋ follows the last tab and is gone when every kind is open.
4. **＋ popover.** About 208px: a search field, then one row per kind not yet open. Arrow keys wrap, typing filters, Enter opens, Esc closes.
5. **Launcher.** With no tab open the column's body lists every kind with its description; it is not a tab. Rows take a visible focus ring and arrow keys.
6. **First open.** The tab last in front for this conversation on this device; else its changes or its pull request; else the launcher. The browser never opens by itself.
7. **Menus** follow the same reference: one open submenu per level, opened on hover after 100ms or by click, Enter, Space or →, kept open while the pointer travels toward it, closed by another row, ← or Esc; a multi-select menu stays open on a pick; a native tooltip only where the text is cut off; menus are drawn above any clipping container.

## Consequences

- The paid App Shell's work-area strip, its ＋ popover and the launcher change only behind the shell's opt-in for Mikka's frame, through one recorded patch in the private UI; the block's demo keeps its shipped strip.
- The panel width and the Thread's reading width return to the block's shipped values.
- A guard in the private UI (`scripts/paid-overrides.mjs`) now fails a change that restyles a paid block without a recorded approval; the desktop release runs it before building the overlay in.

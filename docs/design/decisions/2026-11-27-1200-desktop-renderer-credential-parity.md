# Desktop renderer: web parity for credentials the server mints

- Date: 2026-11-27
- **Status:** Accepted
- Source: owner decision, 2026-11-27 (desktop routes lane): the desktop app keeps no client-side API route list; the server's authorization is the boundary, as on the web. The independent security review of that change (MERGE AFTER FIXES) asked for this record.
- Supersedes in part: [2026-11-05-1615-desktop-bundled-renderer](2026-11-05-1615-desktop-bundled-renderer.md), its sentence "Neither the session credential nor a live-push ticket belongs in the renderer", for credentials the server newly mints. The rest of that record stands.

## Decision

The desktop renderer calls the same API routes as the web renderer, through
main's proxy (`apps/desktop/src/main/bundled-protocol.ts`). Main forwards any
normalized `/mikka/api/…` path from the app's own origin to the current
account's server and no other place, and the server decides what the person
may do. Main keeps no list of routes it allows or refuses.

So the credential-minting routes are reachable from the desktop renderer
exactly as they are from a browser tab on the web:

- `one-time-token` (`/api/auth/one-time-token/generate`);
- the live-push ticket (`/api/live/ticket`);
- device enrollment (`/api/devices/enrollment`);
- the computer viewer and takeover grants (`/api/bots/[botId]/computer/viewer`,
  `/api/bots/[botId]/computer/takeover`, `/api/bots/[botId]/subagents/[id]/viewer`).

A credential one of these routes mints for the signed-in person reaches the
renderer, as it reaches the web page. The 2026-11-05 sentence no longer holds
for these: the renderer can hold a live ticket or a one-time token. A
client-side refusal list was rejected because it is one more list to keep in
step with the server, and it protects nothing the web does not already expose
to the same page.

## What does not change

- Main never hands the renderer the session credential it holds. The bearer
  token and the signed session cache stay in main and the OS keychain; no IPC
  carries them. Every proxied response (headers and the body stream) is checked
  for any credential main holds, and a response that carries one is cut off
  with `desktop_credential_withheld` before the renderer reads it
  (`withholdCredentials` in `bundled-protocol.ts`).
- Main's proxy only reaches the account's own server: the path is checked
  before and after percent-decoding, and the URL main builds must have the
  account's origin and exactly the checked path under the server's base path
  (`fetchAs` in `apps/desktop/src/main/bundled-auth.ts`).
- Opaque artifact frames and browser frames are other origins and cannot use
  main's session. Every proxied response carries a `sandbox` CSP.

## Follow-up

- **Stop session tokens reaching the desktop renderer** (server side): a
  server route that returns the session token in its body or headers is still
  only caught by main's stream guard. The follow-up makes the server never send
  it to a desktop client, so the guard becomes a second line rather than the
  only one.

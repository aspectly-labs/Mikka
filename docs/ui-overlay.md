# UI slots

The [One UI slot inventory](design/one-ui-slot-inventory.md) lists each Web/Desktop binding, its production imports, and its migration decision under Epic [#1646](https://github.com/alexj11324/Mikka/issues/1646).

There is one UI ([decision 2026-11-08-2133](design/decisions/2026-11-08-2133-one-ui.md)).

**Build ownership:** The public Mikka workspace is the source and root of an official build. A trusted Cloudflare release environment can obtain this private overlay read-only at its selected SHA and set `MIKKA_UI_OVERLAY_DIR=.hosted-ui` in that public checkout. The private location of paid UI code does not require CI or the product build to *start* in the private repository. The current private-triggered OCI process is a temporary migration implementation, not the target architecture. See [build source of truth](operations/build-source-of-truth.md).
**Target decoupling ([decision 2026-11-22-2205](design/decisions/2026-11-22-2205-headless-public-engine-and-ui-decoupling.md), [#3174](https://github.com/aspectly-labs/Mikka/issues/3174)):** Public `Mikka` is transitioning in phases to a headless engine/API/daemon core while the product Web UI moves to a standalone app in `mikka-hosted-ui`. Keep `@ui-slot/*` contracts and public UI files intact throughout Phases 1–3 until the release pipelines (`apps/api`, `cloudflare-api-image.yml`, `#1954`) cut over.
Its code lives in this repository and in the private `alexj11324/mikka-hosted-ui`.
Slots are how official web and desktop builds bring the private code in
([decision 2026-11-06-2000](design/decisions/2026-11-06-2000-hosted-ui-overlay.md)).
Paid component source (BoardUI Pro, affectUI, beUI Pro) lives only in
`mikka-hosted-ui`; this repository never imports it. The build pipeline that
checks the private repository out is issue #1527.

Use an existing page or slot when it owns the change.

A public checkout builds a runnable self-hosted server with its authentication,
server status and connection pages. The official client connects to that server
for the workspace. A fork can build, start and test the server without a private
checkout or credentials. See the [self-hosting guide](self-hosting.md).

## Renderer source selection

| Binding | Public server and compile-time contracts | Official Web and Desktop |
| --- | --- | --- |
| `MIKKA_UI_OVERLAY_DIR` | unset (or ignored by `--server-pages`) | path of the `mikka-hosted-ui` checkout, inside this repository (CI uses `.hosted-ui/`, which is gitignored) |
| `@ui-slot/<name>` | `components/slots/<name>.tsx` | `$MIKKA_UI_OVERLAY_DIR/slots/<name>.tsx` for the 2 entry slots (`auth-sso` and `workspace-entry`) in an official release |
| `@hosted/*` | does not resolve | `$MIKKA_UI_OVERLAY_DIR/*` |

`lib/ui-overlay.mjs` decides this once. The shared Vite plugin
(`apps/frontend/scripts/application-plugin.mjs`) applies it to both Web and
desktop renderer builds, and `apps/frontend/scripts/shared-styles.mjs` injects
Tailwind CSS v4 `@source` directives into `app/globals.css` and
`apps/desktop/src/renderer/styles.css` for the overlay's `web/`, `slots/`, and
`lib/` subdirectories (leaving `.hosted-ui/components/` to `overlay.css`'s
`components` layer). Pure headless `--server-pages` builds (`pnpm build:server-pages`)
ignore overlay environment variables and swap `apps/desktop/src/renderer/workspace-loader.ts`
for `apps/frontend/src/web/server-workspace-loader.ts`, so `@ui-slot/workspace-entry`
and `.hosted-ui/**` are never loaded or scanned. Public shared pages render bot
avatars directly through `components/nav/bot-avatar.tsx` with no legacy
`@ui-slot/*` dependency.
Production uses the [shared frontend/API runtime](operations/web-runtime.md).
`tsconfig.json` maps `@ui-slot/*` to the public contracts for type checking.
`pnpm build:server` produces the public installation. Renderer tests may select
`--public-test-fixture` explicitly.

Official release builds pin `MIKKA_UI_OVERLAY_DIR` and the matching 40-character
`MIKKA_UI_OVERLAY_SHA`. The directory must be inside the public checkout and
resolves React and shared application modules from its `node_modules`. An invalid
checkout, missing required provider, or missing required export fails the official
build. Unpinned development layers may fall back to the public no-content contract for
`auth-sso`; `workspace-entry` is always required whenever `MIKKA_UI_OVERLAY_DIR`
is set.

## Slots

| Slot | Surface | Props | Callers import |
| --- | --- | --- | --- |
| `auth-sso` | Enterprise: company SSO entry on the sign-in page (web sign-in only) | `AuthSsoProps` in `components/slots/auth-sso-contract.ts`; `signInWithSso` in `hooks/settings/use-organization.ts` | `AuthForm` (`SignInCard`) through `@ui-slot/auth-sso` (public no-content contract) |
| `workspace-entry` | Authenticated Web and Desktop application entry (`Workspace`), owning the workspace shell, screens, and hosted web modules under `@hosted/web/**` | `WorkspaceEntryProps` (`user`, `bootstrap`, `livePreparation`) in `components/slots/workspace-entry-contract.ts` | `apps/desktop/src/renderer/workspace-loader.ts` dynamically imports `@ui-slot/workspace-entry` (`Workspace`); public stub throws `SERVER_DOCUMENT_CANNOT_LOAD_WORKSPACE` and `--server-pages` swaps the loader |

The layer exports the named component required by `UI_SLOT_EXPORTS` (`AuthSso` and `Workspace`),
accepts the same props contract, and marks UI providers with `'use client'`.

**Required exports.** Web and Desktop link the runtime names in `UI_SLOT_EXPORTS` against each selected provider (`auth-sso` and `workspace-entry`). The production entry validates every registered export at bundle time without eagerly executing lazy workspace initialization in the unauthenticated startup chunk. A missing export fails compilation. CI tests positive and negative linking cases with synthetic slots, so forks need no private source.

When a slot export changes, update its contract in this repository, publish the compatible export in the private layer while the current public revision still works, and then update `UI_SLOT_EXPORTS` and `PUBLIC_CONTRACT_SLOTS` in `lib/ui-overlay.mjs`.

## iOS app

Both App Store profiles select the private mobile checkout, including the default `production` profile used by the EAS CLI. The official release workflow also checks the contents of the source archive before invoking EAS. To recover a completed build, provide its EAS build ID and main source commit. The workflow finds the original native run and checks its protected archive, private revision and runtime fingerprint against the EAS build before submitting. A failed TestFlight submission remains recoverable while the original artifact is available.

The iOS app (`apps/mobile`) has its own slots, filled from the layer's
`mobile/` folder. They are React Native components, so they share nothing with
the web slots but the idea.

| | Build without `mikka-hosted-ui` | Official OTA |
| --- | --- | --- |
| `MIKKA_MOBILE_OVERLAY_DIR` | unset | `.hosted-ui/mobile`, relative to the repository root and inside it |
| `@ui-slot/<name>` | `apps/mobile/slots/<name>.tsx` | `$MIKKA_MOBILE_OVERLAY_DIR/slots/<name>.tsx` (required in a configured layer) |
| `@hosted/*` | does not resolve | `$MIKKA_MOBILE_OVERLAY_DIR/*` |

`apps/mobile/ui-overlay.js` decides this and `apps/mobile/metro.config.js`
applies it as Metro's `resolveRequest`. Every other import in a layer file
resolves as if from `apps/mobile`, so the layer uses the app's `react`,
`react-native`, `react-native-svg` and `react-native-reanimated` and installs
no packages of its own. `@/` in the layer is `apps/mobile` (for example
`@/lib/bot-look`, `@/slots/bot-avatar-contract`). `apps/mobile/tsconfig.json`
maps `@ui-slot/*` to the defaults, so typecheck always sees the open-source
build. A set but missing directory fails the bundle.

| Slot | Surface | Props | Callers import |
| --- | --- | --- | --- |
| `bot-avatar` | the still blob with one eye | `BotAvatarProps` in `apps/mobile/slots/bot-avatar-contract.ts` (`color`, `shape`, `size`; `id` and `coordinator` when the caller has them, as on the web); colours and shapes in `apps/mobile/lib/bot-look.ts` | `BotAvatar` from `@/components/icons` |

Required exports are `MOBILE_SLOT_EXPORTS` in `apps/mobile/ui-overlay.js`;
the same rule as the web applies (merge the layer's export first).

`mobile-update.yml` obtains the production Expo and UI-checkout credentials through the trusted main workflow. A production OTA requires the private mobile folder and its native slots. The native TestFlight workflow selects a reviewed overlay revision for its hosted production build. The public native source and contract tests can run without private credentials.

## Rules for the layer

- **Imports.** BoardUI's own source imports its files with `@/` (for example
  `@/components/base/...`, `@/utils/cx`). Here `@/` is this repository, so
  inside the layer those imports are written `@hosted/...`. The layer's
  `pnpm bdui add <name>` rewrites them after each add (see its `CLAUDE.md`).
  `@/` in the layer means this repository: use it for this app's types,
  server actions (`@/app/actions/*`), and contracts, such as `@/components/slots/workspace-entry-contract` and `@/components/slots/auth-sso-contract`.
  Inside desktop renderer builds (`apps/frontend/scripts/application-plugin.mjs`), `@hosted/web/hooks/use-feature-availability` (and `@/hooks/use-feature-availability`) aliases to `apps/desktop/src/renderer/feature-availability.ts`.
- **Styles.** The layer has one style entry, `styles/overlay.css`, which its
  slots import for paid component styles (`layer(components)`). Its utilities sit in the `components` layer, below this app's
  `utilities`: a class both apps generate (`hidden`, `md:grid`) keeps this
  app's order. A layer class that must win over one of this app's utilities
  is marked important (`bg-transparent!`). It holds BoardUI's theme tokens and fonts and an `@source` for
  the layer's paid component files. Because `.hosted-ui` is gitignored, `apps/frontend/scripts/shared-styles.mjs` automatically injects `@source` directives into `app/globals.css` and `apps/desktop/src/renderer/styles.css` for the overlay's `web/`, `slots/`, and `lib/` directories during non-`--server-pages` builds (while skipping `.hosted-ui/components` so BoardUI CSS stays in `overlay.css`'s `components` layer). `overlay.css` does not import BoardUI's `globals.css`
  base reset or the shadcn block of its `globals.css` (whose tokens share this
  app's names). A few of BoardUI's theme variables share a name with this
  app's (`--font-sans`, `--color-blue-400`); this app's utilities inline their
  own values, so pages outside the slots look the same in both builds.
  Paid blocks in the layer keep their shipped look and only data and text
  change ([2026-11-09-0050](design/decisions/2026-11-09-0050-paid-blocks-as-shipped.md)). Because the
  shadcn token block is left out, affectUI blocks currently resolve shadcn
  token names to this app's values; that is recorded drift, not a rule to
  follow.
- **Dependencies.** Packages BoardUI needs that this repository lacks are
  installed in the layer. `react` and `react-dom` come from this repository
  only.
- **Source maps.** No public output of an official build may carry the
  layer's source (issue #1527, item 5).

### Shared chat screen (#2913)

Every chat entrance calls `ThreadScreen`. The `host` identifies its containing surface without selecting a new style. The original official thread presentation remains in the official provider; group and Artifact transcript presentations share the public `ThreadTranscript` renderer through that same provider. This renderer contains only the existing public primitives. The readers still own history, delivery, unread state and callbacks; keyed rows, the scroll container and composer placement belong to the screen. Optional message nodes carry existing event/card contents, not another list.

The optional `transcriptLabel` names the existing native transcript viewport as a region. Coordinator readers supply their existing conversation translation, as they do for embedded transcripts. While the first read is pending, `loadingLabel` gives the existing empty transcript column its waiting status and busy state. A resolved or failed read removes that state; any existing message keeps the column's original log role, conversation name and streaming busy state. Providers add no wrapper or visible content for these labels.

An error part's optional `failure` identifies the current `live` or `welcome` failure. Providers pass it to `data-message-failure` on their existing error line, without adding an element or changing its contents. Historical failures keep the `past` marker in the supplied recovery notice; the surrounding error line does not duplicate it.

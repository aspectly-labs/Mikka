# The official UI checkout

There is one UI ([decision 2026-11-08-2133](design/decisions/2026-11-08-2133-one-ui.md)), and all of its web and
desktop code lives in the private `mikka-hosted-ui` repository
([decision 2026-11-24-1000](design/decisions/2026-11-24-1000-all-ui-in-hosted.md)). This repository is the engine,
API, runtime and build; it carries no interface of its own (`scripts/no-public-ui.test.mjs`).

**Build ownership:** The public Mikka workspace is the source and root of an official build. A trusted release
environment checks the private repository out read-only at its selected SHA into `.hosted-ui` (git-ignored) and sets
`MIKKA_UI_OVERLAY_DIR=.hosted-ui` and `MIKKA_UI_OVERLAY_SHA`. See [build source of truth](operations/build-source-of-truth.md).
Paid component source (BoardUI Pro, affectUI, beUI Pro) lives only in `mikka-hosted-ui`; this repository never imports it.

## What the build compiles

| | Build without the checkout | Official Web and Desktop |
| --- | --- | --- |
| `MIKKA_UI_OVERLAY_DIR` | unset | the checkout, inside this repository |
| `mikka:application` | `apps/frontend/src/headless.ts`, a page that says this server has no interface | `core/renderer/index.tsx` in the checkout |
| `mikka:platform` | not available | `core/renderer/platform.tsx` (desktop), `core/renderer/web/platform.tsx` (web) |
| stylesheet | none | `core/app/globals.css` and `core/renderer/styles.css` |
| `@hosted/*` | does not resolve | the checkout's own files |

`lib/ui-overlay.mjs` decides this once (`OVERLAY_APPLICATION` lists the files an official checkout must carry) and
`apps/frontend/scripts/application-plugin.mjs` applies it to both Web and Desktop. `apps/frontend/src/index.ts`
loads the runtime and then `mikka:application`. `apps/frontend/scripts/shared-styles.mjs` names the checkout's
`core/`, `web/`, `slots/` and `lib/` directories for Tailwind, because a git-ignored directory is skipped by its
automatic source detection. `@ui-slot/*` is retired for web and desktop; the build refuses it (`UI_SLOT_RETIRED`).

The checkout's `core/` holds the interface that used to live here at the same relative paths: `core/components/`,
`core/hooks/`, `core/app/globals.css` and `core/app/fonts/`, the React pieces of the client runtime under
`core/lib/`, and the client application under `core/renderer/`. It imports this repository's runtime, API clients
and contracts through `@/`; nothing here imports it, except the build glue and its tests.

A build without the checkout only has to compile. Its server answers a browser with the headless page; the official
clients connect to it. A dev-flavour desktop build without the checkout shows the same page so the native shell can
be accepted in public CI (`apps/desktop/test/bundled-smoke.mjs`); a production desktop build refuses.

Official release builds pin `MIKKA_UI_OVERLAY_DIR` and the matching 40-character `MIKKA_UI_OVERLAY_SHA`. The
directory must be inside the public checkout and resolves React and shared application modules from its
`node_modules`; the checkout installs no second copy of a package the runtime shares (`react`, `swr`, `sonner`).
A missing application file fails the build.

## Tests and rules across the two repositories

The UI policies here (`pnpm lint:ui`, `pnpm test:ui-policy`) read the checkout's `core/` through
`scripts/official-ui-tree.mjs`, at the paths the files had here, and skip what they cannot see without it. The web
and desktop build tests that need the real interface skip without `MIKKA_UI_OVERLAY_DIR`. `mikka-hosted-ui`'s CI
runs all of them against its own commit (`scripts/core-ui.test.mjs` there), with this repository's branch of the
same name around it.

## Paired changes: merge order

A change that touches both repositories ships as two PRs with the same branch
name: the public PR and the `mikka-hosted-ui` PR. The overlay's CI tests against
the public branch of the same name while it exists, and against public `main`
once it is merged.

Merge them in this order:

1. **Public PR first.** Public `main` must build on its own, so it may not wait for
   anything in the overlay. Messages, contracts and slot props the overlay uses
   land here.
2. **Then the hosted PR.** Its CI now runs against public `main`, which holds the
   public half.
3. **Then the pin.** Only now does the `mikka-cloud` PR move `overlaySource` in
   `deploy-build-inputs.json` to the hosted merge commit. A pin that points at an
   overlay whose public half is not on `main` fails the release build (as
   mikka-cloud #447 did before #3188 merged), and its pairing check refuses it.
4. **Release.** API (with its migrations) before Web, because the new Web calls the
   new actions and reads the new tables.

Reverting goes the other way: move the pin back first, then revert the hosted PR,
then the public one.

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
  `@/` in the layer means this repository: use it for this app's runtime, types,
  server actions (`@/app/actions/*`) and API clients.
  Inside desktop renderer builds (`apps/frontend/scripts/application-plugin.mjs`), `@hosted/web/hooks/use-feature-availability` aliases to `apps/desktop/src/renderer/feature-availability.ts`.
- **Styles.** The layer has one style entry, `styles/overlay.css`, which its
  slots import for paid component styles (`layer(components)`). Its utilities sit in the `components` layer, below this app's
  `utilities`: a class both apps generate (`hidden`, `md:grid`) keeps this
  app's order. A layer class that must win over one of this app's utilities
  is marked important (`bg-transparent!`). It holds BoardUI's theme tokens and fonts and an `@source` for
  the layer's paid component files. Because `.hosted-ui` is gitignored, `apps/frontend/scripts/shared-styles.mjs` injects `@source` directives into the checkout's `core/app/globals.css` and `core/renderer/styles.css` for its `core/`, `web/`, `slots/` and `lib/` directories (skipping `.hosted-ui/components` so BoardUI CSS stays in `overlay.css`'s `components` layer). `overlay.css` does not import BoardUI's `globals.css`
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

Every chat entrance calls `ThreadScreen`. The `host` identifies its containing surface without selecting a new style. Every chat, a group included, is the one official thread presentation: a group's members and Bots are entries with their own `author` (decision 2026-11-22-1510-group-chat-as-bot-chat). The readers still own history, delivery, unread state and callbacks; keyed rows, the scroll container and composer placement belong to the screen. Optional message nodes carry existing event/card contents, not another list.

The optional `transcriptLabel` names the existing native transcript viewport as a region. Coordinator readers supply their existing conversation translation, as they do for embedded transcripts. While the first read is pending, `loadingLabel` gives the existing empty transcript column its waiting status and busy state. A resolved or failed read removes that state; any existing message keeps the column's original log role, conversation name and streaming busy state. Providers add no wrapper or visible content for these labels.

An error part's optional `failure` identifies the current `live` or `welcome` failure. Providers pass it to `data-message-failure` on their existing error line, without adding an element or changing its contents. Historical failures keep the `past` marker in the supplied recovery notice; the surrounding error line does not duplicate it.

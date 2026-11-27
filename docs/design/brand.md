# Brand: the Mikka mark

Mikka has one mark: a geometric ribbon M built on an exact 3:2 grid (Figma
`12Yn4bNPchBdDvdIb83KER`, nodes `1:127`, `1:128`, `1:154`;
[decision 2026-11-24-2235](decisions/2026-11-24-2235-new-mikka-ribbon-mark.md)).
The previous 5×5 dot-grid M is retired and deleted. This page says where the
mark goes, its exact vector coordinates, how big it is, and what color it takes.

## Canonical vector coordinates

Do not redraw or approximate the path:

- **Pure 3:2 mark** (`viewBox="0 0 630 420"`):
  `M0 0H210V210L0 420V0ZM210 210L420 0H630V420L420 210L210 420V210Z`
- **Inline square UI mark** (`viewBox="0 0 24 24"`, exact 3:2 integer coordinates at `x=3, y=6, w=18, h=12`):
  `M3 6H9V12L3 18V6ZM9 12L15 6H21V18L15 12L9 18V12Z`
- **1024×1024 App Icon master** (`viewBox="0 0 1024 1024"`, mark at `x=197, y=320, w=630, h=420`):
  `M197 320H407V530L197 740V320ZM407 530L617 320H827V740L617 530L407 740V530Z`

## Assets

| File | Use |
| --- | --- |
| `public/brand/mikka-icon-light.svg` | `#080808` ribbon mark for light backgrounds (README, docs), `1024×1024` transparent canvas with Figma `1:127` padding. |
| `public/brand/mikka-icon-dark.svg` | `#FFFFFF` ribbon mark for dark backgrounds (README, docs), `1024×1024` transparent canvas with Figma `1:127` padding. |
| `public/brand/mikka-app-icon-{48,96,192}.png` | Default `#FFFFFF` tile with `#080808` mark for browser tabs. |
| `public/favicon.ico` | Browser fallback with `16px`, `32px`, and `48px` sizes. |
| `public/apple-icon.png` / `app/apple-icon.png` | `180px` unmasked `#FFFFFF` / `#080808` home-screen icon. |
| `app/icon.svg` | Canonical theme-switching inline square SVG (`viewBox="0 0 24 24"`, `#080808` light / `#FFFFFF` dark). |
| `apps/desktop/build/icon.icon/` | Apple Icon Composer bundle (`Assets/mark.svg` + `icon.json` `fill-specializations`: Default `#FFFFFF`/`#080808`, Dark `#1C1C1E`/`#FFFFFF`, Tinted/Clear `#FFFFFF`), also verified for iOS by `.github/workflows/app-icon.yml`. |
| `apps/desktop/build/icon.png` | `1024×1024` unmasked opaque RGB Default master (`#FFFFFF` background, `#080808` mark). |

In product UI, inline the SVG using the `viewBox="0 0 24 24"` square path (or
the pure `0 0 630 420` path when laying out at 3:2) instead of rendering the
`1024×1024` padded files inside small `<img>` boxes. Vite copies the browser
and home-screen assets from `public/`; the app shell declares them under
`/mikka/`.

## Color

- **Default (Light) App Icon**: canvas `#FFFFFF`, mark `#080808`.
- **Dark App Icon**: canvas `#1C1C1E`, mark `#FFFFFF`.
- **Tinted / Clear App Icon**: monochrome `#FFFFFF` glass mark.
- **Product UI**: use `fill="currentColor"` so the mark inherits text color and
  switches automatically between Light and Dark themes. Do not ship two bitmap
  or SVG images toggled with `dark:hidden`.
- Never tint the inline mark with an accent color, gradient, or drop shadow.

## Sizes

Inside a paid block's logo slot (for example the hosted sign-in card) the
mark takes the size and placement of the reference product's sign-in, and the
block is edited to match
([2026-11-27-1409](decisions/2026-11-27-1409-top-products-over-paid-blocks.md)).

| Placement | Size | Notes |
| --- | --- | --- |
| Bot list / rail header (top left) | 28px | Mark only, no "Mikka" wordmark. Same height as the header's `+` button (`h-7`). |
| Sign-in / sign-up (`auth-logo.tsx`) | 24px | Mark plus "Mikka" in `text-lg font-semibold`, gap 10px (`gap-2.5`). |
| Native sign-in | 56pt | Geometric ribbon mark (`mobile-next/apps/mobile/src/components/BrandMark.tsx` in `mikka-hosted-ui`) above the 30pt "Mikka" wordmark, gap 12pt. |
| Onboarding welcome | 56px | Mark only, centered above the "欢迎来到 Mikka" title. |
| Browser tab | 16 / 32 / 48px | ICO fallback and PNG sizes 48, 96, and 192px. |

## Implementation status

- Official Web and iOS (`mobile-next`) mark components live in `mikka-hosted-ui`
  (`components/mikka/brand-mark.tsx`, `core/components/brand/mikka-mark.tsx`,
  `mobile-next/apps/mobile/src/components/BrandMark.tsx`) and share the exact
  same Figma `12Yn4bNPchBdDvdIb83KER` vector coordinates and `icon.icon` bundle
  with `app/icon.svg` and `apps/desktop/build/icon.icon/`. Legacy 1.x
  `apps/mobile` was deleted from the public repository
  ([decision 2026-11-25-0915](decisions/2026-11-25-0915-delete-legacy-apps-mobile.md)).

## Clear space

Keep at least 25% of the mark's height as clear space on all sides (matching
the 18×12 mark inside the 24×24 square box). No button, text, or edge enters
that space.

## Wordmark

Write "Mikka" as plain text in the app font, never as an image. Use it only
where a newcomer meets the product: the sign-in page and the website. Inside
the app the mark stands alone.

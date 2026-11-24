# Replace 5×5 dot-grid logo with geometric ribbon M

- Date: 2026-11-24
- Source: Alex's directive ("我们的新图标，麻烦替换之前旧logo，旧logo删掉") and authoritative Figma source `12Yn4bNPchBdDvdIb83KER` (`Page 1`, nodes `1:127`, `1:128`, `1:154`, `1:158`).
- Rule: `docs/design/brand.md`
- Replaces: the 5×5 dot-grid M mark across Web, Desktop, and iOS, and supersedes the black-background dot-grid artwork in [2026-11-12-0449-browser-app-icon.md](2026-11-12-0449-browser-app-icon.md) (while retaining the static PNG + ICO browser and home-screen delivery contract under `/mikka/`).

## Decision

1. **Single authoritative vector**: Every Mikka mark uses the exact 3:2 geometric ribbon M from Figma `12Yn4bNPchBdDvdIb83KER` without coordinate modification:
   - Pure 3:2 (`viewBox="0 0 630 420"`): `M0 0H210V210L0 420V0ZM210 210L420 0H630V420L420 210L210 420V210Z`
   - Inline square (`viewBox="0 0 24 24"`, `x=3, y=6, w=18, h=12`): `M3 6H9V12L3 18V6ZM9 12L15 6H21V18L15 12L9 18V12Z`
   - App Icon master (`viewBox="0 0 1024 1024"`, `x=197, y=320, w=630, h=420`): `M197 320H407V530L197 740V320ZM407 530L617 320H827V740L617 530L407 740V530Z`
2. **Official App Icon appearances**:
   - **Default (Light)**: `#FFFFFF` canvas, `#080808` mark.
   - **Dark**: `#1C1C1E` canvas, `#FFFFFF` mark.
   - **Tinted / Clear (iOS 26/27 & macOS 26)**: `#FFFFFF` monochrome glass mark via Apple Icon Composer `fill-specializations` over a single `Assets/mark.svg` layer.
3. **Complete deletion of the old logo**: Delete every old 5×5 dot-grid SVG, PNG, `icon.icon/Assets/{on,off}.svg`, legacy dot-grid acceptance screenshots (`docs/acceptance/app-icon-ios26/*.png`), unused placeholder logos, and 25-circle component definitions across both public `Mikka` and private `mikka-hosted-ui`. Frozen `docs/design/decisions.md` remains untouched historical provenance.

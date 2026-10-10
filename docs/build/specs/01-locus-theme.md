# 01 — Locus brand theme + theme switcher redesign

## Goal
Docs shared inside Locus should be readable in the Locus brand (Montserrat, deep purple/cream palette) in light and dark.
The 4-step theme cycle button is replaced by a light/dark toggle plus a "Style" menu (Default / GitHub / Locus), so any
look is one or two deliberate clicks away instead of a blind cycle.

## Scope / Out of scope
In: `ThemeMode` gains `locus-light | locus-dark`; app-wide tokens for Locus; Locus preview typography/tables/code;
mermaid `base` theme with brand series colours; HTML-iframe brand signal; switcher UI + keyboard model; persistence;
migration of existing tests that assume the 4-step cycle.
Out: per-doc author-chosen theme; changing the Default or GitHub looks; restyling user HTML documents (we only signal);
mobile header layout (#5); reader font size/width (#18).

## Current state
- `src/types/index.ts:56` — `ThemeMode = 'light' | 'dark' | 'github-light' | 'github-dark'`.
- `src/composables/useTheme.ts:5` `THEME_CYCLE` (4 entries), `:17` `nextTheme`, `:26` `THEME_META` titles describe the
  *next* theme, `:45` `applyTheme` toggles `html.dark` / `html.github-theme` and enables one github-markdown-css `<link>`.
- `src/composables/usePersistence.ts:196-211` `useThemePersistence`: key `md-review-theme`, default from
  `prefers-color-scheme`; `localStorage` reads/writes are NOT wrapped in try/catch.
- `src/style.css:1-61` tokens for `:root`, `html.dark`, `html.github-theme`, `html.dark.github-theme`; `.btn-primary`
  `:89` = `--text-primary` bg. Fonts: `index.html:10` loads Crimson Pro, DM Sans, JetBrains Mono only.
- `src/components/HeaderBar.vue:203-212` single `.btn-icon` that emits `nextTheme(theme)`; icon = moon/sun/GitHub mark.
- `src/components/PreviewPane.vue:30` `mermaidTheme()` returns `'dark' | 'neutral'`; `:219` `mermaid.initialize({theme})`;
  default-look rules are `.preview-pane:not(.github-mode) :deep(...)` (`:409-711`); h1 has `border-bottom` (`:425`);
  blockquote has a 3px left stripe (`:488`); `.comment-highlight` 2px stripe (`:540`).
- Iframe bridge: `PreviewPane.vue:88-93` accepts only `__mdreview_theme: 'dark'|'light'` and stamps `data-theme`;
  parent posts it from `:150-157` and on every theme change (`:229-237`).
- Tests assuming the cycle: `tests/composables/useTheme.test.ts:19-28`; `tests/e2e/app.test.mjs:67-79, 1114-1166,
  1183-1206, 1208-1235`; first-click-is-dark usages at `app.test.mjs:87,113,475,785` and `tests/e2e/mermaid.test.mjs:68`.

## Behaviour
1. `ThemeMode` = `light | dark | github-light | github-dark | locus-light | locus-dark`. A theme = style × dark flag:
   style `default` → `light|dark`, `github` → `github-*`, `locus` → `locus-*`.
2. `useTheme.ts` exports (pure, unit-testable): `ALL_THEMES` = the 6 values in the order above; `isValidTheme(v)`;
   `isDark(t)` (true for `dark`, `github-dark`, `locus-dark`); `isGithub(t)`; `isLocus(t)`; `themeStyle(t)` →
   `'default'|'github'|'locus'`; `themeFor(style, dark)` → ThemeMode; `toggleDark(t)` → same style, flipped dark flag.
   `THEME_CYCLE` and `nextTheme` are removed.
3. `applyTheme(t)` sets on `<html>`: class `dark` iff `isDark(t)`; class `github-theme` iff github; class `locus-theme`
   iff locus (never both github-theme and locus-theme); attribute `data-theme-style="default|github|locus"`.
   github-markdown-css links stay disabled unless the theme is a github one (unchanged rule).
4. Persistence: same key `md-review-theme`; every legacy stored value stays valid. Unknown/corrupt value → default from
   `prefers-color-scheme` (`dark` or `light`, i.e. Default style). All `localStorage` access is in try/catch; when
   storage throws, the app still themes correctly and switching still works for the session.
5. Switcher (`ThemeSwitcher.vue` in the header right group, always rendered whenever the header is; position per
   00 §2.2; the Style menu is an `AppMenu`, 00 §3.2). DOM order: toggle, then Style trigger.
   - Toggle `data-testid="theme-toggle"`, a `<button>` with class `btn-icon`; it MUST be the first element in the
     document matching `.btn-icon` (existing tests click `.btn-icon`). Click → `toggleDark(current)`. Icon: moon when
     current is a light variant, sun when dark. `aria-label` = "Switch to dark mode" / "Switch to light mode" (same
     text in `title`). It does not change style.
   - Style trigger `data-testid="theme-style-menu"`: `<button aria-haspopup="menu" aria-expanded="true|false">`,
     visible palette icon + chevron, accessible name "Style: Default|GitHub|Locus". Must not carry class `btn-icon`.
   - Menu `data-testid="theme-style-menu-list"` `role="menu"` `aria-label="Theme style"`, rendered only while open,
     three `role="menuitemradio"` items `data-testid="theme-style-option"` with `data-style="default|github|locus"`,
     labels "Default", "GitHub", "Locus", `aria-checked="true"` on the current style only.
   - Selecting an item → `themeFor(style, isDark(current))`, closes the menu, focus returns to the trigger.
6. Keyboard (this model is the shared `AppMenu` contract, 00 §3.2 — built by #2, reused here): trigger Enter/Space/ArrowDown opens and focuses the checked item; ArrowUp opens and focuses the last item.
   In the menu: ArrowDown/ArrowUp move with wrap, Home/End jump, Enter/Space select, Escape closes without change and
   returns focus to the trigger, Tab closes (no change). Pointer: click outside closes without change. Items use
   roving `tabindex` (focused item `0`, others `-1`). Visible focus ring on toggle, trigger and items in every theme.
7. Menu placement: right-aligned under the trigger; fully inside the viewport at all three viewports; above other
   header content (z-index), opaque `--bg-surface` background, 1px `--border`, radius 8px, no heavy shadow.
8. Fonts: `index.html` Google Fonts request adds
   `Montserrat:ital,wght@0,300;0,400;0,500;0,600;0,800;1,400` (`display=swap`). Code stays JetBrains Mono everywhere.
9. Locus tokens (`html.locus-theme` / `html.dark.locus-theme` in `src/style.css`). Light → dark:
   `--bg-page` #F3F0EB → #280A38; `--bg-surface` #FFFFFF → #280A38; `--bg-code` #F3F0EB → rgba(255,255,255,0.06);
   `--text-primary` #280A38 → #FFFFFF; `--text-secondary` #533B60 → #FFFFFF; `--text-muted` #9B8FA8 → #9B8FA8;
   `--accent` #B066FF → #B066FF; `--border` #E6E1DA → #533B60; `--font-heading` and `--font-body`
   `'Montserrat', Arial, sans-serif`; `--comment-bg` rgba(176,102,255,0.10); `--selection-bg` rgba(176,102,255,0.22).
   No other hues are introduced (status colours keep their existing meaning).
10. Locus chrome: `.btn-primary` bg #B066FF, text #280A38 (both modes). `.btn-ghost` text `--text-secondary`, border
    `--border`. Header bg `--bg-surface`, bottom border `--border`. No `box-shadow` beyond 0, no gradients
    (`background-image: none`) on header, buttons, preview pane, style menu.
11. Locus preview typography (markdown only; the `.preview-pane`):
    - h1: Montserrat 600 30px, colour `--text-primary`; NO border/underline (`border-bottom-width: 0`).
    - h2: 600 22px `--text-primary`, no border. h3: 600 16px #B066FF. h4: 600 15px #B066FF. h5/h6: 600 14px/13px
      #B066FF (all same-level headings share a colour). No heading has a bottom border or left bar.
    - p/li: 400, 15px, line-height 1.5 (22.5px), colour `--text-secondary` (#533B60 light, #FFFFFF dark).
    - a: #B066FF, no underline; underline on hover/focus.
    - Tables: `th` bg #F3F0EB text #280A38 weight 600 (light); `th` bg #533B60 text #FFFFFF (dark); cells border 1px
      `--border`; body rows transparent (no zebra).
    - Code: inline + `pre` use JetBrains Mono on `--bg-code`; `pre` border 1px `--border`, radius 8px. hljs in Locus:
      keyword/tag #280A38 weight 600 (light) / #B066FF (dark); comments #9B8FA8 italic; other tokens `--text-secondary`.
    - Blockquote: no left stripe; card style bg `--bg-code`, radius 8px, padding 12px 16px.
    - `.comment-highlight` keeps its 2px left stripe in `--accent` (review UI only; user decision).
12. Mermaid: Default/GitHub keep `dark`/`neutral`. Locus → `theme: 'base'` with `themeVariables`:
    `fontFamily: 'Montserrat, Arial, sans-serif'`, `pie1..pie6` and `cScale0..cScale5` = series
    #B066FF, #3264FF, #14B4EF, #00D273, #FF9F00, #FF6429, `xyChart.plotColorPalette` = same six, comma-joined.
    Light: `background #FFFFFF, primaryColor/mainBkg #F3F0EB, primaryTextColor/titleColor #280A38,
    primaryBorderColor/nodeBorder #B066FF, lineColor #533B60, textColor #533B60, clusterBkg #FFFFFF,
    clusterBorder #E6E1DA, edgeLabelBackground #FFFFFF`. Dark: `background #280A38, primaryColor/mainBkg #533B60,
    primaryTextColor/titleColor/textColor #FFFFFF, primaryBorderColor/nodeBorder #B066FF, lineColor #E6E1DA,
    clusterBkg #280A38, clusterBorder #533B60, edgeLabelBackground #280A38`. Diagrams re-render on any theme change.
13. HTML iframe: the theme message becomes `{__mdreview_theme: 'dark'|'light', __mdreview_style: 'default'|'github'|'locus'}`;
    the bridge stamps `data-theme` (unchanged) and `data-theme-style` on the frame's `<html>`. No CSS or font is
    injected into the user document; the iframe background stays #fff. A message without `__mdreview_style` still works.

## Acceptance criteria
AC-01.1 Given a fresh browser (no storage, OS light) When the app loads a doc Then `<html>` has neither `dark`,
`github-theme` nor `locus-theme` and `data-theme-style="default"`.   [verify: e2e]
AC-01.2 Given Default light When `theme-toggle` is clicked twice Then html gains `dark` after click 1 and is back to
no `dark`, no `github-theme` after click 2 (no cycling into GitHub).   [verify: e2e]
AC-01.3 Given any style When `theme-style-option[data-style=locus]` is chosen from light Then html has `locus-theme`,
not `dark`, not `github-theme`, `localStorage['md-review-theme']==='locus-light'`; toggling then gives `locus-dark`
with `dark`+`locus-theme`. Same for GitHub → `github-light`/`github-dark`. Style choice preserves the dark flag.   [verify: e2e]
AC-01.4 Given `md-review-theme` = each of the 6 values When the page reloads Then the matching classes are applied
before first paint of the doc; given `"bogus"` Then Default style by OS preference; given `localStorage` that throws
on get/set Then the app renders and switching still works.   [verify: e2e]
AC-01.5 Given locus-light with the e2e fixture in Preview, at the default reader font scale (100%, see #18), Then computed: `body` background rgb(243, 240, 235);
`.preview-pane` background rgb(255, 255, 255); `.preview-pane h1` color rgb(40, 10, 56), font-weight 600,
font-size 30px, border-bottom-width 0px, font-family starting "Montserrat"; `h2` rgb(40, 10, 56); `h3` rgb(176, 102, 255);
`p` color rgb(83, 59, 96), font-size 15px, line-height 22.5px; `a` rgb(176, 102, 255); `th` background
rgb(243, 240, 235) color rgb(40, 10, 56); `pre code` font-family starting "JetBrains Mono"; blockquote
border-left-width 0px.   [verify: e2e]
AC-01.6 Given locus-dark Then: `body` and `.preview-pane` background rgb(40, 10, 56); `h1`,`h2`,`p` color
rgb(255, 255, 255); `h3` rgb(176, 102, 255); `th` background rgb(83, 59, 96) color rgb(255, 255, 255);
`pre` background rgba(255, 255, 255, 0.06).   [verify: e2e]
AC-01.7 Given locus-light or locus-dark Then a visible `.btn-primary` has background rgb(176, 102, 255) and color
rgb(40, 10, 56); header, `.btn`, `.preview-pane`, style menu have `background-image: none` and `box-shadow: none`.   [verify: e2e]
AC-01.8 Given Default or GitHub themes Then the computed values asserted today (h1 font-family not Montserrat, GitHub
`.markdown-body` present, github CSS link enabled only for github) are unchanged.   [verify: e2e]
AC-01.9 Given locus-light and a flowchart Then node `rect` fill rgb(243, 240, 235) and stroke rgb(176, 102, 255); given a
pie with 6 slices in source order with strictly descending values Then legend swatches 1..6 fill #B066FF, #3264FF,
#14B4EF, #00D273, #FF9F00, #FF6429 in order; switching to locus-dark re-renders the SVG with node fill rgb(83, 59, 96).   [verify: e2e]
AC-01.10 Given an HTML document When the style is Locus dark Then (via Playwright frame access) the frame's `<html>`
has `data-theme="dark"` and `data-theme-style="locus"`; no `<style>`/`<link>` was added by the app other than the
bridge `<script>`; switching to Default light updates both attributes.   [verify: e2e]
AC-01.11 Keyboard: focus `theme-style-menu`, press Enter → menu open, focus on the checked item; ArrowDown ×3 wraps
back to it; End then Enter selects Locus and focus returns to the trigger with `aria-expanded="false"`; reopen, press
Escape → closed, style unchanged, focus on trigger; Tab from an open menu closes it.   [verify: e2e]
AC-01.12 ARIA: open menu has `role=menu`, exactly 3 `menuitemradio` children, exactly one `aria-checked="true"`
matching `<html data-theme-style>`; trigger `aria-expanded` mirrors open state; toggle `aria-label` matches rule 5.   [verify: a11y]
AC-01.13 axe-core `color-contrast` (WCAG AA) passes on the fixture in Preview for locus-dark with no exclusions, and
for locus-light excluding only `.preview-pane a`, `.preview-pane h3–h6`, `.hljs-comment` (brand-mandated #B066FF /
#9B8FA8, see Decisions). Header, buttons, body text, tables pass in both.   [verify: a11y]
AC-01.14 At 1400×900, 820×1180 and 390×844, in all 6 themes: toggle and trigger are visible and inside the viewport;
the open menu's bounding box is fully inside the viewport and not covered by other elements.   [verify: visual]
AC-01.15 Visual: locus-light preview reads as white surface on cream page, purple accents, no underline under titles,
no blockquote stripe; locus-dark is deep purple with white text; screenshots at all 3 viewports.   [verify: visual]
AC-01.16 Unit: `ALL_THEMES` equals the 6 values in order; `isDark`/`isGithub`/`isLocus`/`themeStyle` correct for all 6;
`toggleDark` maps each theme to its pair; `themeFor('locus', true)==='locus-dark'`; `isValidTheme` rejects
`'locus'`, `'system'`, `''`, `null`, `42`.   [verify: unit]

## Existing tests that change
- `useTheme.test.ts`: drop `nextTheme`/`THEME_CYCLE` cases; replace with AC-01.16.
- `app.test.mjs:67-79`: 2nd `.btn-icon` click now returns to light (assert no `dark`, no `github-theme`).
- `app.test.mjs:1114-1166` "four-mode theme cycling": replace with AC-01.2/01.3 (toggle + style menu).
- `app.test.mjs:1183-1206`, `1208-1235`: reach github-light / github-dark via the Style menu (+ toggle), not 2–3 clicks.
- `app.test.mjs:87,113,475,785`, `mermaid.test.mjs:68`: unchanged (first `.btn-icon` click = dark).

## Test hooks (data-testid list) and API/MCP contract changes
`theme-toggle`, `theme-style-menu`, `theme-style-menu-list`, `theme-style-option` (+ `data-style`). Attributes:
`html[data-theme-style]`, iframe `html[data-theme-style]`. postMessage gains `__mdreview_style`. No API/MCP changes.

## Edge cases the adversarial verifier must try
- Open the menu, then press the toggle: menu closes, dark flips, style kept. Rapid toggling with mermaid on page
  leaves exactly one SVG per diagram.
- Switch Locus → GitHub → Locus: no Montserrat leaks into GitHub, github CSS disabled again in Locus.
- `md-review-theme` set in another tab: no requirement to live-sync, but no crash on reload.
- HTML doc that sets its own `data-theme-style` handling / no `</body>` tag: attributes still stamped.
- Library/landing pages (no doc) in Locus: background cream/purple, no unthemed white flashes.
- Edit pane in Locus: editor stays JetBrains Mono, caret/selection visible in both modes.

## Decisions
- Default style for new readers stays Default (OS light/dark); Locus is opt-in — avoids silently restyling every reader and existing tests.
- Light-mode purple text (#B066FF on white = 3.39:1) and label #9B8FA8 (3.05:1) fail AA for small text; brand hex is mandatory, so they are recorded axe exclusions rather than recoloured. Flag for the user.
- hljs keywords use #280A38 in Locus light (purple on cream is 2.98:1); purple in dark (5.2:1).
- Dark code background is a white tint over #280A38 (not #533B60, where purple tokens drop to 2.86:1).
- Blockquotes become cream cards (brand forbids edge stripes); comment highlight is the only stripe.

## Dependencies on other items (by number) and files likely touched
#18 places its reader-settings button after the Style trigger; #5 owns header collapse on phone; #14/#16/#17
should use Locus tokens (callouts use status hues only for status). Lands after #2 (header split, `AppMenu`).
**Structural deliverable (00 §4.6):** first commit extracts the scoped preview styles of `PreviewPane.vue` into
non-scoped `src/styles/preview.css` (all selectors under `.preview-pane`) with no visual change; Locus rules go there.
Files: `src/types/index.ts`, `src/composables/useTheme.ts`, `src/composables/usePersistence.ts`, `src/style.css`,
`src/styles/preview.css` (new), `index.html`, new `src/components/ThemeSwitcher.vue`, `src/components/PreviewPane.vue`
(mermaid theme, bridge), `tests/composables/useTheme.test.ts`, `tests/e2e/app.test.mjs`, `tests/e2e/mermaid.test.mjs`.

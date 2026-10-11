# 18 — Reader font size + content width control

## Goal
Readers (often on laptops with wide screens, sometimes on phones or projectors) can make the rendered document's text
bigger or smaller and choose a comfortable narrow reading column or the full width, and the app remembers it.

## Scope / Out of scope
In: a "Reading settings" control with A− / A+ / Reset and Narrow / Wide; scaling and column width of the Markdown
preview; persistence in localStorage; behaviour in all 6 themes; keyboard + screen-reader access.
Out: the editor's font (stays 14px JetBrains Mono); HTML documents in the sandboxed iframe (we never restyle user
HTML); per-document or server-side preferences; global keyboard shortcuts; print sizing (#19); mobile header
collapse (#5).

## Current state
- `src/components/PreviewPane.vue:409-418` `.preview-pane`: `font-size: 15px; line-height: 1.7; padding: 24px 32px;`
  no `max-width` — the content always spans the full `.main-pane`. It is also the scroll container (`overflow-y: auto`).
- Descendant sizes are hard-coded px in the Default look: h1 24px (`:423`), h2 20px (`:432`), h3 16px (`:440`),
  h4 15px / h5 14px / h6 13px (`:629-655`), inline code 13px (`:466`), table 14px (`:507`), frontmatter 13px (`:550`).
  So changing the pane's font-size today would NOT scale headings/code. GitHub look uses github-markdown-css, whose
  `.markdown-body` sets 16px with em-relative children.
- `src/components/EditorPane.vue:98-102` editor theme `fontSize: '14px'` — unaffected by this item.
- `src/App.vue:716-724` mounts `PreviewPane` only when `paneMode === 'preview'`; `.main-pane` `flex: 7` (`:844`),
  comments sidebar max 340px (`:892-896`).
- HTML docs render in `<iframe class="html-frame">` (`PreviewPane.vue:376-384`), width/height 100%.
- Other per-reader prefs pattern: `src/composables/useReviewer.ts:9,23` (localStorage in try/catch).
- No reader-preference storage exists today.

## Behaviour
1. New composable `src/composables/useReaderPrefs.ts` with pure exports:
   `FONT_SCALES = [80, 90, 100, 110, 120, 135, 150]` (percent), `DEFAULT_READER_PREFS = { fontScale: 100, width: 'narrow' }`,
   `stepFontScale(current, dir: 1 | -1)` → neighbour in `FONT_SCALES`, clamped at the ends (an off-list value snaps to
   100 first), `parseReaderPrefs(raw: string | null)` → sanitised `{ fontScale, width }` (each invalid/missing field
   falls back to its default independently; bad JSON → defaults), and a reactive `useReaderPrefs()` returning
   `{ fontScale, width, increase(), decrease(), reset(), setWidth(w) }`.
2. Storage: key `md-review-reader-prefs`, value JSON `{"fontScale":<n>,"width":"narrow"|"wide"}`, written on every change,
   read once at startup. All access in try/catch; with storage unavailable the controls still work for the session.
   Preferences are per browser (not per doc, not synced to the server).
3. Font scale: the preview's base text size = style base × `fontScale/100`, where style base is 15px for Default and
   Locus, 16px for GitHub. All type inside `.preview-pane` (headings, code, tables, frontmatter, task-list text;
   mermaid SVG text is not required to scale) scales proportionally: at 100% every computed font-size equals today's value (Default:
   p 15, h1 24, h2 20, h3 16, inline code 13, table 14; GitHub: p 16, h1 32; Locus: as #01) within ±0.5px, and at any
   scale each element's size = its 100% size × scale (±0.5px). Line-height stays proportional (unitless).
4. Width: `narrow` caps the content column at `50em` of the preview's current font-size (750px at 15px, 800px at 16px)
   and centres it within the pane; `wide` removes the cap (content fills the pane minus its existing 32px side padding).
   The pane's own background still fills the whole main pane; only the content column narrows. Default is `narrow`.
   (#5 rule 4 already implements the 50em centred column as the default when this item lands; this item adds the
   control and the `wide` option. Consistent with #2/#5/#7: split view's preview half is narrower than the cap at all
   verification viewports, so narrow and wide look identical there; focus mode (#13) centres only the editor.)
5. In both widths `.preview-pane` never scrolls horizontally (scrollWidth ≤ clientWidth + 1); `pre`, wide tables and
   wide images/diagrams scroll or shrink inside their own box. At viewports where the pane is narrower than the cap,
   narrow and wide render identically.
6. The pane exposes state for tests: `.preview-pane` gets `data-testid="preview-pane"`,
   `data-reader-font-scale="<n>"` and `data-reader-width="narrow|wide"`. Changes apply instantly without re-rendering
   the markdown (comment highlights, selection, scroll position by proportion — no jump to top).
7. Control (`ReaderSettings.vue`): a button `data-testid="reader-settings-btn"` in the header right group, rendered
   whenever a document is loaded, placed AFTER #01's Style trigger and NOT carrying class `btn-icon` (00 §2.2). On
   phone it is an item of `header-overflow-menu` (same testid) that opens the panel as a full-width sheet. Visible label "Aa"; `aria-label`
   "Reading settings"; `aria-haspopup="dialog"`; `aria-expanded` mirrors state.
8. Panel `data-testid="reader-settings-panel"`, `role="dialog"` `aria-label="Reading settings"`, non-modal, anchored
   under the button, right-aligned, fully inside the viewport at all three viewports, opaque `--bg-surface`, 1px
   `--border`, radius 8px. Contents in this order:
   - "Text size": `font-decrease` (label "A−", `aria-label` "Decrease text size"), `font-size-value` (text "100%",
     `aria-live="polite"`), `font-increase` ("A+", "Increase text size"), `font-reset` ("Reset", "Reset text size").
     `font-decrease` is `disabled` at 80, `font-increase` at 150, `font-reset` at 100.
   - "Width": `width-narrow` ("Narrow") and `width-wide` ("Wide"), toggle buttons with `aria-pressed` (exactly one true).
9. Keyboard: Enter/Space on the button opens the panel and focuses its first enabled control; Tab/Shift+Tab move
   through controls; Enter/Space activate; Escape closes and returns focus to the button; tabbing out of the panel or
   clicking outside closes it. The panel stays open while the reader presses A+/A− repeatedly. Visible focus ring in
   all themes.
10. Edit mode: the button stays available; changes are stored and take effect when the preview is shown. The editor's
    computed font-size remains 14px regardless of scale.
11. HTML documents: the panel opens but the five controls are `disabled` and a note `data-testid="reader-settings-note"`
    reads "Text size and width apply to Markdown documents." The iframe's size, attributes and content are unchanged;
    stored prefs are untouched.
12. Themes: switching any of the 6 themes keeps the current scale and width; GitHub uses its 16px base.

## Acceptance criteria
AC-18.1 Given no stored prefs When a Markdown doc opens in Preview Then `preview-pane` has `data-reader-font-scale="100"`,
`data-reader-width="narrow"`, Default `p` font-size 15px and `h1` 24px.   [verify: e2e]
AC-18.2 Given Default at 100% When `font-increase` is clicked 6 times Then the value reads 110,120,135,150% in turn,
then stays 150% with `font-increase` disabled; `p` font-size 22.5px (±0.5), `h1` 36px, inline `code` 19.5px.   [verify: e2e]
AC-18.3 Given 100% When `font-decrease` is clicked twice Then 80%, `font-decrease` disabled, `p` 12px, `h1` 19.2px (±0.5);
`font-reset` returns to 100% and becomes disabled.   [verify: e2e]
AC-18.4 Given desktop 1400×900, Default, 100%, narrow Then the first `p`'s width ≤ 751px and its left and right gaps to
the pane's client box differ by ≤ 2px; When `width-wide` is pressed Then that `p`'s width ≥ pane clientWidth − 66px and
`aria-pressed` swaps.   [verify: e2e]
AC-18.5 Given narrow at 150% (Default) Then the column cap is 1125px (p width ≤ min(1126, pane clientWidth − 64)).   [verify: e2e]
AC-18.6 Given scale 135% and wide When the page reloads Then `localStorage['md-review-reader-prefs']` parses to
`{fontScale:135,width:"wide"}` and the pane shows both; given stored `{"fontScale":999,"width":"huge"}` or `"{"` Then
defaults apply; given localStorage that throws Then the controls still change the pane.   [verify: e2e]
AC-18.7 Given scale 120% When the reader switches to Edit Then `.cm-content` font-size is 14px; switching back to Preview
shows 120%.   [verify: e2e]
AC-18.8 For each of the 6 themes at 120% Then `p` font-size = base × 1.2 (Default/Locus 18px, GitHub 19.2px, ±0.5)
and the narrow cap/centering of AC-18.4 holds (cap = 50em of that size).   [verify: e2e]
AC-18.9 Given an HTML document Then the panel's 5 controls are disabled, `reader-settings-note` is visible, and the
iframe bounding box equals the main pane's (unchanged by any stored pref).   [verify: e2e]
AC-18.10 Keyboard only: Tab to `reader-settings-btn`, Enter → panel open, focus on `font-decrease` (or `font-increase`
when at 80%); Space on `font-increase` raises the scale and keeps the panel open; Escape closes, focus back on the
button, `aria-expanded="false"`; clicking outside an open panel closes it.   [verify: e2e]
AC-18.11 ARIA: panel `role=dialog` with accessible name "Reading settings"; `font-size-value` has `aria-live="polite"`;
exactly one of `width-narrow`/`width-wide` has `aria-pressed="true"`; axe reports no violations inside the panel in
Default light and locus-dark.   [verify: a11y]
AC-18.12 With the e2e fixture at 150% in both widths at all three viewports, `.preview-pane` scrollWidth ≤ clientWidth + 1.   [verify: e2e]
AC-18.13 Changing scale/width with comments present keeps `.comment-highlight` elements and does not reset scroll to top
(the reading scroll position — `window.scrollY` in read view, which uses document scroll per #5 rule 2; the preview
pane's `scrollTop` in split view — is > 0 after the change when it was > 0 before).   [verify: e2e]
AC-18.14 Visual at 1400×900, 820×1180, 390×844: narrow shows a centred column with even margins, wide fills the pane;
the panel is fully on-screen and not clipped by the header.   [verify: visual]
AC-18.15 Unit: `stepFontScale(150,1)===150`, `stepFontScale(80,-1)===80`, `stepFontScale(100,1)===110`,
`stepFontScale(120,1)===135`, `stepFontScale(97,1)===110`; `parseReaderPrefs(null)` deep-equals defaults;
`parseReaderPrefs('{"fontScale":110}')` → `{fontScale:110,width:'narrow'}`; `parseReaderPrefs('{"width":"wide","fontScale":"x"}')`
→ `{fontScale:100,width:'wide'}`.   [verify: unit]

## Test hooks (data-testid list) and API/MCP contract changes
`reader-settings-btn`, `reader-settings-panel`, `font-decrease`, `font-increase`, `font-size-value`, `font-reset`,
`width-narrow`, `width-wide`, `reader-settings-note`, `preview-pane` (+ `data-reader-font-scale`, `data-reader-width`).
localStorage key `md-review-reader-prefs`. No API/MCP changes.

## Edge cases the adversarial verifier must try
- Spam A+ / A− rapidly: value never leaves 80–150, never shows an off-list step, no layout thrash errors in console.
- Very long unbroken URL / code line / 12-column table at 150% narrow on phone: no horizontal pane scroll.
- Mermaid diagram and large image at narrow: fit the column (max-width 100%), still readable.
- Two tabs with different settings: each tab keeps its own until reload; reload takes the last-written value.
- Switch doc (library → another doc) and multi-file sessions: prefs carry over.
- Open panel then switch theme via #01 toggle: panel restyles, values intact.
- Corrupt `md-review-reader-prefs` with a number or array JSON: defaults, no crash.

## Decisions
- Default width is `narrow` (readable ~75 chars per line); a view-and-share reader is optimised for reading. Changes today's full-width look.
  e2e impact (00 §11): introduced by #5; existing tests address text, not widths, and coordinate-based popover tests
  compute positions from bounding boxes, so they are expected to pass; any assertion of preview width must be updated.
- Scale is a percentage of each style's base (GitHub 16px, others 15px) so the GitHub look is not shrunk to 15px.
- Narrow cap is in em (50em) so line length stays constant as text grows.
- HTML docs: controls disabled, not hidden — readers learn why nothing changes; we never inject CSS into user HTML.
- No global keyboard shortcuts: Ctrl/Cmd +/- belong to browser zoom.

## Dependencies on other items (by number) and files likely touched
#01 (header order: toggle, Style trigger, then `reader-settings-btn`; Locus base sizes), #2 (reading mode must keep this
control visible to viewers), #5 (phone header overflow, table scrolling), #7 (split view: preview half only), #13 (focus
mode should honour the width preference rather than force full width — flag), #17/#14/#16 (new preview elements must
size in em). Files: new `src/composables/useReaderPrefs.ts`, `src/styles/preview.css` (px → em, width cap),
`src/components/PreviewPane.vue` (data attributes), new `src/components/ReaderSettings.vue` (one line in `DocHeader.vue` and
the overflow menu), `src/components/DocView.vue` (wire prefs into PreviewPane), `tests/composables/useReaderPrefs.test.ts`, new e2e file.

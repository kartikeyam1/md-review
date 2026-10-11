# 10 — Paste / drop image → upload as attachment

## Goal
An author can paste a screenshot or drop image files into the editor and get a working `![alt](url)` that every
reader of the shared doc sees, without leaving the editor or hosting the image elsewhere.

## Scope / Out of scope
- In: clipboard image paste, drag-and-drop of image files onto the editor, upload to the doc's attachment store
  (`POST /paste/:id/files`), uploading placeholder, success/failure handling, size/type limits, multiple images,
  unshared-doc flow, rendering for viewers. Uses the shared `app-toast` (00 §3.1, built by #2).
- In (server, small): validation + safe headers for files under the `assets/` prefix.
- Out: image resizing/compression, cropping, an attachment manager UI, garbage-collecting orphaned uploads,
  pasting images from a URL (text URLs paste as text), the HTML preview iframe's own paste.

## Current state
- `src/components/EditorPane.vue:182-221` builds the editor; the only paste handling is `domEventHandlers.paste`
  at `:193-207`, which special-cases raw `<svg …></svg>` text and inserts it. No `drop` handler, no image handling.
- `EditorPane.vue:188` keymap is `defaultKeymap` + `searchKeymap`; there is no `history()` (item #8), so undo
  ACs below depend on #8.
- `server/server.cjs:1316-1386` file routes: `GET /paste/:id/files` (list), `POST /paste/:id/files`
  `{name, content, encoding?}` → 201 `{name,size,type}`, `GET /paste/:id/files/:name` serves bytes with
  `Content-Type` from `getMime` (`:117`, table `:100-115` already maps png/jpg/jpeg/gif/webp/svg) and
  `Cache-Control: no-cache` (`:1352`), `DELETE`. `saveSessionFile` (`:445-460`) accepts sub-paths
  (`mkdirSync` of dirname), blocks traversal, and silently overwrites an existing name. No size/type checks beyond
  the 50 MB body cap (`:30`, `readBody :155`).
- CORS (`:576-579`) already allows `POST` + `Content-Type` from any origin; `<img>` loads need no CORS.
- Frontend API base is `import.meta.env.VITE_PASTE_API_URL || ''` (`src/composables/useShare.ts:5`); production
  frontend (GitHub Pages) and backend are different origins, so image URLs must be absolute.
- A doc is "shared" iff `pasteId` is set (`src/composables/useSync.ts:102`); share creation is `handleShare`
  (`src/App.vue:285-304`). Errors are surfaced with `alert()` (`App.vue:190,302`) — there is no toast component.
- markdown-it default `validateLink` (`src/composables/useMarkdown.ts:167`) rejects `data:image/svg+xml` URLs,
  which is one reason the inline data-URI fallback is rejected below.

## Behaviour
1. **Trigger — paste.** A `paste` into the editor takes the image path when `clipboardData.files` contains ≥1
   file whose type is an image AND `text/plain` is empty/whitespace. If `text/plain` has content (e.g. Excel puts
   both a PNG and TSV on the clipboard) the paste is treated as text (item #11 / default). Ctrl/Cmd+Shift+V
   (plain-text paste, item #11) never uploads.
2. **Trigger — drop.** Dropping files onto the editor: image files are uploaded and inserted at the drop position
   (`posAtCoords` of the drop point; cursor moves there). Non-image files in the same drop are skipped with an info
   toast "Skipped N non-image file(s)". A drop with no image files falls through to default behaviour. Dragging
   text within the editor is unaffected.
3. **Accepted types:** `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/svg+xml` (type from
   `File.type`; if empty, from the file-name extension png/jpg/jpeg/gif/webp/svg). Anything else (bmp, tiff,
   heic, …) → error toast "Unsupported image type: <name>", nothing inserted for that file.
4. **Size limit:** 10 MiB (10 485 760 bytes) per image, checked client-side before any placeholder is inserted →
   error toast "<name> is larger than 10 MB". **Count limit:** at most 10 images per paste/drop; extras skipped
   with toast "Only the first 10 images were added".
5. **Stored name:** `assets/<YYYYMMDD>-<HHMMSS>-<6 lowercase hex>.<ext>` (local time, ext from rule 3,
   `jpeg`→`jpg`). Upload body: `{ name, content: <base64>, encoding: "base64" }` to
   `${API}/paste/<pasteId>/files`, where `pasteId` is the canonical id (never the slug). At most 3 uploads run
   concurrently. The request carries `X-Edit-Token` when a token is held for the doc (#23, which lands earlier).
6. **URL inserted:** absolute — `new URL('/paste/<pasteId>/files/<name>', API || location.origin).href`, e.g.
   `https://api.example/paste/ab12/files/assets/20261010-142233-a1b2c3.png`.
7. **Alt text:** original file name minus extension; remove `[`, `]`, `\`; collapse whitespace; trim. Empty →
   `image`. (Clipboard screenshots are named `image.png` → alt `image`.)
8. **Placeholder:** for each accepted image, insert `![Uploading <alt>…]()` (U+2026 ellipsis) at the target
   position immediately, in clipboard/drop order. Single image: inserted exactly at the cursor (replacing any
   selection). Multiple: placeholders joined by `\n\n`. Cursor ends after the last placeholder. All placeholders of
   one paste/drop are one transaction / one undo step.
9. **Position tracking:** each placeholder's range is tracked through later edits (mapped through changes), not
   found by text search. Typing elsewhere, or above it, during upload must not break replacement.
10. **Success:** the placeholder range is replaced by `![<alt>](<url>)` for markdown docs, or
    `<img src="<url>" alt="<alt>">` when `contentType === 'html'`. The replacement is not a separate undo step:
    after success, one Ctrl/Cmd+Z removes the final image markup entirely (doc returns to its pre-paste text); it
    never reveals the `Uploading…` placeholder.
11. **Failure** (network error, non-2xx, timeout 60 s): the placeholder is removed (not added to undo history) and
    an error toast "Couldn't upload <alt>: <server `error` field or status/network message>" appears.
12. **Placeholder deleted by the user** before completion: on success nothing is inserted (the uploaded file is
    left on the server — no GC); on failure no toast about a missing placeholder, just the upload error toast.
13. **Navigation away** (another doc loaded, detach from share) while uploading: results are discarded; nothing is
    inserted into the new doc.
14. **Unshared doc** (no `pasteId`): no upload, no placeholder. A dialog `share-required-dialog` opens:
    "Images are stored with the shared document. Share it to add images." with buttons **Share and insert**
    (`share-required-confirm`) and **Cancel** (`share-required-cancel`). Confirm runs the same share-creation flow as
    the Share button (the share modal opens as usual), then uploads and inserts at the position captured at paste
    time. Share failure → error toast, nothing inserted. Cancel / Esc → nothing changes.
15. **Toast:** all messages above use the shared `AppToast` (contract moved to **00 §3.1**, built by #2): fixed
    bottom-centre stack, `data-testid="app-toast"`, `data-kind="info|success|error"`, `role="status"`/`"alert"`,
    auto-dismiss 4 s / 8 s, close button `app-toast-close`, max 3 visible.
16. **Server, `assets/` prefix only** (`POST /paste/:id/files` with `name` starting `assets/`): extension must be
    png/jpg/jpeg/gif/webp/svg else 415 `{error:"Unsupported attachment type"}`; decoded size > 10 MiB → 413
    `{error:"Attachment too large"}`. `GET` of an `assets/` file adds `X-Content-Type-Options: nosniff` and, for
    `.svg`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`. Non-`assets/` names keep
    today's behaviour exactly (MCP/CLI multi-file sessions).
17. **Rendering for viewers:** inserted URLs are plain absolute http(s) image links, so they render in the
    markdown preview (`<img>`), in the HTML iframe preview, for viewers without an edit token, and at phone width
    (existing `max-width:100%`, `PreviewPane.vue:669`).

## Decisions
- **Prompt to share, not data-URI fallback.** Data URIs bloat every stored revision (`REVISIONS_MAX` copies),
  produce 100 KB+ single lines in CodeMirror and in MCP/agent reads, and markdown-it drops `data:image/svg+xml`.
  An explicit share prompt keeps the doc small and makes the "this becomes public" step visible.
- Store under `assets/` so multi-file session UIs (#26) can hide attachments from the file list.
- Absolute URLs: the doc must render identically when read via MCP, exported (#19), or copied elsewhere.
- Text wins over image when both are on the clipboard (spreadsheet copies carry a PNG of the cells).

## Acceptance criteria
AC-10.1 Given a shared markdown doc in edit mode, When a PNG (name `shot.png`) is pasted with empty text/plain, Then a `POST …/paste/<id>/files` with `name` matching `^assets/\d{8}-\d{6}-[0-9a-f]{6}\.png$` and `encoding:"base64"` is sent, and the editor text at the cursor becomes `![shot](<absolute url ending in that name>)`.   [verify: e2e]
AC-10.2 Given the upload response is delayed 2 s, When the image is pasted, Then within 200 ms the editor contains `![Uploading shot…]()`, and after the response it contains the final markdown and no `Uploading` text.   [verify: e2e]
AC-10.3 Given a delayed upload, When the user types 5 characters on a line above the placeholder before it resolves, Then the final markdown replaces exactly the placeholder (the typed text is intact, no duplicate/partial markup).   [verify: e2e]
AC-10.4 Given the upload returns 500 `{error:"disk full"}`, When pasted, Then the placeholder is removed, the doc equals its pre-paste text, and an `app-toast` with `data-kind="error"` contains `Couldn't upload shot` and `disk full`.   [verify: e2e]
AC-10.5 Given a successful paste, When Ctrl/Cmd+Z is pressed once, Then the doc equals its pre-paste text (no placeholder appears).   [verify: e2e]
AC-10.6 Given three image files dropped together, When the drop completes, Then three images appear at the drop position in drop order separated by one blank line, and one Ctrl/Cmd+Z after all succeed removes all three.   [verify: e2e]
AC-10.7 Given an 11 MB PNG, When pasted, Then no request is sent, nothing is inserted, and an error toast contains `larger than 10 MB`.   [verify: e2e]
AC-10.8 Given a `.bmp` image and a `.txt` file dropped together with one `.png`, Then only the PNG is uploaded/inserted, and toasts report the unsupported type and the skipped non-image file.   [verify: e2e]
AC-10.9 Given a clipboard with both `image/png` and text/plain `a\tb\nc\td`, When pasted, Then no upload happens and the text path (item #11) handles it.   [verify: e2e]
AC-10.10 Given an unshared doc (loaded via `?filePath=`), When an image is pasted, Then `share-required-dialog` is visible, no `/files` request is sent and the doc is unchanged; Cancel closes it with the doc unchanged.   [verify: e2e]
AC-10.11 Given the same dialog, When `share-required-confirm` is clicked, Then a `POST /paste` creates the share, the image uploads to the new id, and the markdown is inserted at the original paste position.   [verify: e2e]
AC-10.12 Given a doc with a pasted image, When it is opened by a fresh browser context as a viewer at 1400×900 and 390×844, Then the preview contains an `img` whose `src` equals the inserted URL, `naturalWidth > 0`, and its rendered width ≤ the preview content width.   [verify: e2e]
AC-10.13 Given an `html` content-type doc, When an image is pasted, Then `<img src="<url>" alt="<alt>">` is inserted and the image renders inside the HTML preview iframe.   [verify: e2e]
AC-10.14 Given the server, When `POST /paste/:id/files` is sent with `name:"assets/x.exe"` → 415; with an 11 MiB decoded `assets/x.png` → 413; with `name:"notes/x.exe"` → 201 (unchanged behaviour).   [verify: server]
AC-10.15 Given an uploaded `assets/*.svg`, When fetched, Then `Content-Type: image/svg+xml`, `X-Content-Type-Options: nosniff` and a `Content-Security-Policy` containing `default-src 'none'` are present.   [verify: server]
AC-10.16 Given an error toast, Then it has `role="alert"`, is dismissed by `app-toast-close`, and otherwise disappears after ~8 s.   [verify: e2e]

## Test hooks (data-testid list) and API/MCP contract changes
- `app-toast` (with `data-kind`), `app-toast-close` (both owned by #2 per 00 §3.1), `share-required-dialog`, `share-required-confirm`,
  `share-required-cancel`. Editor content is read via `.cm-content` / the `markdown` model.
- API: `POST /paste/:id/files` gains 413/415 for `assets/` names; `GET` of `assets/` files gains `nosniff` (+ CSP
  for svg). Request/response shapes unchanged. No MCP changes.

## Edge cases the adversarial verifier must try
- Paste while text is selected (selection replaced by placeholder); paste at doc end with no trailing newline.
- Delete the placeholder mid-upload; undo the paste mid-upload (placeholder gone → success inserts nothing).
- Switch to preview / another doc mid-upload; network offline; server returns non-JSON 502.
- Exactly 10 MiB (accepted) vs 10 MiB + 1 byte (rejected); 11 images; GIF animation preserved byte-for-byte.
- File names with `]`, `(`, spaces, emoji, no extension; clipboard image with empty `File.type`.
- Two quick successive pastes resolving out of order — each lands in its own placeholder.
- Viewer on phone; doc slug renamed after upload (URL uses id, still resolves).
- SVG containing `<script>` opened directly in a tab — script must not run.

## Dependencies on other items (by number) and files likely touched
- #8 (history) for undo ACs; #11 shares the paste handler (order: plain-text override → image → svg text →
  table → default; 00 §4.7); #23 edit tokens are sent with the upload; #26 should hide `assets/`;
  #19 HTML export may inline or keep these absolute URLs.
- Files: new `src/editor/imagePaste.ts` (registered in `src/editor/extensions.ts`), `src/components/DocView.vue` (dialog,
  pasteId/share hook-up), `src/composables/useShare.ts` (upload helper), the #20 files route module under
  `server/routes/` (`assets/` validation + headers).

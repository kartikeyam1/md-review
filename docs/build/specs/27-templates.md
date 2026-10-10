# 27 — Templates: save as template / new from template

## Goal
Recurring docs (weekly leadership updates, design docs, QA findings) start from a consistent skeleton instead of a blank page.
People and agents can turn any doc into a template, create a new doc from one in two clicks or one MCP call, and get
`{{date}}`-style variables filled in on create. Five seed templates ship out of the box.

## Scope / Out of scope
In: template storage + API (**needs #20 `templates` table**), seed templates, "Save as template" dialog in the doc view,
"New from template" picker on the landing page and the library, a Templates tab in the library (list, rename, delete),
variable substitution, MCP `list_templates` + `create_from_template`.
Out: editing a template's content in place (re-save a doc under the same name to replace it), multi-file templates (only the
primary doc's content is captured), per-template permissions, prompting the user for custom variables in the UI,
an MCP `save_as_template` tool.

## Current state
- No template concept anywhere. New docs start from the landing page `src/components/FileUpload.vue:113-119`
  (Paste / From GitHub / Start blank, `startBlank` at `:67-69` emits `''` + `untitled.md`).
- Docs are created by `POST /paste` (`server/server.cjs:587-647`): `sessionName` → slug (`:612-623`), `author` becomes the first
  revision's `by` only (`:625-628`), arbitrary body fields (e.g. `contentType`) are stored in meta.
- MCP `create_session` builds the share URL as `#shared=` (`server/mcp-server.js:94-117`); tools are registered twice, in
  `server/mcp-server.js:385+` (stdio) and `server/mcp-server-http.js:21+` (`registerTools`), sharing `createHandlers`.
- Reader name: `src/composables/useReviewer.ts` (localStorage `md-review-reviewer`).
- No renderer for `:rag-*[...]` badges exists yet (`grep rag src` finds nothing); callouts are item #16.

## Behaviour
### Templates and storage
1. A template is `{id, name, description, content, contentType: 'markdown'|'html', mode: 'publish'|'review', collectionId|null,
   builtin, created_by, created_at, updated_at}`. `name` is 1–80 chars, unique case-insensitive across all templates;
   `description` ≤ 280 chars; `content` ≤ 1 MB. `collectionId` is the default collection for docs created from it.
2. Seed templates (below) are builtin with fixed ids `seed-weekly-update`, `seed-design-doc`, `seed-qa-findings`,
   `seed-pr-review`, `seed-research-brief`. The server upserts builtin rows from files in `server/templates/` at boot
   (only `builtin` rows are touched, so a release can update seed content). Builtin templates cannot be renamed, deleted or
   replaced (403); a user template may not take a builtin's name (409).
3. Deleting a collection sets `collectionId` to null on templates that referenced it.

### Variables
4. Syntax: `{{name}}` with optional inner spaces (`{{ date }}`); `name` matches `[a-zA-Z][a-zA-Z0-9_]*`, case-sensitive.
5. Built-in values: `title` (the new doc's title), `date` (`YYYY-MM-DD`), `week` (ISO week, `2026-W41`), `author` (creator name),
   `collection` (target collection name). `date`/`week` use the request's IANA `timezone` (UTC if absent or invalid).
   Custom values may be supplied as `variables` (string values ≤ 500 chars, ≤ 20 keys); they override built-ins.
6. A placeholder whose name has no value (unknown name, no author given, no collection) is left verbatim, so the author sees
   what to fill in. `\{{name}}` produces the literal `{{name}}`. Substitution is single-pass (a value containing `{{date}}`
   is not expanded again) and applies everywhere in the content, code blocks included.
7. For `html` templates, substituted values are HTML-escaped (`& < > " '`); for `markdown` they are inserted as-is.
8. The variable list of a template (`variables`) is the sorted, de-duplicated set of names its content uses (escaped ones excluded).

### New from template (UI)
9. `landing-new-from-template` (landing alt-actions) and `library-new-from-template` (library header) open `template-picker`.
10. The picker lists templates (`template-picker-item`: name, description, `template-builtin-badge` for seeds, type, variable
    chips), builtins first then user templates by name; a filter box `template-picker-filter` appears when there are > 8.
    Selecting one shows a form: `template-title-input` (required, 1–200 chars), `template-collection-select` (default = the
    template's collection, else Unfiled), `template-author-input` (prefilled with the reader name), and `template-preview`,
    which renders the substituted content (debounced 300 ms) using the server dry-run endpoint and the normal renderer.
11. `template-create-btn` is disabled until the title is non-empty. Enter in the title submits; Esc closes the picker.
12. Create calls instantiate; on success the app navigates to `/d/<slug>?view=edit` and the creator holds the doc's edit token
    (per #23). On failure a toast shows the error and the picker stays open with inputs intact.
13. The created doc: `sessionName` = title (slug derived as for any doc), `filename` = slugified title + `.md`/`.html`,
    `contentType` and `mode` from the template, `created_by` = author (if given), collection as chosen,
    `from_template: {id, name}` in meta, default expiry as for new docs.

### Save as template (UI)
14. `doc-save-as-template` is an item of `header-overflow-menu` (00 §2.3) for anyone who can view the doc (it copies, never
    mutates it), except on file routes and pinned revisions.
15. It opens `template-save-dialog`: `template-save-name` (prefilled with the doc title), `template-save-description`,
    `template-save-collection` (prefilled with the doc's collection), `template-save-mode` (prefilled with the doc's mode),
    and checkbox `template-save-title-var` (default on) "Use {{title}} in place of this doc's title", which replaces the text of
    the first `# ` heading (markdown) or the `<title>` and first `<h1>` text (html) with `{{title}}`.
16. Content saved is what is on screen for the primary doc (unsaved editor edits included). Session files are not captured.
17. Name clash with a user template shows `template-save-error` with `template-save-replace`; confirming replaces that template's
    content and fields. A clash with a builtin shows the error without a replace option. Success shows a toast with a link to the
    library Templates tab.

### Templates tab (library)
18. `/library?tab=templates` (`library-tab-templates`) lists `template-item`s with `template-use` (opens the picker preselected)
    and, for non-builtin templates, `template-menu` with rename (same name rules) and delete (confirm `template-delete-confirm`).
    Deleting a template never affects docs created from it.

### MCP
19. `list_templates()` → `[{id, name, description, contentType, mode, builtin, variables, collection: {id, name}|null}]`.
20. `create_from_template({template, title, author?, variables?, collection?, slug?, expiryDays?, timezone?})`: `template` is an id or
    a name (case-insensitive); `collection` an id or name. Unknown template or collection → `{error}` naming the available options;
    nothing is created. Returns `{id, slug, shareUrl, editUrl?}` with `shareUrl` = `url` per 00 §6 (`<frontend>/d/<slug>`
    unless `PUBLIC_BASE_URL` is set). Registered in both
    MCP servers; the description tells agents to pass `author` and that unfilled placeholders stay verbatim.

### Seed templates (content of `server/templates/*.md`)
**Weekly leadership update** (`seed-weekly-update`, markdown, publish) — "One-screen status for leadership, readable on a phone."
```markdown
# {{title}}

**Week {{week}}** · {{author}} · {{date}}

> [!NOTE]
> **TL;DR** — one sentence a leader can act on.

## Status at a glance
| Workstream | Status | Note |
|---|---|---|
| Workstream A | :rag-green[On track] | |
| Workstream B | :rag-amber[At risk] | |
| Workstream C | :rag-red[Off track] | |

## Wins
- 

## Risks and asks
> [!WARNING]
> What you need, from whom, by when.

## Next week
- 
```
**Design doc** (`seed-design-doc`, markdown, publish) — "Problem, options, decision — for a change others must agree on."
```markdown
# {{title}}

{{author}} · {{date}} · Status: :rag-amber[Draft]

> [!NOTE]
> **Summary** — what changes and why, in three lines.

## Problem
## Goals / Non-goals
## Options considered
| Option | Pros | Cons |
|---|---|---|
| A | | |
| B | | |

## Decision
> [!IMPORTANT]
> The chosen option and the one reason that decided it.

## Rollout and risks
## Open questions
- 
```
**QA findings** (`seed-qa-findings`, markdown, review) — "Test run results with severity, for triage."
```markdown
# {{title}}

Tested by {{author}} on {{date}} · Build: `…` · Environment: `…`

> [!NOTE]
> Overall: :rag-amber[Ship with fixes] — N findings, N blocking.

## Findings
| # | Severity | Area | What happens | Expected |
|---|---|---|---|---|
| 1 | :rag-red[Blocker] | | | |
| 2 | :rag-amber[Major] | | | |
| 3 | :rag-green[Minor] | | | |

## Steps to reproduce
### 1.
1. 

## Not tested
> [!CAUTION]
> Anything out of scope or blocked, so nobody assumes it passed.
```
**PR review** (`seed-pr-review`, markdown, review) — "Structured review of a pull request."
```markdown
# {{title}}

Reviewer: {{author}} · {{date}} · PR: …

> [!NOTE]
> Verdict: :rag-amber[Changes requested] — the one thing that must change.

## Must fix
- 

## Should fix
- 

## Nits
- 

## What's good
> [!TIP]
> Patterns worth repeating elsewhere.
```
**Research brief** (`seed-research-brief`, markdown, publish) — "Question, evidence, recommendation."
```markdown
# {{title}}

{{author}} · {{date}}

> [!NOTE]
> **Question** — what we set out to learn, and who asked.

## Answer
:rag-green[High confidence] One paragraph.

## Evidence
| Source | Finding | Confidence |
|---|---|---|
| | | :rag-amber[Medium] |

## Recommendation
> [!IMPORTANT]
> What to do next and who owns it.

## Open questions
- 
```

## Acceptance criteria
AC-27.1 Given a fresh data dir, When `GET /templates`, Then exactly the 5 seed ids are returned with `builtin: true`, and the weekly update's `variables` equals `["author","date","title","week"]`.   [verify: server]
AC-27.2 Given `POST /templates/seed-weekly-update/instantiate {title:"Ops W41", author:"Asha", timezone:"Asia/Kolkata"}` at 2026-10-10T20:00Z, Then 201 with `{id, slug}`, and the doc's markdown starts with `# Ops W41` and contains `**Week 2026-W41** · Asha · 2026-10-11`.   [verify: server]
AC-27.3 Given a template containing `{{unknown}}`, `\{{date}}`, `{{ date }}` and `{{author}}`, When instantiated without author, Then the result contains `{{unknown}}`, the literal `{{date}}`, today's date, and `{{author}}` verbatim.   [verify: unit]
AC-27.4 Given an html template `<h1>{{title}}</h1>` and title `<script>x</script>`, Then the created doc contains `&lt;script&gt;x&lt;/script&gt;` and no `<script>` element.   [verify: server]
AC-27.5 Given `variables: {title: "{{date}}"}`, Then the doc contains the literal `{{date}}` where the title goes (single pass).   [verify: unit]
AC-27.6 Given the landing page, When clicking `landing-new-from-template`, choosing "Design doc", typing title "Cache rewrite" and pressing Enter, Then the URL becomes `/d/cache-rewrite?view=edit` (or a de-duplicated slug), the editor shows `# Cache rewrite`, and the doc is editable by this reader.   [verify: e2e]
AC-27.7 Given the picker with a template selected, When typing a title, Then within 1 s `template-preview` shows the substituted heading; `template-create-btn` is disabled while the title is empty.   [verify: e2e]
AC-27.8 Given a doc titled "Incident review" in collection "Ops", When using `doc-save-as-template` with defaults, Then `GET /templates` includes "Incident review" whose content's first heading is `# {{title}}`, `collectionId` = Ops, and creating from it with title "Outage 12" yields `# Outage 12` and lands in "Ops".   [verify: e2e]
AC-27.9 Given an editor with unsaved edits adding "DRAFT-LINE", When saving as template, Then the template content contains "DRAFT-LINE".   [verify: e2e]
AC-27.10 Given an existing user template "Incident review", When saving another doc with that name, Then `template-save-error` shows with `template-save-replace`; confirming replaces the content. Saving with name "design doc" shows the error with no replace option (409).   [verify: e2e]
AC-27.11 Given `/library?tab=templates`, Then seed `template-item`s have `template-builtin-badge` and no `template-menu`; deleting a user template via its menu removes it while docs made from it still open.   [verify: e2e]
AC-27.12 Given `PATCH` or `DELETE /templates/seed-design-doc`, Then 403 and the template is unchanged.   [verify: server]
AC-27.13 Given MCP `create_from_template({template:"weekly leadership update", title:"W41", author:"agent-x", collection:"Ops"})`, Then it returns `shareUrl` ending `/d/<slug>` and the doc is in "Ops" with `from_template.id = "seed-weekly-update"`; with `template:"nope"` it returns an error listing the 5+ template names and creates nothing.   [verify: server]
AC-27.14 Given MCP `list_templates()` on both the stdio and HTTP servers, Then each returns the same template list.   [verify: server]
AC-27.15 Given phone 390×844, When opening the picker, Then it fills the viewport width without horizontal scroll and the create button is reachable without zooming.   [verify: visual]

## Test hooks (data-testid list) and API/MCP contract changes
Testids: `landing-new-from-template`, `library-new-from-template`, `template-picker`, `template-picker-item`, `template-picker-filter`,
`template-builtin-badge`, `template-title-input`, `template-collection-select`, `template-author-input`, `template-preview`,
`template-create-btn`, `doc-save-as-template`, `template-save-dialog`, `template-save-name`, `template-save-description`,
`template-save-collection`, `template-save-mode`, `template-save-title-var`, `template-save-error`, `template-save-replace`,
`library-tab-templates`, `template-item`, `template-use`, `template-menu`, `template-delete-confirm`.

API (**flag for #20: needs a `templates` table and `from_template`/`created_by` columns on docs**):
- `GET /templates` → list (no `content`, includes `variables`); `GET /templates/:id` → with `content`.
- `POST /templates {name, description?, content, contentType, mode?, collectionId?, author?, replace?}` → 201; 409 on name clash
  unless `replace: true` and the existing one is not builtin (then 200).
- `PATCH /templates/:id {name?, description?, collectionId?}`; `DELETE /templates/:id` → 204; builtin → 403.
- `POST /templates/:id/render {title, author?, variables?, collectionId?, timezone?}` → `{content}` (dry run, creates nothing).
- `POST /templates/:id/instantiate {title, author?, variables?, collectionId?, timezone?, slug?, expiryDays?}` → 201
  `{id, slug, editToken?}` (edit token shape owned by #23). Validation errors → 400 with `{error}`.
MCP: new tools `list_templates`, `create_from_template` in `createHandlers` and both registrations.

## Edge cases the adversarial verifier must try
- Placeholders split across lines, nested braces `{{{title}}}`, `{{title}` (unclosed), `{{ }}`, `{{1abc}}`, mermaid hexagon nodes `A{{Decide}}` — only valid known names change.
- Title with `$&`, `$1`, backslashes or regex specials (must be inserted literally, no `String.replace` pattern expansion).
- Timezone `Not/AZone`, timezone at year boundaries (2026-12-31 → ISO week `2026-W53`, 2027-01-01 → `2026-W53`).
- Instantiate with a deleted `collectionId`; delete the collection a template defaults to, then open the picker.
- Save-as-template on an html doc, a doc with no heading (checkbox has nothing to replace — saves content unchanged), and a 1 MB+ doc (clear error).
- Two templates whose names differ only by case or surrounding whitespace.
- Create from template while offline — picker stays open, nothing navigates.

## Dependencies on other items (by number) and files likely touched
Needs #20 (tables), #26 (library page, collections, Templates tab host), #4 (`/d/:slug` routes and `?view=edit`), #23 (edit token
on create), #2 (`mode`). Seeds use #16's callout and `:rag-<colour>[label]` syntax exactly (#16 rule 10 is the single definition);
#16 lands before this item, so seeds render styled.
Files: new `server/routes/templates.cjs` (00 §4.9), new `server/templates/` (seed `.md` files + manifest) and a pure
`server/template-vars.cjs` (substitution, unit-tested), `server/mcp-server.js`, `server/mcp-server-http.js`,
new `src/components/TemplatePicker.vue`, `SaveTemplateDialog.vue`, `src/composables/useTemplates.ts`,
`src/components/FileUpload.vue`, `src/components/LibraryView.vue`, `src/components/HeaderOverflowMenu.vue` (one item).

## Decisions
- `{{name}}` syntax, but only names with a value are replaced and the rest stay verbatim — keeps mermaid `{{hexagon}}` nodes and code samples safe and shows authors what is unfilled.
- Substitution runs on the server only (with a dry-run endpoint for the preview), so UI, MCP and API produce identical output.
- A template's "collection" is the default collection for docs created from it, editable at create time.
- Save as template is open to viewers: it copies content and changes nothing about the source doc.
- QA findings and PR review seeds default to `review` mode (comments and must-fix are the point); the others to `publish`.
- New docs open in `?view=edit` because a skeleton is meant to be filled in immediately.

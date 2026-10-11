# #27 Templates — server + MCP half (implementer report)

Verdict: **DONE**. Worktree `/home/ubuntu/locus-repos/md-review-cap-library-27srv` (detached at 3796a62), nothing committed.

## Gate
`VERIFY_ITEMS=27 scripts/verify.sh --only server` → **OVERALL: PASS**, `server PASS 442/443 pass, 0 fail, 1 skip (45.0s)`
(the skip is the existing `20-real-data` live-data test). Item suites: `server/27-template-vars.test PASS 22/22`,
`server/27-templates.test PASS 30/30`. Logs: `.verify/runs/20261010-222751-2858495/logs/`.

## Files
New
- `server/template-vars.cjs`: a pure module (`listVariables`, `substitute`, `isoWeek`, `dateValues(now, tz)`, `validateVariables`, `templateValues`, `renderTemplate`, `escapeHtml`). The clock is injected.
- `server/templates/manifest.json` and 5 seed files (`weekly-update.md`, `design-doc.md`, `qa-findings.md`, `pr-review.md`, `research-brief.md`). They were extracted byte-for-byte from the spec, trailing `- ` included.
- `server/routes/templates.cjs`: the whole `/templates*` API, plus `upsertSeeds()` at module load (boot).
- `server/test-items/27-template-vars.test.mjs`: unit tests for AC-27.3, AC-27.5 and the edge cases (split/nested/unclosed braces, `{{ }}`, `{{1abc}}`, mermaid `A{{Decide}}`, `$&`/`$1`/backslash, invalid tz → UTC, ISO week at the year boundary 2026-12-31 / 2027-01-01 → 2026-W53, html escaping, variable limits).
- `server/test-items/27-templates.test.mjs`: server tests for AC-27.1, 27.2, 27.4, 27.12, 27.13, 27.14, plus validation, name uniqueness (case and whitespace), builtin 403/409, replace, render creating nothing, a deleted collectionId, a deleted default collection reading as null, the 1 MB limit, the created doc's meta, edit-token validity, the boot upsert leaving user rows alone, list order, CORS PATCH, and the MCP description.

Modified (shared files kept minimal)
- `server/server.cjs`: one ROUTES line, after `library-docs.cjs`.
- `server/mcp-server.js`: two handlers in `createHandlers`, and two `registerTool`s inside the existing `registerSharedTools()`. Both the stdio and HTTP servers already call that function, so `mcp-server-http.js` is untouched.
- `docs/build/DECISIONS.md`: 9 `- #27:` lines.

## API notes (for the FE half)
- `GET /templates` returns the list without content, builtins first and then user templates by name. Each item is `{id, name, description, contentType, mode, collectionId, collection:{id,name}|null, builtin, created_by, created_at, updated_at, variables}`.
- `GET /templates/:id` returns the same shape plus `content`.
- `POST /templates {name, description?, content, contentType?, mode?, collectionId?, author?, replace?}`
  - Success: 201.
  - Replace of a user template: 200, and it keeps that template's id.
  - Name clash: 409 `{error, code:'name_taken', builtin, id}`. `builtin:true` means the dialog must not offer Replace.
  - Validation failure: 400. Content over 1 MB gives "Template content is larger than 1 MB".
- `PATCH /templates/:id {name?, description?, collectionId?}`: 200 on success, 403 for a builtin, 404 if unknown, 409 on a name clash. A user may rename a template to its own name in a different case.
- `DELETE /templates/:id`: 204 on success, 403 for a builtin, 404 if unknown.
- `POST /templates/:id/render {title?, author?, variables?, collectionId?|collection?, timezone?}` returns `{content}`. It creates nothing.
- `POST /templates/:id/instantiate {title, author?, variables?, collectionId?|collection?, timezone?, slug?, expiryDays?}` returns 201 with `{id, slug, mode, url, viewUrl, app_url, editToken, editUrl, collection}` and `Cache-Control: no-store`.
  - Collection: `collectionId` absent means the template's default (a deleted default counts as unfiled). `null` means unfiled.
  - An unknown collection gives 400 `{error, code:'unknown_collection', available}` and nothing is created.
  - The created doc gets `sessionName`, `filename = slug(title)+.md|.html`, `contentType` and `mode` from the template, `created_by`, `from_template`, the default 30-day expiry, and a `collection_items` row. It is all written in one transaction.
- MCP `list_templates()` returns `[{id, name, description, contentType, mode, builtin, variables, collection}]`.
- MCP `create_from_template({template, title, author?, variables?, collection?, slug?, expiryDays?, timezone?})`:
  - `template` is matched by id, or by name case-insensitively. An unknown template returns `{error}` listing every template name, and nothing is created.
  - It returns `{id, slug, mode, template, collection, shareUrl, url, app_url, editToken, editUrl}`.
  - The token is saved to the token store under both the id and the slug, the same way `create_session` does it.

## Decisions (also in DECISIONS.md)
- **Clock:** I reused the existing #25 test clock `MDREVIEW_NOW` (00 §10.5) for `{{date}}`/`{{week}}`. AC-27.2 boots its own backend with `MDREVIEW_NOW=2026-10-10T20:00:00Z`. The date logic is also unit-tested with an injected `now`. No new env var was added.
- **Placeholder syntax:** spaces and tabs are allowed inside the braces, but a line break is not. In `{{{x}}}` only the inner placeholder is replaced. `variables` lists every valid name, including unknown ones.
- **Collections without #26:** the server resolves collections itself (by id, slug or name) against the `collections` table. Because of that, MCP does not depend on `/library/collections`.
- **Dangling collectionId:** it is resolved at read time, so it reads as null. No hook into #26's collection delete is needed.
- **`from_template` storage:** it is written to `sessions.from_template_json` and also kept as a meta key in extra_json. `GET /paste/:id` therefore shows it without any change to `session-rows.cjs`, which #26 owns.

## For the captain (merging onto #26)
- The only shared-file touches are the one ROUTES line, the `registerSharedTools` additions in `mcp-server.js`, and DECISIONS.
- The tests create collections through `POST /library/collections` and fall back to SQL when that route answers 404. Deletes go through `DELETE /library/collections/:id` with a SQL fallback. They should pass unchanged after #26.
- If #26 later decodes `from_template_json` into meta, it gives the same value as the stored meta key, so nothing conflicts.

## Frozen-test changes / pre-existing test changes
None. No frozen tests existed for #27; I wrote both test files first, as instructed.

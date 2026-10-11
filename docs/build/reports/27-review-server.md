# #27 Templates (server + MCP half): code review

Verdict: **PASS, no blockers.**

Scope: the `git diff` plus untracked files in `md-review-cap-library-27srv` (detached at 3796a62), checked against `specs/27-templates.md` and 00 §1.4, §5, §6 and §10.5.

## Evidence
- Ran `node --test server/test-items/27-template-vars.test.mjs server/test-items/27-templates.test.mjs`: **52 pass, 0 fail**.
- Ran a byte comparison between the spec's code blocks and `server/templates/*.md` plus `manifest.json`. For all 5 seeds, the name, contentType, mode and description match exactly. Each body equals the spec block plus one trailing newline, and the trailing `- ` lines are kept.
- Probed `template-vars.cjs` by hand:
  - `$& $1 \` are inserted literally.
  - `{{{title}}}` becomes `{value}`.
  - `{{title}`, `{{ }}`, `{{1abc}}` and `A{{Decide}}` stay verbatim.
  - `\{{date}}` becomes the literal `{{date}}` and is left out of `variables`.
  - `Not/AZone` falls back to UTC.
  - 2026-12-31 and 2027-01-01 are both in week `2026-W53`, and 2024-12-30 is in `2025-W01`.
  - 2026-10-10T20:00Z in Asia/Kolkata gives `2026-10-11` / `2026-W41`.
  - HTML escaping covers `& < > " '`.

## What was checked and is correct
- **Substitution:** it makes one pass with a replacer function, so the AC-27.5 case passes. Values are inserted literally. A name with no value stays verbatim. Values are HTML-escaped only for html templates.
- **Builtin protection:** PATCH and DELETE on a builtin return 403. A user template may not take a builtin's name: POST, including with `replace:true`, and PATCH both return 409. User ids are `tpl-…`. The boot upsert touches builtin rows only.
- **Instantiate meta:** it matches `POST /paste`: same slug rules (reserved slugs, `-2` suffix), `approval_status`, `sharedAt`, 30-day default expiry, `created_by`, and the token hash per #23. It also sets mode from the template (00 §1.4), filename `slug(title).md|.html`, `from_template`, and the collection row. Everything is written in one transaction. It returns 201 with `Cache-Control: no-store`.
- **MCP:** handlers live in `createHandlers` and are registered through `registerSharedTools`, which both servers call. Unknown template returns `{error}` listing the names, and nothing is created. `shareUrl` uses `handedOutUrl` (00 §6). The token store saves under both id and slug, the same as `create_session`.

## SHOULD-FIX
1. **`from_template` is stored twice** (`routes/templates.cjs:281,290`): once in `sessions.from_template_json` and once as an `extra_json` meta key.
   - The meta key can be overwritten by any meta PUT, and a full-meta save that omits it drops it. The column then disagrees with what `GET /paste/:id` reports.
   - Fix, at the #26 merge: have `session-rows.cjs` decode `from_template_json` into meta. Then stop writing the meta key, and add `from_template` to `COLUMN_OWNED` so a client cannot spoof it.
2. **Unknown-collection error shape differs on `PATCH` and `POST /templates`** (`templates.cjs:174-178,214,252`). These return `{error, code}`. render and instantiate return `unknownCollectionError()` with `available`. Fix: use `unknownCollectionError(raw)` in `checkCollectionId` callers as well.

## NIT
- `allTemplates()` (`:73-77`) orders builtins by id, so "Weekly leadership update" comes last. Order them by manifest position instead, for example with an `order` field in `data_json`.
- MCP `apiCall` maps every 404 to "Session not found" (`mcp-server.js:72-75`). If a template is deleted between the list call and instantiate, the agent gets a misleading message. Fix: on 404 in `create_from_template`, return `Template "<name>" no longer exists`.
- `patch()` parses the body before the builtin check, so invalid JSON on a seed returns 400, not 403. Check `t.builtin` before `readJsonBody`.
- The instantiate collection is resolved outside the transaction (`:285`). If the collection is deleted concurrently, the FK insert fails and the request returns 500. Fix: re-check the collection inside the `tx`, or treat it as unfiled.
- If a future seed reuses an existing user template's name, the boot upsert inserts it anyway, which breaks name uniqueness silently. Log a warning there.

## POLISH (security hardening, out of spec scope)
- `POST`, `PATCH` and `DELETE /templates` have no auth, so anyone can rename or delete any user template. The spec puts per-template permissions out of scope. Consider requiring the `created_by` match or a token later.
- There is no cap on the number of templates (each up to 1 MB), so disk growth is unbounded. Add a count cap or per-client rate limiting.
- Titles may contain newlines, which then reach `# {{title}}` and `sessionName` unchanged and can inject markdown structure. Reject or collapse control characters in `title` (instantiate) and `name` (POST and PATCH).
- `unknownCollectionError` lists every collection name to any caller. This is acceptable today because `/library/collections` is public, but revisit if collections become private.

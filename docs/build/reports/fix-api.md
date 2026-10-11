# Fix lane: api (persona-agent findings + server/MCP items from engineer/leader)

Worktree `/home/ubuntu/locus-repos/md-review-fixapi` (lane/fixapi, base 8be2187). Server, MCP and CLI only; no UI code touched.
Patch: `scratchpad/fix/api.patch`.

## Findings → fix (all reproduced first: the 30 new tests fail on a clean 8be2187 worktree, 30/30 red → green)

| # | Finding | Fix | Test |
|---|---|---|---|
| agent 1 | MCP backend errors had isError=false | `toolResult` sets `isError` on every `{error}` result (both servers, all tools); 404s name what is missing (Session / Comment / Reply / File / Revision / Upload not found + which tool lists ids); 409/410/412/413 get a `hint`; 403 gets its own "token does not match this document" message (401 guidance kept as `hint`) | qa-api-mcp #1 |
| agent 2 | >1 MB chunked writes skipped expectedContentHash, no content_hash, size in chars, by:null | upload/start takes If-Match (or base_hash/expectedContentHash), checked on start and complete (412 like PUT /markdown); complete returns `content_hash` + byte `size`; MCP sends `author` (default agent); chunks never split a surrogate pair (MCP + CLI); filename only changes when given | qa-api-mcp #2, rest-cli chunk test |
| agent 3 | get_file garbled binary | get_file returns `{name, mime, encoding, size, content}`: utf-8 for valid text, base64 otherwise; chunked base64 add_file (>1 MB) now stores decoded bytes (server took `encoding` on start) | qa-api-mcp #3 |
| agent 4 | add_file_via_shell base64 >1.5 MB "Argument list too long", exit 0 | `base64 < f | tr -d '\n\r' | jq -Rs …` (pipe, GNU+BSD base64); all shell commands use `curl -sS --fail-with-body --data-binary @-` (HTTP errors exit non-zero, print the body); file names go in via `--arg`/escaping | qa-api-mcp #4 |
| agent 5 | slug rename 404s old links | old slug kept as an alias (slugs table row stays); meta page canonical/redirect → new slug; aliases block other docs; `""` releases; delete frees all | qa-api-mcp #5 |
| agent 6 | comments on publish docs vanish silently | accepted + `X-MdReview-Warning` / `X-MdReview-Visible:false` headers; MCP result gets `visible:false` + `warning`; add_comment description says so (DECISIONS) | qa-api-mcp #6 |
| agent 7, engineer m4 | approval survives content changes | any content change to an approved doc → pending, `approval_reset_at`, webhook `{pending, reason: content_changed}`; approvals store `approved_revision` (GET /approval) | qa-api-mcp #7, rest-cli approval |
| agent 8 | no mode on upsert_session / CLI | upsert_session `mode` (on create; warning when a later run asks for another mode); by-key responses report `mode`; CLI `--mode` on create/publish (validated) | qa-api-mcp #8, rest-cli CLI |
| agent 9 | token remembered only under the identifier used; get_views silent | an explicit token is saved under the identifier + the doc's id and slug; get_views without a token adds a `note` | qa-api-mcp #9 |
| agent 10 | 403 reused "Pass editToken" | distinct MCP + CLI message | qa-api-mcp #1, rest-cli |
| agent 11 | unknown revision → "Session not found" | REST: any non-hash/unknown hash → JSON 404 `unknown revision`; MCP → "Revision not found …"; description fixed (410 = no longer stored) | qa-api-mcp #1, #11 |
| agent 12 | sessionId docs / keys | every sessionId described as id, slug (old slugs too) or upsert key; keys resolved via by-key; invalid ids refused before reaching a path/shell command | qa-api-mcp #9 |
| agent 13 | og:description leaks `:rag-green[…]` | stripInlineMarkdown drops RAG directive syntax and `[!NOTE]`-style markers | rest-cli #13 |
| agent 14 | 3 create shapes | MCP + CLI create → {id, slug, mode, url, viewUrl, app_url, editToken, editUrl}; REST kept (goldens) — DECISIONS | qa-api-mcp shapes, rest-cli |
| agent 15 | /llms.txt incomplete | full guide: modes, edit tokens, by-key, If-Match, approval, all MCP tools, MCP endpoint, CLI, files, pinned raw | rest-cli #15 |
| agent 16 | comment anchors unvalidated | non-UI clients: lines past the end → 400 invalid_anchor (1 line slack); unknown quote → warning; reactions unchanged (#24 rule) | qa-api-mcp #6 |
| agent 17 | bad MCP_TOKEN_STORE only a warning | a directory → `<dir>/edit-tokens.json`; unusable store → both servers exit at startup with a clear message; README documents it | qa-api-mcp #17 |
| agent 18 | upload_via_shell overwrote filename | filename only when passed (also CLI `upload`, MCP chunked writes); author agent + client mcp | qa-api-mcp #4, rest-cli |
| agent 19 | CLI arg parsing | options anywhere; unknown option / command / missing value → error + exit 1; `--help` | rest-cli CLI |
| agent 20 | HTTP filePath | schema descriptions and the error point at create_via_shell / upload_via_shell / add_file_via_shell | qa-api-mcp shapes |
| agent 21 | list items lack url/key | `url` + `upsert_key` (additive keys allowed by #20) | qa-api-mcp, rest-cli |
| agent 22 | cover "Markdown" twice / same weekly cover | won't change: #22 rule 8 / AC-22.11 mandate both; the date already varies (DECISIONS) | — |
| agent 23 | pinned meta title / no raw | `<title>`/`<h1>` "(earlier revision)" (og:title frozen); `/d/x@rev.md`; alternate link on pinned pages; file raw = `/paste/x/files/<name>` (llms.txt) | rest-cli #23 |
| agent 24 | README "No backend" | intro rewritten; new "Agents: MCP server and CLI" section | (verifier) |

Engineer/leader items checked for server work: engineer m4 (approval) done above. Engineer M6 (individual saves inside a coalesced revision) and leader M4 ("changed sections" summary) need UI/editor-lane decisions first; the editor lane already added `overwrite:true` → noCoalesce in markdown.cjs. **I did not edit server/routes/markdown.cjs** (the approval reset lives in storage.savePaste, the chunked guard in routes/uploads.cjs), so that flag is untouched.

## Frozen test edited (justified)
`server/test-items/lib/20-golden.mjs`: one narrow `INTENDED_CHANGES` entry — the golden step "meta A: old slug gone" (legacy 404) must now answer 200 with the renamed doc. Finding agent #5 proves the legacy behaviour wrong; everything else in the golden comparison is unchanged (other new response data was put in headers / additive keys so the goldens still match).
`server/test-mcp.mjs` (not an item test): two `equal('Session not found')` → `match(/^Session not found/)` (the message now continues with guidance).

## Security hardening (not fixed, for POLISH.md)
- Comments/replies/resolve/approval are unauthenticated: a view-link reader can edit/delete anyone's comment and approve (engineer m3). Needs an authorship/permission model.
- `curl --fail-with-body` needs curl ≥ 7.76 on the agent machine (older curl errors out loudly, never silently).

## Blind re-check
Fresh general-purpose verifier (blind, 20 min; report `.verify/qa/fixapi/verifier-report.md`): **PASS, all 19 checked items fixed**, 4 minor + 2 cosmetic new defects. Addressed: D1 publish/upsert create results now carry viewUrl/app_url; D2 412 hint corrected (fields=meta has no content_hash); D3 add_comment selectedText/body must be non-empty (zod names the field; REST message kept for the #20 goldens); D4 a corrupt token store is copied to `<file>.corrupt-<ts>` before it is replaced; D5 CLI rejects options that do not apply to the command (`--mode` on upload). D6 (`filename: null` for upserted docs without a filename) is correct data, left as is.

## Evidence
- `qa-api-mcp.test.mjs` 21/21, `qa-api-rest-cli.test.mjs` 10/10 pass. The first 30 of them on a clean 8be2187 worktree: 0/20 and 0/10 (all red before the fix).
- Final `scripts/verify.sh --only server` (run 20261011-031100): **PASS 468/469, 0 fail, 1 skip** (20-real-data skips without real data). Earlier runs caught 2 regressions I had caused (20-fixes: a comment on a 1-line doc → one line of slack; 23-fixes: bare-key token migration in rememberToken), both fixed; one run under load average 15 had a test-meta-units timing flake that passes alone and in the final run.
- `E2E_FILES=qa-gate-features,shared-mode,02-reading-mode,21-upsert-by-key,23-view-edit-links,28-agent-view,13-focus-mode scripts/verify.sh --only build,e2e` → PASS 85/85.

# 24 — Reactions (per doc and per section)

## Goal
Readers (leadership, PMs) can acknowledge a doc or a specific section with one tap instead of writing a comment, and
authors/agents can see at a glance who reacted to what.

## Scope / Out of scope
In: fixed emoji set, doc-level and section-level (heading id) reactions, toggle per reader identity, counts + names,
REST endpoints, reader UI (doc bar + section trigger), MCP `get_reactions`.
Out: custom emoji, reactions on comments, notifications/webhooks on reactions, reactions inside HTML-doc iframes
(HTML docs get doc-level reactions only), moderation/removal of other people's reactions.

## Current state
- Headings get ids from `headingAnchorPlugin` (`src/composables/useMarkdown.ts:69-92`), replaced by #3's GitHub-compatible
  slugger (lands earlier; Unicode-preserving, duplicates `-1`, `-2`). These ids are the section keys.
- Reader identity today is only the self-declared reviewer name in localStorage `md-review-reviewer`
  (`src/composables/useReviewer.ts:3-33`); there is no anonymous browser id.
- No reaction storage or endpoint exists; table created empty by #20.

## Behaviour
1. **Emoji set** (order fixed): `+1` 👍, `tada` 🎉, `question` ❓, `eyes` 👀, `heart` ❤️, `rocket` 🚀. The API takes
   and returns the code; responses also carry `emoji`. Any other code → 400 `{error:'Unknown reaction', code:'invalid_reaction'}`.
2. **Reader identity** — canonical definition in **00 §7**; this item builds `src/composables/useReader.ts`.
   `reader_id` = `anon-` + `crypto.randomUUID()` once per browser, stored in localStorage `md-review-reader-id`
   (try/catch; in-memory fallback for the page lifetime). Reactions always key on this browser id, even when a name is
   set. `name` = current reviewer name (may be empty → anonymous). Shared with #25 and #26. Server validates
   `reader_id` `^[A-Za-z0-9_-]{8,64}$` (400 otherwise) and trims `name` to 80 chars.
3. **Storage** `reactions(session_id, section TEXT NOT NULL DEFAULT '', code, reader_id, name, created_at,
   PK(session_id, section, code, reader_id))`; `section=''` means the whole doc. Deleted with the doc.
4. **`POST /paste/:id/reactions`** body `{code, section?: string|null, reader_id, name?, on?: boolean}`.
   `section` null/absent/'' = doc; otherwise must match `^[\w-]{1,200}$` (Unicode word chars allowed) else 400.
   `on` absent → toggle; `on:true|false` → set idempotently. A repeat with a different `name` updates the name.
   Response 200 `{active: boolean, code, section: string|null, summary: <GET body>}`.
   No edit token needed (#23 open action). 404 unknown doc, 410 expired.
5. **`GET /paste/:id/reactions?reader_id=`** → 200
   `{total, doc: Group[], sections: {[headingId]: Group[]}}`, `Group` =
   `{code, emoji, count, names: string[], anonymous: number, mine: boolean}`. Only codes with count > 0 appear,
   ordered by the fixed set order; `names` = distinct non-empty names, most recent first, at most 20 (count still
   exact); `anonymous` = reactions without a name; `mine` = the querying `reader_id` has this reaction.
   `total` = all reactions on the doc. Sections whose heading no longer exists are still returned (the server does
   not parse headings).
6. **Doc reaction bar** (`reaction-bar`): shown at the end of the rendered document in read view (publish and review
   modes, markdown and HTML docs, not in `?embed=1`). One button per emoji (`reaction-btn`, `data-code`), showing
   the count (`reaction-count`) when > 0; active state (`aria-pressed="true"`) when `mine`. Click toggles with an
   optimistic update, reverted with an error `app-toast` (`data-toast="reaction-failed"`, 00 §3.1) if the request fails.
7. **Section reactions** (markdown docs only, h2 and h3 headings): when a heading has reactions, compact chips
   (`section-reaction-chip`, `data-code`) render right after the heading text (heading anatomy: 00 §2.5). Every h2/h3
   has a `section-reaction-trigger` button (`aria-label="React to section <text>"`, in tab order): on hover devices it
   is visible while the heading is hovered or focused; with `(hover: none)` or viewport < 1100px it is always visible
   (00 §12). Activating it opens a picker (`reaction-picker`, Esc layer per 00 §3.4) with the 6 emoji
   (`reaction-picker-option`, `data-code`). Picking toggles a section reaction for that heading's id. Chips for section
   ids not present in the current render are hidden. Chips and trigger are `user-select: none` and add nothing to
   heading ids/TOC text.
8. **Who reacted**: hovering (or long-press on touch) a doc button or chip shows a tooltip (`reaction-who`) listing
   names, then "and N others" for the anonymous remainder; the reader's own entry is shown as "You".
9. **Refresh**: reactions load with the doc and refresh on the same cadence as the existing remote-sync poll; no
   extra polling loop.
10. **MCP `get_reactions({sessionId})`** (both servers) returns an agent-friendly summary:
    `{total, doc: {"👍": {count, names}}, sections: [{section, reactions: {"👀": {count, names}}}]}`
    (sections sorted by total desc). No other new MCP tools.

## Acceptance criteria
AC-24.1 Given a doc, When `POST /reactions {code:'+1', reader_id:'r-aaaaaaaa', name:'Ana'}` twice, Then the first response is `active:true` with doc `+1` count 1 and names ["Ana"], the second `active:false` and count 0 (group absent).   [verify: server]
AC-24.2 Given `on:true` sent twice, Then count stays 1; `on:false` twice leaves 0.   [verify: server]
AC-24.3 Given code `thumbsup`, section `a b`, reader_id `x`, Then each → 400.   [verify: server]
AC-24.4 Given 3 readers (two named, one anonymous) reacting 🎉 on section `rollout-plan`, When `GET ?reader_id=<the anonymous one>`, Then `sections['rollout-plan']` has count 3, 2 names, `anonymous:1`, `mine:true`.   [verify: server]
AC-24.5 Given a protected doc (#23), When reacting without an edit token, Then 200.   [verify: server]
AC-24.6 Given an expired doc, Then POST and GET return 410; after the doc is deleted, its reactions are gone (re-created slug shows total 0).   [verify: server]
AC-24.7 Given a reader opens a doc and clicks 👍 in `reaction-bar`, Then the button shows `aria-pressed="true"` and count 1, and after reload it is still pressed.   [verify: e2e]
AC-24.8 Given a heading "Rollout plan" at phone width, When `section-reaction-trigger` is tapped and 👀 picked, Then a `section-reaction-chip[data-code=eyes]` with count 1 appears next to that heading.   [verify: e2e]
AC-24.9 Given reactions by "Ana" and two anonymous readers, When hovering the button, Then `reaction-who` reads "Ana and 2 others" (or "You, Ana and 1 other" for one of them).   [verify: e2e]
AC-24.10 Given the reaction request fails (server down), When clicking, Then the optimistic state reverts and `app-toast[data-toast="reaction-failed"]` appears.   [verify: e2e]
AC-24.11 Given the heading is removed from the doc in a later revision, Then its chips disappear in the UI while GET still returns the section.   [verify: e2e]
AC-24.12 Given MCP `get_reactions`, Then it returns emoji-keyed `doc` and a `sections` array sorted by total.   [verify: server]
AC-24.13 Given the reaction bar in dark and Locus themes, Then buttons have ≥ 3:1 contrast against the background and are keyboard-focusable with visible focus.   [verify: a11y]
AC-24.14 Given desktop 1400×900 and keyboard only, When Tab reaches a heading's `section-reaction-trigger` Then it is visible, Enter opens `reaction-picker`, Enter on an option adds a chip, and Esc closes the picker with focus back on the trigger; a triple-click selection of that heading contains no emoji/count text.   [verify: e2e, a11y]

## Test hooks (data-testid list) and API/MCP contract changes
Testids: `reaction-bar`, `reaction-btn`, `reaction-count`, `section-reaction-trigger`, `section-reaction-chip`,
`reaction-picker`, `reaction-picker-option`, `reaction-who`; `app-toast[data-toast="reaction-failed"]` (replaces the earlier
`toast-reaction-failed`, 00 §10.1). API: `POST|GET
/paste/:id/reactions`. MCP: `get_reactions`. localStorage key `md-review-reader-id`.

## Edge cases the adversarial verifier must try
- Rapid double-click (two toggles in flight) → final state matches server, counts never negative.
- Duplicate headings (`intro`, `intro-1`) — reactions stay on the right one.
- Heading text with emoji/CJK (section id with Unicode word chars).
- localStorage blocked (private mode) — reactions still work for the page lifetime.
- Name change between reactions — the new name replaces the old one in `names`.
- 1 000 reactions on one doc — GET stays < 100 ms; `names` capped at 20 with exact `count`.

## Dependencies on other items (by number) and files likely touched
Depends on #20 (table), #23 (open-action rule), #4/#3 (heading ids, read view), #2 (read mode). Shares
`reader_id` with #25/#26 (00 §7). Files: new `server/routes/reactions.cjs`, `server/mcp-server.js`, `server/mcp-server-http.js`,
`src/composables/useReactions.ts` (new), `src/composables/useReader.ts` (new, 00 §7), `src/components/ReactionBar.vue`
(new), new `src/preview/sectionReactions.ts` enhancer (00 §4.5), `src/components/DocView.vue`.

## Decisions
- Six fixed emoji, addressed by code — avoids emoji-variant normalisation bugs (❤ vs ❤️).
- Identity = anonymous browser id + optional self-declared name; no auth exists, and toggling must be per browser.
- Server does not validate section ids against headings — content changes; the UI hides orphans instead.
- Reactions are open to viewers even on protected docs — reacting is a reader action.

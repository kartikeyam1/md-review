# #25 view counts and named readers: code review

Scope: only the #25 delta (`scratchpad/cap-social/25-wip.patch`), checked against `specs/25-view-analytics.md`,
`00-cross-cutting.md` (§2.2, §3.4, §3.7, §7, §8) and the #25 lines in DECISIONS.md. I read the code and ran nothing
(read-only review, 15 min time-box).

**Verdict: no blockers.** The server contract (rules 1, 2, 4 and 7), the MCP tool on both servers (the HTTP server
reuses `registerSharedTools`), library `view_count` / `sort=views`, header placement and the client debounce all match
the spec. The tests cover every AC plus the listed edge cases. The frozen-test edit to `20-sqlite-storage.test.mjs`
(`view_count` null → 0) is justified by 00 §8 and follows the #24 precedent.

## SHOULD-FIX

1. **The Esc handler breaks 00 §3.4 innermost-first.** `src/components/ReadersPanel.vue:50` listens for `keydown` on
   `document` in the capture phase, then calls `preventDefault` and `stopPropagation` for every Esc, wherever focus is.
   If a layer-1/2 surface opens over the open panel from the keyboard (a shortcut, for example `shortcuts-overlay`), the
   first Esc closes the panel and not the modal. ShareModal and RevisionsModal check `!e.defaultPrevented` in the bubble
   phase, so the capture handler also starves them. Fix: handle Esc on the panel element (as `ReactionOverlays.vue`
   does for `reaction-picker`), or listen in the bubble phase and skip when `e.defaultPrevented`.

2. **A name set after the first view never reaches the server in the same page load.**
   `src/composables/useViews.ts:111` re-posts only when docId, revision or eligibility change. A reader who opens a doc
   anonymously and then types a reviewer name (the common review-mode flow: name prompt on first comment) stays in
   `anonymous_readers` until a reload, or until a revision changes. The server already merges the name into the day's
   row; that edge case is tested only at the server level. Fix: also watch `reviewerName`, and when it goes from empty
   to set for a doc already recorded this load, send one more POST. Log that as a `#25:` decision, because it adds one
   POST beyond rule 3's "one per page load + revision changes". Alternatively, record a decision that this is
   accepted.

## NIT

3. `server/routes/views.cjs:63`: `viewCount` is exported but nothing uses it (library-docs inlines its own subquery).
   Drop it, or have library-docs use one shared SQL fragment.
4. `server/routes/library-docs.cjs:138`: the `views` ORDER BY repeats the correlated subquery already in the SELECT
   list. Use `ORDER BY view_count DESC, s.updated_at DESC, s.id` (SQLite allows the alias) so the count logic lives in
   one place.
5. `useViews.ts:112`: stats reload only when docId changes. After `onTokenRejected` / `loseEditAccess`, an
   ex-editor's cached stats still carry `readers`, so `view-stats` stays a button and the panel still lists names until
   navigation. Watching the doc's capability/access (or calling `views.load()` from `loseEditAccess`) fixes it.
6. `docState.ts:213`: eligibility does not exclude `view === 'edit'`. Every autosave makes a new `serverHash`, which
   starts a new 2 s timer, which sends a POST and then a GET. That is harmless for the counts (DECISIONS explains why),
   but it is two extra requests per save while ViewStats is not even rendered in the editor header. Consider
   `&& view !== 'edit'` and recording once when the editor returns to the read view.
7. `docState.ts` pinned revision: the `/^[a-f0-9]{32}$/` check duplicates `REV_RE`, which the router already enforces
   for `kind: 'pinned'`. Import `REV_RE` or drop the check.
8. `ReadersPanel.vue`: the phone sheet has no backdrop or scrim. That is fine for a non-modal panel, but the
   `readers-close` button is the only visible affordance. Acceptable as is.

## Checked, no issue

- 204 on POST. Bodies are validated (reader_id per §7, revision 32-hex or omitted → current hash). 404/410 come from
  `openDoc`. The upsert keeps the name (`COALESCE`) and pins `is_editor` with `max(...)` (both in DECISIONS). The day
  key is `toISOString().slice(0,10)`, so it is UTC. `MDREVIEW_NOW` is ignored when unset or unparseable.
- GET: aggregates exclude editor rows. The `readers` and `anonymous_readers` keys appear only for `ok` / `legacy`.
  Grouping is case-insensitive with the newest row first (spelling, revision, time and `is_current` from that row),
  and sorted by recency through Map insertion order. Anonymous = reader ids with no named non-editor row.
  `no-store` + `Vary` are correct for a token-dependent body.
- `views` has `ON DELETE CASCADE` (#20), so a re-used slug starts at 0. The PK prefix serves the per-session queries.
- No recording on `/d/` meta, `GET /paste/*` or MCP (AC-25.13 is tested). `get_views` resolves the token through the
  #23 store.
- Client: the dwell timer is cancelled on hide, navigation, ineligibility or revision change. One POST per (doc,
  revision) per load. 5xx and network failures allow a retry. Embeds, local docs, the `?filePath=` loader and `file`
  routes are ineligible. Slug and id tokens resolve through `tokenFor` aliases.
- UI: `view-stats` is a button only when `readers` are present, and plain text for viewers (not focusable). Placement
  per 00 §2.2: after doc-updated on desktop, in `doc-meta-row` below 1100px, absent from the editor variant.
  `aria-haspopup` / `aria-expanded` are set, `role=dialog` + label is present, focus returns on Esc, the relative time
  carries the full ISO title, and the stale badge carries the short hash. The fixed panel escapes `overflow:hidden`.
  Its z-index of 200 sits inside the header's 100 stacking context, the same as the AppMenus.

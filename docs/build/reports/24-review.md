# #24 Reactions — code review

Scope: only the #24 delta (`cap-social/24-wip.patch`), read against `specs/24-reactions.md`, 00 §2.4/§2.5/§3.4/§4.5/§4.8/§4.9/§7/§8, and the #24 lines in DECISIONS.md. I read the code only. I ran no gates, which matches the reviewer role.

**Verdict: no blockers.** Four should-fix items and a few nits.

What holds up: the server matches rules 1–5. It has the 400 codes, the toggle and the idempotent `on`, a name update on a repeat, names capped at 20 with an exact count, and a 404 before a 410. Rows are removed by `ON DELETE CASCADE` with `foreign_keys=ON`. `get_reactions` goes through `registerSharedTools`, so both MCP servers get it (`mcp-server-http.js:394`). The `reader_id` follows 00 §7. The `onPoll` hook adds no polling loop of its own. The enhancer seam fits 00 §4.5 and its cleanup is correct. Pure logic has unit tests (`applyLocal`, `formatWho`, `useReader`, the store and the enhancer), and the server and e2e tests cover every AC. The frozen-test edit in `20-sqlite-storage.test.mjs:232` (`null` → `0`) is what 00 §8 says ("null until #24"), so I accept it.

## SHOULD-FIX

1. **A stale GET can overwrite a newer POST result** (`src/composables/useReactions.ts:157-168` vs `:197`). Suppose a poll's `refresh()` GET starts, the user clicks, and the POST resolves first. `wanted` is then cleared, and the late GET sets `server` back to the state from before the click. The button flips back and stays wrong until the next poll, up to 5 s. The rapid-double-click edge case can also hit this. Fix: add a `writeSeq` counter, bumped whenever a POST settles (or on `toggle`). `refresh` captures it at the start and drops the response if it changed. Alternatively, skip applying the response while `inFlight.size > 0`.

2. **The long-press click suppression can stay stuck** (`ReactionBar.vue:16-33`, `preview/sectionReactions.ts:99,119,140`). After a long press, `suppressClick = true`. If the finger then moves, or the browser fires no click, the flag stays set and the reader's next real tap does nothing. Fix: set `suppressClick = false` at the start of every touchstart, or clear it on a short timeout after touchend.

3. **Some heading ids are ones the server rejects** (`preview/sectionReactions.ts:70`). The current `headingAnchorPlugin` slugger has no length cap. A heading longer than about 200 characters gets a trigger, and every pick returns 400, which raises the `reaction-failed` toast again and again. Fix: filter headings with `SECTION_RE.test(h.id)`, imported from `@shared/reactions.mjs`, and render no trigger for ids that fail.

4. **A blanket flex rule on the content column** (`DocView.vue:268` `.doc-content > :deep(*) { flex: 1 1 0; min-height: 0 }`). 00 §2.4 puts `agent-sections-notice` (#28) in this column, before the doc. Under this rule the notice would get an equal share of the column height, so the coupling will hurt #28 (and #5 has to undo it anyway). Fix: give `flex: 1 1 0; min-height: 0` only to the pane roots (`.preview-pane`, the editor root and `.file-view`), and let other children default to `flex: none`.

## NIT

- Dead code: `reactionCount` (`server/routes/reactions.cjs:64,125`) is never called, because the library uses a subquery. `emojiOf` (`shared/reactions.mjs`) is never imported. Remove both, or have `library-docs` use `reactionCount`.
- The picker handles Esc only while focus is inside it (`ReactionOverlays.vue:64`). When focus leaves the page, `onFocusOut` deliberately keeps the picker open (`:82`), and from then on Esc does nothing. A document keydown listener while the picker is open (layer 3, and only when `!e.defaultPrevented`) would close it.
- Reactions are hidden on pinned-revision routes (`docState.ts:130`, `route.kind === 'doc'`). That is a reasonable product call, but no DECISIONS line records it.
- `formatWho` after a name change shows "You, <old name>". The server still holds the old name until the reader reacts again. This is acceptable; it could be noted in the spec's edge-case list.
- In `ReactionBar.vue:32` the 2.5 s `hideWho` timer is never cleared on unmount. It is harmless.
- `GET ?reader_id=` with an invalid id is silently treated as "no reader" (`mine` false) rather than returning 400. The spec only mandates validation on POST, so this is fine, but it could carry a one-line comment.
- `names` are ordered by first reaction time: the UPDATE does not bump `created_at`. Read strictly, "most recent first" is satisfied by reaction time, so no change is needed.

## Coupling notes for later items

- `src/preview/index.ts` defines `EnhancerContext = { content }`. #3 should extend it, not replace it. The `sectionReactions` host is inserted before `.heading-anchor`, so #3's anchor can be appended without any change here.
- `currentReactions` is a module-global store. That works because `createDocState` is a singleton (`docState.ts:247`). Any future second doc state, such as split compare, would have to scope it.

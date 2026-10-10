import { ref, shallowRef, watch, type Ref } from 'vue'
import { REACTIONS, REACTION_CODES } from '@shared/reactions.mjs'
import { getReaderId } from '@/composables/useReader'
import { useReviewer } from '@/composables/useReviewer'
import { toast } from '@/composables/useToast'
import { PASTE_API } from '@/composables/pasteApi'

// ── Reactions (#24) ──────────────────────────────────────────────────────────
// One store per doc state (createDocState creates it). It holds the server
// summary for the doc on screen, applies clicks optimistically, and sends each
// reaction's latest wanted state (`on: true|false`, never a blind toggle) one
// request at a time, so rapid clicks converge on what the server holds and
// counts never go negative. A failed request reverts to the server's state and
// raises the `reaction-failed` toast. Refreshes ride on the remote-sync poll
// (docState passes `refresh` as useSync's onPoll) — no polling loop of its own.

export interface ReactionGroup {
  code: string
  emoji: string
  count: number
  /** Distinct non-empty names, most recent first, at most 20. */
  names: string[]
  /** Reactions without a name. */
  anonymous: number
  /** This browser's reader id has this reaction. */
  mine: boolean
}

export interface ReactionSummary {
  total: number
  doc: ReactionGroup[]
  sections: Record<string, ReactionGroup[]>
}

const ORDER = new Map(REACTION_CODES.map((c, i) => [c, i]))
const EMOJI = new Map(REACTIONS.map((r) => [r.code, r.emoji]))
export const emptySummary = (): ReactionSummary => ({ total: 0, doc: [], sections: {} })

/** The groups for the whole doc (section null/'') or one heading id. */
export function groupsOf(summary: ReactionSummary | null, section: string | null): ReactionGroup[] {
  if (!summary) return []
  return section ? (Object.prototype.hasOwnProperty.call(summary.sections, section) ? summary.sections[section] : []) : summary.doc
}

/**
 * Pure: `summary` with this reader's `code` reaction on `section` set to `on`
 * (optimistic update). Named readers add/remove their name, anonymous ones the
 * anonymous count; a group that reaches 0 disappears; groups stay in the fixed order.
 */
export function applyLocal(summary: ReactionSummary | null, code: string, section: string | null, on: boolean, myName: string): ReactionSummary {
  const base = summary ?? emptySummary()
  // Null-prototype copy: a heading id such as `__proto__` stays an ordinary key.
  const next: ReactionSummary = { total: base.total, doc: base.doc, sections: Object.assign(Object.create(null), base.sections) }
  const groups = groupsOf(base, section).map((g) => ({ ...g, names: [...g.names] }))
  const i = groups.findIndex((g) => g.code === code)
  const g = i >= 0 ? groups[i] : null
  const name = myName.trim()
  if (on && !g?.mine) {
    const target = g ?? { code, emoji: EMOJI.get(code) ?? code, count: 0, names: [], anonymous: 0, mine: false }
    target.count++
    target.mine = true
    if (name) target.names = [name, ...target.names.filter((n) => n !== name)].slice(0, 20)
    else target.anonymous++
    if (!g) groups.push(target)
    next.total++
  } else if (!on && g?.mine) {
    g.count = Math.max(0, g.count - 1)
    g.mine = false
    if (name) g.names = g.names.filter((n) => n !== name)
    else g.anonymous = Math.max(0, g.anonymous - 1)
    if (g.count === 0) groups.splice(i, 1)
    next.total = Math.max(0, next.total - 1)
  } else {
    return base
  }
  groups.sort((a, b) => (ORDER.get(a.code) ?? 99) - (ORDER.get(b.code) ?? 99))
  if (section) {
    if (groups.length) next.sections[section] = groups
    else delete next.sections[section]
  } else {
    next.doc = groups
  }
  return next
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Join ["A", "B", "C"] → "A, B and C". */
function listJoin(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * Pure: who reacted (#24 rule 8) — names, the reader's own entry as "You"
 * (first), then "and N others" for the rest (anonymous readers and names past
 * the 20 listed). "Ana and 2 others", "You, Ana and 1 other", "3 people".
 */
export function formatWho(group: ReactionGroup, myName: string): string {
  const name = myName.trim()
  const people: string[] = group.mine ? ['You'] : []
  for (const n of group.names) {
    if (group.mine && name && n === name) continue // that is "You"
    people.push(n)
  }
  // Every listed person stands for one reaction; "You" is this browser's, whether it is counted
  // among the names (a named reader) or the anonymous ones.
  const others = Math.max(0, group.count - people.length)
  if (people.length === 0) return plural(others, 'person', 'people')
  if (others === 0) return listJoin(people)
  return `${people.join(', ')} and ${plural(others, 'other', 'others')}`
}

export interface PickerState {
  section: string
  label: string
  /** The trigger that opened it (focus returns there; re-found by section if re-rendered). */
  trigger: HTMLElement
}

export interface WhoState {
  text: string
  rect: { top: number; left: number; bottom: number; right: number }
}

export type Reactions = ReturnType<typeof createReactions>

/** The store of the doc state on screen — read by the section enhancer (src/preview/sectionReactions.ts). */
export const currentReactions = shallowRef<Reactions | null>(null)

export function createReactions(opts: { docId: Ref<string | null>; active: Ref<boolean> }) {
  const { reviewerName } = useReviewer()
  const readerId = getReaderId()
  /** What the UI shows: the server summary with pending clicks applied. */
  const summary = ref<ReactionSummary | null>(null)
  /** The latest summary the server sent for this doc. */
  let server: ReactionSummary | null = null
  /** Pending wanted states, key = `${section}\u0000${code}`. */
  const wanted = new Map<string, boolean>()
  const inFlight = new Set<string>()
  let generation = 0
  /** Bumped by every click and every settled POST: a GET that started before either is stale. */
  let writeSeq = 0
  const picker = shallowRef<PickerState | null>(null)
  const who = shallowRef<WhoState | null>(null)

  const keyOf = (code: string, section: string | null) => `${section ?? ''}\u0000${code}`
  const parseKey = (k: string) => { const [s, code] = k.split('\u0000'); return { section: s || null, code } }

  function reapply(base: ReactionSummary | null): ReactionSummary {
    let s = base ?? emptySummary()
    for (const [k, on] of wanted) { const { section, code } = parseKey(k); s = applyLocal(s, code, section, on, reviewerName.value) }
    return s
  }

  function api(id: string) { return `${PASTE_API}/paste/${encodeURIComponent(id)}/reactions` }

  let refreshing = false
  async function refresh() {
    const id = opts.docId.value
    if (!id || !opts.active.value || refreshing) return
    refreshing = true
    const gen = generation
    const seq = writeSeq
    try {
      const res = await fetch(`${api(id)}?reader_id=${encodeURIComponent(readerId)}`)
      // Always read the body: an unread response keeps its request open (and the page never network-idle).
      const body = res.ok ? await res.json() as ReactionSummary : (await res.text(), null)
      if (!body || gen !== generation) return
      // Older than a click or a POST answer since it started: it would undo them (the next poll brings the truth).
      if (gen !== generation || seq !== writeSeq) return
      server = body
      summary.value = reapply(server)
    } catch { /* offline: keep what we show */ } finally {
      refreshing = false
    }
  }

  async function flush(k: string, id: string, gen: number) {
    if (inFlight.has(k)) return
    inFlight.add(k)
    const { section, code } = parseKey(k)
    try {
      while (wanted.has(k) && gen === generation) {
        const on = wanted.get(k)!
        let res: Response
        try {
          res = await fetch(api(id), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, section, reader_id: readerId, name: reviewerName.value.trim() || undefined, on }),
          })
        } catch { res = new Response(null, { status: 599 }) }
        const raw = await res.text().catch(() => '') // always read the body (see refresh)
        if (gen !== generation) return
        writeSeq++
        if (!res.ok) {
          wanted.delete(k)
          summary.value = server ? reapply(server) : applyLocal(summary.value, code, section, !on, reviewerName.value)
          toast.error("Couldn't save your reaction. Try again.", { key: 'reaction-failed' })
          return
        }
        let body: { summary?: ReactionSummary } | null = null
        try { body = JSON.parse(raw) } catch { /* keep the optimistic state until the next poll */ }
        if (body?.summary) server = body.summary
        if (wanted.get(k) === on) wanted.delete(k)
      }
      summary.value = reapply(server)
    } finally {
      inFlight.delete(k)
    }
  }

  /** Is this reader's `code` reaction on `section` (null = doc) active, as shown? */
  function isMine(code: string, section: string | null): boolean {
    return !!groupsOf(summary.value, section).find((g) => g.code === code)?.mine
  }

  /** Click: flip this reader's reaction, optimistically. */
  function toggle(code: string, section: string | null = null) {
    const id = opts.docId.value
    if (!id || !opts.active.value || !ORDER.has(code)) return
    const on = !isMine(code, section)
    const k = keyOf(code, section)
    writeSeq++
    wanted.set(k, on)
    summary.value = applyLocal(summary.value, code, section, on, reviewerName.value)
    void flush(k, id, generation)
  }

  function openPicker(state: PickerState) { who.value = null; picker.value = state }
  function closePicker({ restoreFocus = true } = {}) {
    const p = picker.value
    picker.value = null
    if (!restoreFocus || !p) return
    const trigger = p.trigger.isConnected ? p.trigger
      : document.querySelector<HTMLElement>(`.section-reaction-trigger[data-section="${CSS.escape(p.section)}"]`)
    trigger?.focus()
  }

  function showWho(group: ReactionGroup | undefined, el: HTMLElement) {
    if (!group || group.count === 0) { who.value = null; return }
    const r = el.getBoundingClientRect()
    who.value = { text: formatWho(group, reviewerName.value), rect: { top: r.top, left: r.left, bottom: r.bottom, right: r.right } }
  }
  function hideWho() { who.value = null }

  // Another doc (or none): start over.
  watch([opts.docId, opts.active], ([id, active]) => {
    generation++
    wanted.clear()
    server = null
    summary.value = null
    picker.value = null
    who.value = null
    if (id && active) void refresh()
  }, { immediate: true })

  const store = { summary, picker, who, readerId, active: opts.active, refresh, toggle, isMine, openPicker, closePicker, showWho, hideWho }
  currentReactions.value = store
  return store
}

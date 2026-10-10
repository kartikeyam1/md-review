import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { ChangeSet, EditorSelection, StateEffect, StateField, Transaction, type ChangeSpec, type Extension, type Text } from '@codemirror/state'
import type { ContentType } from '@/types'
import {
  MAX_IMAGE_BYTES, MAX_IMAGES, STALE_PLACEHOLDER_RE, altFromName, assetName, attachmentHost, imageExtension,
  imageMarkup, isImageFile, placeholderText, registerPendingPaste, unregisterPendingPaste, uploadImage,
} from '@/composables/attachments'
import { toast } from '@/composables/useToast'

/**
 * Paste / drop images → upload as doc attachments (spec #10, 00 §3.6).
 *
 * A paste inserts one `![Uploading <alt>…]()` placeholder per image (one undo
 * step). Placeholder ranges are tracked through later edits (a state field,
 * mapped through every change — never found by text search). A failed upload's
 * placeholder is removed at once, outside the history.
 *
 * When every upload of the paste has settled, the placeholders are swapped for
 * the images as one history step whose undo is the exact pre-paste text: the
 * placeholders are swapped back to what the paste replaced (outside the
 * history) and that is swapped for the images (one isolated history step). So
 * one undo never reveals a placeholder (rule 10). A multi-image paste therefore
 * shows its images together, once the last upload has settled.
 *
 * Undo while uploads run takes the placeholders out (the paste step itself):
 * the paste is suspended — the selected text it replaced comes back and results
 * wait. Redo puts the placeholders back (found in the redo's own inserted text)
 * and resumes it; results that arrived meanwhile land then (rule 12).
 *
 * Pending placeholders never persist: each paste is registered with
 * `attachments.ts`, whose `stripPendingPlaceholders` autosave, keepalive and
 * the local draft apply. An editor that opens on a doc holding placeholders no
 * upload is running for (an older build, another tab) removes them (rule 13).
 */

interface Tracked {
  id: number
  group: number
  from: number
  to: number
  /** The placeholder text the range must still hold for its image to land there. */
  text: string
}

interface Group {
  id: number
  /** Where the paste went (start of its first placeholder). */
  anchor: number
  /** The selected text the paste replaced (taken out outside the history; put back on undo/failure). */
  replaced: string
  status: 'active' | 'suspended'
  /** Where `replaced` was put back while suspended (null when it is not in the doc). */
  restoredAt: number | null
  /** Item ids that were in the doc when an undo suspended the paste (what a redo brings back). */
  atSuspend: number[]
  /** The plugin still has to act on a status change (restore / remove `replaced`, finish). */
  dirty: boolean
}

interface Uploads { items: Tracked[]; groups: Group[] }

const addGroup = StateEffect.define<{ group: Group; items: Tracked[] }>()
const setGroup = StateEffect.define<Group>()
const dropItem = StateEffect.define<number>()
const dropGroup = StateEffect.define<number>()

const holds = (doc: Text, t: Tracked) => t.to > t.from && t.to <= doc.length && doc.sliceString(t.from, t.to) === t.text

/** Find `items`' texts (joined by blank lines) in a change's inserted text; returns their new ranges. */
function findInserted(tr: Transaction, items: Tracked[]): Map<number, { from: number; to: number }> | null {
  const expected = items.map((t) => t.text).join('\n\n')
  let found: Map<number, { from: number; to: number }> | null = null
  tr.changes.iterChanges((_fa, _ta, fromB, _tb, inserted) => {
    if (found) return
    const k = inserted.toString().indexOf(expected)
    if (k < 0) return
    found = new Map()
    let at = fromB + k
    for (const t of items) { found.set(t.id, { from: at, to: at + t.text.length }); at += t.text.length + 2 }
  })
  return found
}

/** Placeholders and their pastes, mapped through every change (rule 9). */
const uploadsField = StateField.define<Uploads>({
  create: () => ({ items: [], groups: [] }),
  update(value, tr) {
    let { items, groups } = value
    if (tr.docChanged) {
      const before = tr.startState.doc
      const prev = items
      // Text typed right at either edge stays outside the range.
      items = items.map((t) => ({ ...t, from: tr.changes.mapPos(t.from, 1), to: tr.changes.mapPos(t.to, -1) }))
      groups = groups.map((g) => ({
        ...g,
        anchor: tr.changes.mapPos(g.anchor, -1),
        restoredAt: g.restoredAt === null ? null : tr.changes.mapPos(g.restoredAt, -1),
      }))
      if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) {
        groups = groups.map((g) => {
          const mine = items.filter((t) => t.group === g.id)
          if (g.status === 'active') {
            // An undo/redo that takes out every placeholder still there undid the paste: suspend it.
            const present = prev.filter((t) => t.group === g.id && holds(before, t))
            if (present.length && present.every((p) => !holds(tr.newDoc, mine.find((t) => t.id === p.id)!))) {
              return { ...g, status: 'suspended', atSuspend: present.map((t) => t.id), dirty: true }
            }
            return g
          }
          // Suspended: a redo/undo that brings all its placeholders back resumes it.
          const back = findInserted(tr, mine.filter((t) => g.atSuspend.includes(t.id)))
          if (!back) return g
          items = items.map((t) => (back.has(t.id) ? { ...t, ...back.get(t.id)! } : t))
          return { ...g, status: 'active', atSuspend: [], dirty: true }
        })
      }
    }
    for (const e of tr.effects) {
      if (e.is(addGroup)) { items = [...items, ...e.value.items]; groups = [...groups, e.value.group] }
      else if (e.is(setGroup)) groups = groups.map((g) => (g.id === e.value.id ? e.value : g))
      else if (e.is(dropItem)) items = items.filter((t) => t.id !== e.value)
      else if (e.is(dropGroup)) { items = items.filter((t) => t.group !== e.value); groups = groups.filter((g) => g.id !== e.value) }
    }
    return items === value.items && groups === value.groups ? value : { items, groups }
  },
})

let nextId = 1

const uploads = (view: EditorView) => view.state.field(uploadsField, false) ?? { items: [], groups: [] }
const groupOf = (view: EditorView, id: number) => uploads(view).groups.find((g) => g.id === id) ?? null
const itemsOf = (view: EditorView, id: number) => uploads(view).items.filter((t) => t.group === id)
const intact = (view: EditorView, t: Tracked) => holds(view.state.doc, t)

interface Accepted { file: File; ext: string; alt: string }

/** Rules 3, 4: filter what can be uploaded; toast the rest. */
function accept(files: File[]): Accepted[] {
  const ok: Accepted[] = []
  for (const file of files) {
    const ext = imageExtension(file)
    if (!ext) { toast.error(`Unsupported image type: ${file.name}`); continue }
    if (file.size > MAX_IMAGE_BYTES) { toast.error(`${file.name} is larger than 10 MB`); continue }
    ok.push({ file, ext, alt: altFromName(file.name) })
  }
  if (ok.length > MAX_IMAGES) {
    toast.info(`Only the first ${MAX_IMAGES} images were added`)
    ok.length = MAX_IMAGES
  }
  return ok
}

// ── Per-editor plugin: upload results, suspend/resume, teardown ─────────────

/** What the uploads of one paste have produced so far (not document state). */
interface Results { pending: number; finals: Map<number, string>; failed: Set<number> }

const live: Array<{ view: EditorView; plugin: UploadPlugin }> = []

class UploadPlugin {
  readonly abort = new AbortController()
  readonly results = new Map<number, Results>()
  destroyed = false
  readonly groups = new Set<number>()
  constructor(readonly view: EditorView) {
    live.push({ view, plugin: this })
    setTimeout(() => this.removeStale())
  }

  /** Placeholders in the doc that no running upload owns: leftovers, removed outside the history. */
  removeStale() {
    if (this.destroyed || uploads(this.view).items.length) return
    const doc = this.view.state.doc.toString()
    const changes: ChangeSpec[] = []
    for (const m of doc.matchAll(STALE_PLACEHOLDER_RE)) changes.push({ from: m.index!, to: m.index! + m[0].length })
    if (changes.length) this.view.dispatch({ changes, annotations: Transaction.addToHistory.of(false) })
  }

  /** Keep the persistence registry in step with what the paste still has in the doc. */
  register(group: number) {
    const g = groupOf(this.view, group)
    const mine = itemsOf(this.view, group).sort((a, b) => a.from - b.from)
    if (!g || !mine.length) { this.unregister(group); return }
    this.groups.add(group)
    registerPendingPaste(group, { text: mine.map((t) => t.text).join('\n\n'), placeholders: mine.map((t) => t.text), replaced: g.replaced })
  }

  unregister(group: number) {
    this.groups.delete(group)
    unregisterPendingPaste(group)
  }

  update(u: ViewUpdate) {
    if (u.state.field(uploadsField).groups.some((g) => g.dirty)) setTimeout(() => this.reconcile())
  }

  /** Act on suspend/resume, after the undo/redo transaction (never inside it). */
  reconcile() {
    if (this.destroyed) return
    const view = this.view
    for (const g of uploads(view).groups) {
      if (!g.dirty) continue
      const doc = view.state.doc
      if (g.status === 'suspended') {
        // The selected text the paste replaced comes back while it is undone.
        const restore = g.replaced && g.restoredAt === null
        view.dispatch({
          changes: restore ? { from: g.anchor, insert: g.replaced } : [],
          effects: setGroup.of({ ...g, restoredAt: restore ? g.anchor : g.restoredAt, dirty: false }),
          annotations: Transaction.addToHistory.of(false),
        })
        continue
      }
      // Resumed: take the restored text out again, drop failed placeholders, finish if all settled.
      const changes: ChangeSpec[] = []
      if (g.replaced && g.restoredAt !== null) {
        const mine = itemsOf(view, g.id)
        const end = mine.length ? Math.max(...mine.map((t) => t.to)) : g.anchor
        const at = [g.restoredAt, end].find((p) => doc.sliceString(p, p + g.replaced.length) === g.replaced)
        if (at !== undefined) changes.push({ from: at, to: at + g.replaced.length })
      }
      view.dispatch({
        changes,
        effects: setGroup.of({ ...g, restoredAt: null, dirty: false }),
        annotations: Transaction.addToHistory.of(false),
      })
      const r = this.results.get(g.id)
      if (r) for (const id of r.failed) this.removePlaceholder(g.id, id)
      this.maybeFinish(g.id)
    }
  }

  removePlaceholder(group: number, id: number) {
    const view = this.view
    const t = itemsOf(view, group).find((x) => x.id === id)
    if (!t) return
    if (!intact(view, t)) { view.dispatch({ effects: dropItem.of(id) }); return }
    // Rule 11: the placeholder and the blank line joining it to a neighbour go, outside the history.
    const d = view.state.doc
    const others = itemsOf(view, group).filter((x) => x.id !== id)
    let a = t.from
    let b = t.to
    if (d.sliceString(b, b + 2) === '\n\n' && others.some((x) => x.from === b + 2)) b += 2
    else if (d.sliceString(a - 2, a) === '\n\n' && others.some((x) => x.to === a - 2)) a -= 2
    view.dispatch({ changes: { from: a, to: b }, effects: dropItem.of(id), annotations: Transaction.addToHistory.of(false) })
    this.register(group)
  }

  settle(group: number, id: number, outcome: { final: string } | { error: string }) {
    if (this.destroyed) return
    const r = this.results.get(group)
    if (!r) return
    r.pending--
    if ('final' in outcome) r.finals.set(id, outcome.final)
    else {
      r.failed.add(id)
      if (groupOf(this.view, group)?.status === 'active') this.removePlaceholder(group, id)
    }
    this.maybeFinish(group)
  }

  maybeFinish(group: number) {
    const r = this.results.get(group)
    const g = groupOf(this.view, group)
    if (!r || r.pending > 0 || !g || g.status !== 'active' || g.dirty) return
    this.results.delete(group)
    this.unregister(group)
    consolidate(this.view, g, r)
  }

  destroy() {
    // Rule 13: another doc (or a detach) — results are discarded.
    this.destroyed = true
    this.abort.abort()
    for (const g of [...this.groups]) this.unregister(g)
    const i = live.findIndex((x) => x.plugin === this)
    if (i >= 0) live.splice(i, 1)
  }
}

const uploadPlugin = ViewPlugin.fromClass(UploadPlugin)

/** The editor on screen once sharing remounted it (the doc key changed). */
async function waitForLiveEditor(timeoutMs = 3000): Promise<EditorView | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = [...live].reverse().find((x) => !x.plugin.destroyed && x.view.dom.isConnected)
    if (v) return v.view
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, 50))
  }
}

// ── Insert + upload ─────────────────────────────────────────────────────────

function start(view: EditorView, items: Accepted[], range: { from: number; to: number }, doc: { key: string; id: string }, contentType: ContentType | undefined) {
  const plugin = view.plugin(uploadPlugin)
  if (!plugin) return
  const from = Math.min(range.from, view.state.doc.length)
  const to = Math.max(from, Math.min(range.to, view.state.doc.length))
  const replaced = view.state.sliceDoc(from, to)
  // A replaced selection leaves outside the history; it comes back on undo/failure.
  if (replaced) view.dispatch({ changes: { from, to }, annotations: Transaction.addToHistory.of(false) })

  // Rule 8: placeholders joined by a blank line, cursor after the last one; one undo step.
  const group: Group = { id: nextId++, anchor: from, replaced, status: 'active', restoredAt: null, atSuspend: [], dirty: false }
  const placeholders = items.map((it) => placeholderText(it.alt))
  const insert = placeholders.join('\n\n')
  const tracked: Tracked[] = []
  let at = from
  for (const p of placeholders) {
    tracked.push({ id: nextId++, group: group.id, from: at, to: at + p.length, text: p })
    at += p.length + 2
  }
  plugin.results.set(group.id, { pending: items.length, finals: new Map(), failed: new Set() })
  view.dispatch({
    changes: { from, insert },
    selection: EditorSelection.cursor(from + insert.length),
    effects: [addGroup.of({ group, items: tracked }), EditorView.scrollIntoView(from + insert.length)],
    annotations: Transaction.userEvent.of('input.paste'),
  })
  plugin.register(group.id)

  items.forEach((it, i) => {
    const t = tracked[i]!
    uploadImage(it.file, { docId: doc.id, key: doc.key, name: assetName(it.ext), signal: plugin.abort.signal })
      .then((url) => plugin.settle(group.id, t.id, { final: imageMarkup(it.alt, url, contentType) }))
      .catch((err: unknown) => {
        if (plugin.destroyed) return
        const msg = err instanceof Error ? err.message : String(err)
        toast.error(`Couldn't upload ${it.alt}: ${msg}`)
        plugin.settle(group.id, t.id, { error: msg })
      })
  })
}

/**
 * Every upload of one paste has settled: swap its placeholders for the images
 * as one undo step whose undo is the pre-paste text (rules 10, 12; AC-10.6).
 * Placeholders that were deleted or edited meanwhile get nothing.
 */
function consolidate(view: EditorView, g: Group, r: Results) {
  const doc = view.state.doc
  const ok = itemsOf(view, g.id).filter((t) => r.finals.has(t.id) && intact(view, t)).sort((a, b) => a.from - b.from)
  if (!ok.length) {
    // Nothing landed: put the replaced selection back; the doc is its pre-paste self.
    view.dispatch({
      changes: g.replaced ? { from: g.anchor, insert: g.replaced } : [],
      effects: dropGroup.of(g.id),
      annotations: Transaction.addToHistory.of(false),
    })
    return
  }
  const first = ok[0]!
  const last = ok[ok.length - 1]!
  // One contiguous block (the usual case) also takes the blank lines between placeholders.
  const contiguous = doc.sliceString(first.from, last.to) === ok.map((t) => t.text).join('\n\n')
  const spans = contiguous
    ? [{ from: first.from, to: last.to, final: ok.map((t) => r.finals.get(t.id)!).join('\n\n') }]
    : ok.map((t) => ({ from: t.from, to: t.to, final: r.finals.get(t.id)! }))

  // Out of history: placeholders → what the paste replaced (the doc is its pre-paste self).
  const back = ChangeSet.of(spans.map((s, i) => ({ from: s.from, to: s.to, insert: i === 0 ? g.replaced : '' })), doc.length)
  // History: that → the images.
  const afterBack = back.apply(doc)
  const images = ChangeSet.of(spans.map((s, i) => {
    const from = back.mapPos(s.from, -1)
    return { from, to: from + (i === 0 ? g.replaced.length : 0), insert: s.final }
  }), afterBack.length)
  // Where the selection ends up: as if each placeholder had been replaced in place.
  const direct = ChangeSet.of(spans.map((s) => ({ from: s.from, to: s.to, insert: s.final })), doc.length)
  const selection = view.state.selection.map(direct)
  view.dispatch({ changes: back, effects: dropGroup.of(g.id), annotations: Transaction.addToHistory.of(false) })
  view.dispatch({ changes: images, selection, annotations: Transaction.userEvent.of('input.paste') })
}

/** Rules 1, 2, 14: route accepted images to the doc, or ask to share it first. */
function handleFiles(view: EditorView, files: File[], range: { from: number; to: number }) {
  const items = accept(files)
  if (!items.length) return
  const host = attachmentHost()
  if (!host) return
  const doc = host.doc()
  if (doc) { start(view, items, range, doc, host.contentType()); return }
  // Rule 14: nothing is inserted until the doc is shared; the position is kept.
  host.requestShare().then(async (shared) => {
    if (!shared) return
    const target = await waitForLiveEditor()
    if (!target) { toast.error("Couldn't add the images: the editor is not open"); return }
    start(target, items, range, shared, host.contentType())
  }).catch(() => { /* share failed: the host showed the toast */ })
}

const imageFilesIn = (list: FileList | null | undefined) => [...(list ?? [])].filter((f) => isImageFile(f))

export const imagePaste: Extension = [
  uploadsField,
  uploadPlugin,
  EditorView.domEventHandlers({
    paste(event, view) {
      const data = event.clipboardData
      if (!data) return false
      // Rule 1: text wins over an image (a spreadsheet copy carries both).
      if ((data.getData('text/plain') ?? '').trim()) return false
      const images = imageFilesIn(data.files)
      if (!images.length) return false
      event.preventDefault()
      const sel = view.state.selection.main
      handleFiles(view, images, { from: sel.from, to: sel.to })
      return true
    },
    drop(event, view) {
      const files = [...(event.dataTransfer?.files ?? [])]
      const images = files.filter((f) => isImageFile(f))
      if (!images.length) return false // rule 2: no image → default behaviour (text drags too)
      event.preventDefault()
      const skipped = files.length - images.length
      if (skipped) toast.info(`Skipped ${skipped} non-image file(s)`)
      // Imprecise: a drop in a line's padding or past its end lands at the nearest position.
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
      view.dispatch({ selection: EditorSelection.cursor(pos) })
      view.focus()
      handleFiles(view, images, { from: pos, to: pos })
      return true
    },
  }),
]

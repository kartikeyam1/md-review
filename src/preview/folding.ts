import { watch } from 'vue'
import type { Enhancer } from './enhancers'
import { findAnchorIn, decodeFragment, scrollToAnchorElement } from '@/composables/useRouter'
import { docIdOf } from '@/composables/useEditToken'
import { foldSections, collapseAllLevel, foldDocKey, readFolds, writeFolds, foldUi, type FoldSection } from '@/composables/useFolding'

// Spec #17 rules 3–14: fold toggles on top-level H1–H4, folded blocks get
// hidden="until-found" (find-in-page reveals them via `beforematch`), state
// per doc in localStorage, re-applied after every render; navigating to a
// heading (load, Back/Forward, TOC or in-doc link, copy-link URL) or scrolling
// to a comment unfolds what hides the target. Collapse/Expand all are driven
// from the TOC through `foldUi`.

const CHEVRON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="6 9 12 15 18 9"/></svg>'
const CONTROL = '[data-testid="heading-fold-toggle"], [data-testid="heading-fold-ellipsis"]'

/**
 * The load-time fragment reveal (rule 13) runs once per doc visit: a re-render,
 * a re-mounted pane (Edit → Read) or a live update with the same URL fragment
 * must not undo a fold the reader made since. Cleared when the route changes
 * (another doc, the library…), so coming back to `#id` reveals again. Fragment
 * changes while on the doc are handled by the route watcher below.
 */
let initialReveal: { key: string; fragment: string } | null = null
let routeWatchArmed = false

export const folding: Enhancer = (container, ctx) => {
  const textById = new Map(ctx.headings.map((h) => [h.id, h.text]))
  const ds = ctx.docState
  const keyNow = () => foldDocKey({
    pasteId: ds?.pasteId.value ? docIdOf(ds.pasteId.value) : null,
    route: ds?.route.value ?? { kind: 'landing' },
    filename: ds?.filename.value ?? '',
  })
  // The key can settle after the render (a restored local draft shows before the
  // doc's GET names its id; identical text does not re-render): re-keyed below.
  let docKey = keyNow()

  // Top-level blocks (the pane's own live regions are not content).
  const blocks = [...container.children].filter((el): el is HTMLElement => el instanceof HTMLElement && !el.matches('.sr-only'))
  const levels = blocks.map((el) => (/^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : null))
  const sections = foldSections(levels).filter((s) => {
    const h = blocks[s.index]!
    return !!h.id && textById.has(h.id)
  })
  const byId = new Map<string, FoldSection>(sections.map((s) => [blocks[s.index]!.id, s]))

  const stored = (key: string) => readFolds(key).filter((id) => byId.has(id))
  const folded = new Set(stored(docKey))
  const persist = () => writeFolds(docKey, [...folded])

  // ── DOM ──
  for (const s of sections) {
    const h = blocks[s.index]!
    if (h.querySelector(':scope > [data-testid="heading-fold-toggle"]')) continue
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'heading-fold-toggle'
    btn.dataset.testid = 'heading-fold-toggle'
    btn.innerHTML = CHEVRON
    btn.dataset.previewControl = ''
    h.insertBefore(btn, h.firstChild)
    h.classList.add('foldable-heading')
  }

  function apply() {
    const hidden = new Set<number>()
    for (const id of folded) {
      const s = byId.get(id)!
      for (let i = s.index + 1; i < s.end; i++) hidden.add(i)
    }
    blocks.forEach((el, i) => {
      if (hidden.has(i)) {
        if (el.getAttribute('hidden') !== 'until-found') el.setAttribute('hidden', 'until-found')
        el.dataset.foldHidden = ''
      } else if ('foldHidden' in el.dataset) {
        el.removeAttribute('hidden')
        delete el.dataset.foldHidden
      }
    })
    for (const s of sections) {
      const h = blocks[s.index]!
      const isFolded = folded.has(h.id)
      const text = textById.get(h.id) ?? ''
      const btn = h.querySelector<HTMLElement>(':scope > [data-testid="heading-fold-toggle"]')!
      btn.setAttribute('aria-expanded', String(!isFolded))
      btn.setAttribute('aria-label', `${isFolded ? 'Unfold' : 'Fold'} section ${text}`)
      btn.title = isFolded ? 'Unfold section' : 'Fold section'
      let ell = h.querySelector<HTMLElement>(':scope > [data-testid="heading-fold-ellipsis"]')
      if (isFolded) {
        h.dataset.folded = 'true'
        if (!ell) {
          ell = document.createElement('button')
          ell.setAttribute('type', 'button')
          ell.className = 'heading-fold-ellipsis'
          ell.dataset.testid = 'heading-fold-ellipsis'
          ell.tabIndex = -1
          // The glyph is CSS (::before): controls add no text to the heading (00 §2.5).
          ell.dataset.previewControl = ''
          // After the heading text, before the section controls (00 §2.5).
          const after = h.querySelector(':scope > .section-reactions, :scope > [data-testid="section-reaction-chip"], :scope > [data-testid="section-reaction-trigger"], :scope > [data-testid="heading-anchor"]')
          h.insertBefore(ell, after)
        }
        ell.setAttribute('aria-label', `Unfold section ${text}`)
        ell.title = 'Unfold section'
      } else {
        delete h.dataset.folded
        ell?.remove()
      }
    }
  }

  function setFolded(id: string, on: boolean) {
    if (on === folded.has(id)) return
    if (on) folded.add(id)
    else folded.delete(id)
    apply()
    persist()
  }

  /** Unfold every section hiding `el` and open closed <details> around it (rules 13–14). */
  function reveal(el: Element | null) {
    if (!el || !container.contains(el)) return
    for (let d = el.parentElement?.closest('details'); d && container.contains(d); d = d.parentElement?.closest('details')) d.open = true
    let top: Element | null = el
    while (top && top.parentElement !== container) top = top.parentElement
    const i = top ? blocks.indexOf(top as HTMLElement) : -1
    if (i === -1) return
    let changed = false
    for (const id of [...folded]) {
      const s = byId.get(id)!
      if (i > s.index && i < s.end) { folded.delete(id); changed = true }
    }
    if (changed) { apply(); persist() }
  }
  const revealId = (id: string) => { if (id) reveal(findAnchorIn(container, id)) }

  apply()
  foldUi.foldable.value = sections.length > 0
  const controller = {
    collapseAll() {
      const level = collapseAllLevel(sections.map((s) => s.level))
      if (level === null) return
      for (const s of sections) if (s.level >= level) folded.add(blocks[s.index]!.id)
      apply()
      persist()
    },
    expandAll() {
      folded.clear()
      apply()
      persist()
    },
  }
  foldUi.controller.value = controller

  // First render of this doc in this pane: a deep link wins over stored folds.
  if (!routeWatchArmed) {
    routeWatchArmed = true
    watch(() => ctx.router.current.value.key, () => { initialReveal = null })
  }
  const revealInitial = () => {
    const fragment = ctx.router.current.value.fragment
    if (initialReveal && initialReveal.key === docKey && initialReveal.fragment === fragment) return
    // Not marked done until the target exists: an empty first render (still loading) retries on the next one.
    if (fragment && !findAnchorIn(container, fragment)) return
    initialReveal = { key: docKey, fragment }
    const hadFolds = folded.size > 0
    revealId(fragment)
    // Stored folds just changed the layout above the target (this enhancer loads in a lazy
    // chunk, possibly after PreviewPane aligned to the fragment): align again.
    const target = fragment ? findAnchorIn(container, fragment) : null
    if (target && hadFolds) scrollToAnchorElement(target, { smooth: false })
  }
  revealInitial()
  const stopKey = watch(keyNow, (key) => {
    if (key === docKey) return
    const fromLocal = docKey.startsWith('local:')
    docKey = key
    const next = stored(key)
    if (fromLocal && !next.length) {
      // Sharing a local doc: its folds move to the new backend key.
      persist()
    } else {
      folded.clear()
      for (const id of next) folded.add(id)
      apply()
    }
    revealInitial()
  })

  // ── Events (delegated) ──
  const onClick = (e: MouseEvent) => {
    const ctl = (e.target as Element | null)?.closest?.(CONTROL)
    if (!ctl || !container.contains(ctl)) return
    e.preventDefault()
    const id = ctl.parentElement?.id
    if (!id || !byId.has(id)) return
    setFolded(id, ctl.matches('[data-testid="heading-fold-ellipsis"]') ? false : !folded.has(id))
  }
  // Fold controls never start a selection (rule 7); PreviewPane's comment flow
  // ignores `[data-preview-control]` targets, and document-level outside-click
  // handlers (menus, popovers) still see the click.
  const noSelect = (e: MouseEvent) => {
    const ctl = (e.target as Element | null)?.closest?.(CONTROL)
    if (ctl && container.contains(ctl)) e.preventDefault()
  }
  const onBeforeMatch = (e: Event) => reveal(e.target as Element)
  const onReveal = (e: Event) => reveal(e.target as Element)
  // TOC / in-doc anchor clicks reveal before their own handlers scroll (a same-fragment click changes no route).
  const onDocClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = (e.target as Element | null)?.closest?.('a[href^="#"]')
    if (!a) return
    if (!container.contains(a) && !a.closest('[data-testid="toc-panel"], [data-testid="toc-drawer"]')) return
    revealId(decodeFragment(a.getAttribute('href') ?? ''))
  }
  // Fragment changes (Back/Forward, manual edits, pushes): synchronous, so the target is visible before anything scrolls.
  const stopRoute = watch(() => ctx.router.current.value, (loc, prev) => {
    if (prev && loc.fragment === prev.fragment && loc.source !== 'pop') return
    initialReveal = { key: docKey, fragment: loc.fragment }
    revealId(loc.fragment)
  }, { flush: 'sync' })

  container.addEventListener('click', onClick)
  container.addEventListener('mousedown', noSelect)
  container.addEventListener('beforematch', onBeforeMatch)
  container.addEventListener('preview-reveal', onReveal)
  document.addEventListener('click', onDocClick, true)
  return () => {
    stopRoute()
    stopKey()
    container.removeEventListener('click', onClick)
    container.removeEventListener('mousedown', noSelect)
    container.removeEventListener('beforematch', onBeforeMatch)
    container.removeEventListener('preview-reveal', onReveal)
    document.removeEventListener('click', onDocClick, true)
    if (foldUi.controller.value === controller) {
      foldUi.controller.value = null
      foldUi.foldable.value = false
    }
  }
}

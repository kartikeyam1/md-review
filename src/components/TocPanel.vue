<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import type { TocEntry } from '@/markdown/headingIds'
import type { TocState } from '@/composables/useToc'
import { useRouter, findAnchorIn, scrollToAnchorElement } from '@/composables/useRouter'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { foldUi } from '@/composables/foldUi'

// The table of contents (spec #3 rules 10–13): the sticky desktop rail
// (`toc-panel`) or, below 1100px, the drawer (`toc-drawer`) that `toc-toggle`
// in the header opens. Both list the same `toc-link`s; the active one carries
// aria-current="location" and is kept in view by scrolling the list only.
const props = defineProps<{
  toc: TocState
  variant: 'rail' | 'drawer'
}>()
/** `pin`: a link was clicked — that entry is active right away (useActiveHeading.pin). */
const emit = defineEmits<{ pin: [id: string] }>()

const router = useRouter()
const listRef = ref<HTMLElement | null>(null)
const drawerRef = ref<HTMLElement | null>(null)
const open = computed(() => props.variant === 'drawer' && props.toc.drawerOpen.value)

const href = (e: TocEntry) => `#${encodeURIComponent(e.id)}`

// #17 rule 8: Collapse all / Expand all, while the doc on screen has a foldable heading.
const foldable = foldUi.foldable
const foldButtons = [
  { testid: 'fold-collapse-all', label: 'Collapse all sections', icon: ['7 20 12 15 17 20', '7 4 12 9 17 4'], run: () => foldUi.controller.value?.collapseAll() },
  { testid: 'fold-expand-all', label: 'Expand all sections', icon: ['7 15 12 20 17 15', '7 9 12 4 17 9'], run: () => foldUi.controller.value?.expandAll() },
]

/** Rule 12: a plain click behaves like an in-doc anchor (pushState + scroll under the header). */
function onLinkClick(ev: MouseEvent, entry: TocEntry) {
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return
  ev.preventDefault()
  emit('pin', entry.id)
  const go = () => {
    const root = document.querySelector<HTMLElement>('.preview-pane')
    const el = root && findAnchorIn(root, entry.id)
    if (!el) return
    // A changed fragment is scrolled to by PreviewPane's route watcher; the same one again just re-scrolls.
    if (!router.setFragment(entry.id, 'push', 'push')) scrollToAnchorElement(el)
  }
  if (props.variant === 'drawer') {
    props.toc.closeDrawer() // the page scroll lock lifts first
    nextTick(go)
  } else go()
}

/** Keep the active link visible inside the list — scrolls the list, never the page. */
function revealActive() {
  const list = listRef.value
  const a = list?.querySelector<HTMLElement>('[aria-current="location"]')
  if (!list || !a) return
  const l = list.getBoundingClientRect()
  const r = a.getBoundingClientRect()
  if (r.top < l.top) list.scrollTop -= l.top - r.top + 8
  else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom + 8
}
watch(() => props.toc.activeId.value, () => nextTick(revealActive))

// ── Drawer: focus trap, Esc, page scroll lock (rule 11) ──────────────────────
useFocusTrap(drawerRef, open, {
  initialFocus: () => drawerRef.value?.querySelector<HTMLElement>('[data-testid="toc-link"][aria-current="location"]')
    ?? drawerRef.value?.querySelector<HTMLElement>('[data-testid="toc-link"]'),
  returnFocus: () => document.querySelector<HTMLElement>('[data-testid="doc-header"] [data-testid="toc-toggle"]'),
})

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  e.preventDefault()
  props.toc.closeDrawer()
}

let lockedOverflow: string | null = null
function lockPage(on: boolean) {
  const root = document.documentElement
  if (on && lockedOverflow === null) {
    lockedOverflow = root.style.overflow
    root.style.overflow = 'hidden'
  } else if (!on && lockedOverflow !== null) {
    root.style.overflow = lockedOverflow
    lockedOverflow = null
  }
}

watch(open, (on) => {
  lockPage(on)
  if (on) {
    document.addEventListener('keydown', onKeydown)
    nextTick(revealActive)
  } else document.removeEventListener('keydown', onKeydown)
}, { immediate: true })

onUnmounted(() => {
  lockPage(false)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <nav
    v-if="variant === 'rail'"
    class="toc toc-rail"
    aria-label="Table of contents"
    data-testid="toc-panel"
  >
    <div class="toc-head">
      <span class="toc-title">Contents</span>
      <span class="toc-head-actions">
        <template v-if="foldable">
          <button
            v-for="b in foldButtons"
            :key="b.testid"
            type="button"
            class="toc-icon-btn"
            :title="b.label"
            :aria-label="b.label"
            :data-testid="b.testid"
            @click="b.run"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline v-for="(pts, i) in b.icon" :key="i" :points="pts" /></svg>
          </button>
        </template>
        <button
          type="button"
          class="toc-icon-btn"
          title="Hide contents"
          aria-label="Hide table of contents"
          data-testid="toc-collapse-btn"
          @click="toc.setCollapsed(true)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="11 17 6 12 11 7" /><polyline points="18 17 13 12 18 7" /></svg>
        </button>
      </span>
    </div>
    <ol ref="listRef" class="toc-list">
      <li v-for="e in toc.entries.value" :key="e.id">
        <a
          class="toc-link"
          :class="{ active: toc.activeId.value === e.id }"
          :style="{ '--depth': e.depth }"
          :href="href(e)"
          :title="e.text"
          :aria-current="toc.activeId.value === e.id ? 'location' : undefined"
          data-testid="toc-link"
          @click="onLinkClick($event, e)"
        >{{ e.text }}</a>
      </li>
    </ol>
  </nav>

  <template v-else-if="open">
    <div class="toc-backdrop" data-testid="toc-backdrop" @click="toc.closeDrawer()"></div>
    <div
      id="md-review-toc-drawer"
      ref="drawerRef"
      class="toc toc-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="Contents"
      data-testid="toc-drawer"
    >
      <div class="toc-head">
        <span class="toc-title">Contents</span>
        <span class="toc-head-actions">
          <template v-if="foldable">
            <button
              v-for="b in foldButtons"
              :key="b.testid"
              type="button"
              class="toc-icon-btn"
              :title="b.label"
              :aria-label="b.label"
              :data-testid="b.testid"
              @click="b.run"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline v-for="(pts, i) in b.icon" :key="i" :points="pts" /></svg>
            </button>
          </template>
          <button
            type="button"
            class="toc-icon-btn"
            aria-label="Close table of contents"
            data-testid="toc-drawer-close"
            @click="toc.closeDrawer()"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </span>
      </div>
      <nav class="toc-nav" aria-label="Table of contents">
        <ol ref="listRef" class="toc-list">
          <li v-for="e in toc.entries.value" :key="e.id">
            <a
              class="toc-link"
              :class="{ active: toc.activeId.value === e.id }"
              :style="{ '--depth': e.depth }"
              :href="href(e)"
              :title="e.text"
              :aria-current="toc.activeId.value === e.id ? 'location' : undefined"
              data-testid="toc-link"
              @click="onLinkClick($event, e)"
            >{{ e.text }}</a>
          </li>
        </ol>
      </nav>
    </div>
  </template>
</template>

<style scoped>
.toc {
  display: flex;
  flex-direction: column;
  min-height: 0;
  font-size: 13px;
  background: var(--bg-surface);
}

/* Desktop rail (rule 10): a 240px column, sticky under the header, scrolling itself. */
.toc-rail {
  position: sticky;
  top: var(--header-h);
  z-index: 90;
  width: 240px;
  max-height: calc(100vh - var(--header-h));
  max-height: calc(100dvh - var(--header-h));
  border-right: 1px solid var(--border);
}

.toc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 8px 6px 16px;
  flex-shrink: 0;
}

.toc-head-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.toc-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.toc-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
}

.toc-icon-btn:hover {
  border-color: var(--border);
}

.toc-nav {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
}

.toc-list {
  list-style: none;
  margin: 0;
  padding: 0 8px 16px;
  overflow-y: auto;
  overscroll-behavior: contain;
  min-height: 0;
  flex: 1 1 auto;
}

.toc-link {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 5px 8px 5px calc(8px + var(--depth, 0) * 14px);
  border-left: 2px solid transparent;
  border-radius: 0 4px 4px 0;
  color: var(--text-secondary);
  text-decoration: none;
  line-height: 1.45;
}

.toc-link:hover {
  color: var(--text-primary);
  background: var(--bg-page);
}

.toc-link.active {
  color: var(--text-primary);
  font-weight: 600;
  border-left-color: var(--accent);
  background: var(--bg-page);
}

.toc-link:focus-visible,
.toc-icon-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

/* Drawer (rule 11): from the left, over a backdrop (00 §3.7: 300). */
.toc-backdrop {
  position: fixed;
  inset: 0;
  touch-action: none;
  z-index: 300;
  background: var(--overlay-bg);
}

.toc-drawer {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 300;
  width: min(85vw, 320px);
  border-right: 1px solid var(--border);
  box-shadow: 8px 0 24px var(--shadow-color);
  font-size: 15px;
}

.toc-drawer .toc-icon-btn {
  width: 40px;
  height: 40px;
}

.toc-drawer .toc-link {
  padding-top: 9px;
  padding-bottom: 9px;
}

@media (hover: none) {
  .toc-link {
    padding-top: 11px;
    padding-bottom: 11px;
  }
}
</style>

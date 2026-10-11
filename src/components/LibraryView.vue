<script setup lang="ts">
// The library page (#26 rules 1–18): search, filters, sort, pins, recently
// viewed, collections, tags, bulk actions, paging with a virtualised list, and
// a phone layout (cards + a filters sheet). The list state is the URL; data
// and mutations live in useLibrary.
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useLibrary, rowCanEdit, countLabel, virtualRange, cardHasTagsLine, libraryRowHeight, type LibraryItem, type LibraryCollection } from '@/composables/useLibrary'
import { sortOptions, sortParam, SORT_LABELS, searchTerm, type LibSort } from '@/composables/libraryQuery'
import { RECENT_SHOWN } from '@/composables/useRecent'
import { normalizeTag } from '@shared/tags.mjs'
import { useRouter } from '@/composables/useRouter'
import { useBreakpoint } from '@/composables/useBreakpoint'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { relativeTime } from '@/composables/docMeta'
import AppMenu, { type AppMenuEntry } from '@/components/AppMenu.vue'
import LibraryRow from '@/components/LibraryRow.vue'
import LibraryFilters from '@/components/LibraryFilters.vue'
import LibraryCollections from '@/components/LibraryCollections.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ReviewerName from '@/components/ReviewerName.vue'
import ThemeSwitcher from '@/components/ThemeSwitcher.vue'

const emit = defineEmits<{ 'new-doc': [] }>()

const lib = useLibrary()
const router = useRouter()
const bp = useBreakpoint()
const phone = computed(() => bp.value === 'phone')

/** Re-render relative times once a minute. */
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

const docKey = (x: { id: string; slug: string | null }) => x.slug || x.id
const docHref = (x: { id: string; slug: string | null }) => `${router.base}d/${docKey(x)}`
function openDoc(x: { id: string; slug: string | null }) { router.pushRoute({ kind: 'doc', id: docKey(x) }) }

// ── Search (rule 5): debounced 250 ms, replaceState while typing, Esc clears ──
const SEARCH_DEBOUNCE_MS = 250
const searchText = ref(lib.query.value.q)
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(() => lib.query.value.q, (q) => { if (!searchTimer && q !== searchText.value) searchText.value = q })
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { searchTimer = null; lib.setQuery({ q: searchText.value }, { replace: true }) }, SEARCH_DEBOUNCE_MS)
}
function onSearchKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !searchText.value) return
  e.preventDefault()
  e.stopPropagation()
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null }
  searchText.value = ''
  lib.setQuery({ q: '' }, { replace: true })
}

// ── Sort (rule 7) ──
const sortChoices = computed(() => sortOptions(lib.query.value, lib.viewsAvailable.value))
const sortModel = computed<LibSort>({
  get: () => lib.sort.value,
  set: (v) => lib.setQuery({ sort: sortParam(lib.query.value, v) }),
})

// ── Sections (rules 9/10) ──
const showSections = computed(() => !lib.filtersActive.value)
const pinnedShown = computed(() => (showSections.value ? lib.pinnedItems.value : []))
const pinnedIds = computed(() => new Set(pinnedShown.value.map((x) => x.id)))
const mainRows = computed(() => (pinnedIds.value.size ? lib.items.value.filter((x) => !pinnedIds.value.has(x.id)) : lib.items.value))
const recentShown = computed(() => (showSections.value ? lib.recent.value.slice(0, RECENT_SHOWN) : []))

// ── Virtual list (rule 15): known row heights, ≤ 120 library-row in the DOM ──
const MAX_DOM_ROWS = 120
const hasSnippets = computed(() => !!searchTerm(lib.query.value.q))
/** Desktop rows (and the loading skeleton): one fixed height. */
const rowHeight = computed(() => libraryRowHeight(phone.value, hasSnippets.value, true))
/** A row's own height: phone cards without a tags line are shorter (no empty band). */
const heightOf = (it: LibraryItem) => libraryRowHeight(phone.value, hasSnippets.value, cardHasTagsLine(it, rowCanEdit(it)))
/** Row tops of the main list (phone only — desktop rows are uniform), plus its total height. */
const offsets = computed(() => {
  if (!phone.value) return null
  const out = [0]
  for (const it of mainRows.value) out.push(out[out.length - 1] + heightOf(it))
  return out
})
const listHeight = computed(() => (offsets.value ? offsets.value[offsets.value.length - 1] : mainRows.value.length * rowHeight.value))
const windowTop = computed(() => (offsets.value ? offsets.value[range.value.start] ?? 0 : range.value.start * rowHeight.value))
const listEl = ref<HTMLElement | null>(null)
const range = ref({ start: 0, end: 0 })
const visibleRows = computed(() => mainRows.value.slice(range.value.start, range.value.end))
let rafId = 0

function updateRange() {
  rafId = 0
  const el = listEl.value
  const count = mainRows.value.length
  if (!el) { range.value = { start: 0, end: Math.min(count, 40) }; return }
  const rect = el.getBoundingClientRect()
  const cap = Math.max(30, MAX_DOM_ROWS - pinnedShown.value.length)
  range.value = virtualRange({ scrollTop: -rect.top, viewport: window.innerHeight, rowHeight: rowHeight.value, count, overscan: 12, cap, offsets: offsets.value ?? undefined })
  // The sentinel: near the end of what is loaded, fetch the next page.
  if (lib.nextCursor.value && range.value.end >= count - 8 && rect.bottom < window.innerHeight * 2.5) void lib.loadMore()
}
function scheduleRange() { if (!rafId) rafId = requestAnimationFrame(updateRange) }
watch([mainRows, offsets, rowHeight, pinnedShown], () => nextTick(updateRange))

// ── Selection + bulk (rules 13/14) ──
const selected = ref<Set<string>>(new Set())
const loadedRows = computed(() => [...pinnedShown.value, ...mainRows.value])
const allSelected = computed(() => loadedRows.value.length > 0 && loadedRows.value.every((x) => selected.value.has(x.id)))
const someSelected = computed(() => selected.value.size > 0 && !allSelected.value)
function setSelected(id: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(id); else next.delete(id)
  selected.value = next
}
function toggleAll(on: boolean) { selected.value = on ? new Set(loadedRows.value.map((x) => x.id)) : new Set() }
// A new result set (search/filter/sort change) clears the selection.
watch(() => [lib.query.value.q, lib.query.value.collection, lib.query.value.tag, lib.query.value.mode, lib.query.value.type, lib.query.value.updated, lib.query.value.sort], () => { selected.value = new Set() })

const bulkTagOpen = ref(false)
const bulkTag = ref('')
const bulkTagError = ref('')
const bulkTagInput = ref<HTMLInputElement | null>(null)
async function openBulkTag() {
  bulkTagOpen.value = true
  bulkTag.value = ''
  bulkTagError.value = ''
  await nextTick()
  bulkTagInput.value?.focus()
}
async function commitBulkTag() {
  const r = normalizeTag(bulkTag.value)
  if (r.error !== undefined) { bulkTagError.value = r.error; return }
  const ok = await lib.bulk('add-tag', [...selected.value], { tag: r.tag })
  if (ok) { bulkTagOpen.value = false; selected.value = new Set() }
}
function onBulkTagKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); void commitBulkTag() }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); bulkTagOpen.value = false }
}
async function bulkMove(collectionId: string | null) {
  if (await lib.bulk('move', [...selected.value], { collectionId })) selected.value = new Set()
}
const moveEntries = computed<AppMenuEntry[]>(() => [
  { type: 'item', id: 'none', label: 'Unfiled', onSelect: () => void bulkMove(null) },
  ...lib.collections.value.map((c): AppMenuEntry => ({ type: 'item', id: c.id, label: c.name, onSelect: () => void bulkMove(c.id) })),
])

// ── Confirm dialog (bulk delete, collection delete) ──
const confirm = ref<null | { title: string; text?: string; okLabel: string; run: () => Promise<void> | void }>(null)
function askBulkDelete() {
  const n = selected.value.size
  confirm.value = {
    title: `Delete ${countLabel(n)}? This cannot be undone.`,
    okLabel: 'Delete',
    run: async () => { if (await lib.bulk('delete', [...selected.value])) selected.value = new Set() },
  }
}
function askDeleteCollection(c: LibraryCollection) {
  confirm.value = {
    title: `Delete the collection “${c.name}”?`,
    text: 'Its documents stay in the library, unfiled.',
    okLabel: 'Delete collection',
    run: async () => { await lib.deleteCollection(c.id) },
  }
}
async function confirmOk() {
  const c = confirm.value
  confirm.value = null
  await c?.run()
}

// ── Phone filters sheet (rule 17) ──
const sheetOpen = ref(false)
const sheetEl = ref<HTMLElement | null>(null)
const toggleBtn = ref<HTMLButtonElement | null>(null)
useFocusTrap(sheetEl, computed(() => sheetOpen.value && phone.value), { returnFocus: () => toggleBtn.value })
watch(phone, (p) => { if (!p) sheetOpen.value = false })
const activeFilterCount = computed(() => {
  const q = lib.query.value
  return [q.collection, q.tag, q.mode, q.type, q.updated].filter(Boolean).length
})
function onSheetKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  sheetOpen.value = false
}
function selectCollection(v: string) {
  lib.setQuery({ collection: v })
  if (phone.value) sheetOpen.value = false
}

// ── Empty / error states (rule 16) ──
const emptyState = computed<null | 'no-docs' | 'no-results' | 'empty-collection'>(() => {
  if (lib.status.value !== 'ready' || lib.total.value > 0 || pinnedShown.value.length) return null
  if (!lib.filtersActive.value) return 'no-docs'
  const q = lib.query.value
  if (q.collection && q.collection !== 'none' && !searchTerm(q.q) && !q.tag && !q.mode && !q.type && !q.updated) return 'empty-collection'
  return 'no-results'
})
const firstLoad = computed(() => lib.status.value === 'loading' && !lib.items.value.length && !lib.pinnedItems.value.length)

onMounted(() => {
  lib.reload()
  window.addEventListener('scroll', scheduleRange, { passive: true })
  window.addEventListener('resize', scheduleRange)
  clock = setInterval(() => { now.value = Date.now() }, 60_000)
  nextTick(updateRange)
})
onUnmounted(() => {
  window.removeEventListener('scroll', scheduleRange)
  window.removeEventListener('resize', scheduleRange)
  if (rafId) cancelAnimationFrame(rafId)
  if (clock) clearInterval(clock)
  if (searchTimer) clearTimeout(searchTimer)
})

const rowProps = (item: LibraryItem) => ({
  item, href: docHref(item), canEdit: rowCanEdit(item), selected: selected.value.has(item.id), phone: phone.value, now: now.value, saveTags: lib.saveTags,
  style: phone.value ? { '--lib-row-h': `${heightOf(item)}px` } : undefined,
})
</script>

<template>
  <div class="library" :class="{ phone }" :style="{ '--lib-row-h': `${rowHeight}px` }" data-testid="library-page">
    <header class="lib-header">
      <div class="lib-title-block">
        <a class="lib-home" :href="router.base" title="Home" @click.prevent="router.push(router.base)">md<span class="lib-home-accent">review</span></a>
        <h1 class="lib-title">Library</h1>
        <span class="lib-count" data-testid="library-count" aria-live="polite">{{ countLabel(lib.total.value) }}</span>
      </div>
      <div class="lib-header-actions">
        <ReviewerName />
        <ThemeSwitcher />
        <button type="button" class="btn btn-primary lib-new" @click="emit('new-doc')">New<span v-if="!phone"> document</span></button>
      </div>
    </header>

    <div class="lib-toolbar">
      <div class="lib-search-wrap">
        <svg class="lib-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input
          v-model="searchText"
          type="search"
          class="lib-search"
          placeholder="Search titles, text and files…"
          aria-label="Search the library"
          data-testid="library-search"
          @input="onSearchInput"
          @keydown="onSearchKeydown"
        />
      </div>
      <label class="lib-sort">
        <span class="lib-sort-label">Sort</span>
        <select v-model="sortModel" data-testid="library-sort" aria-label="Sort">
          <option v-for="s in sortChoices" :key="s" :value="s">{{ SORT_LABELS[s] }}</option>
        </select>
      </label>
      <button
        v-if="phone"
        ref="toggleBtn"
        type="button"
        class="btn btn-ghost lib-filters-toggle"
        :aria-expanded="sheetOpen ? 'true' : 'false'"
        data-testid="library-filters-toggle"
        @click="sheetOpen = !sheetOpen"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="22 3 2 3 10 12.5 10 19 14 21 14 12.5 22 3"/></svg>
        Filters<span v-if="activeFilterCount" class="lib-filter-count">{{ activeFilterCount }}</span>
      </button>
      <LibraryFilters
        v-if="!phone"
        class="lib-toolbar-filters"
        :query="lib.query.value"
        :collections="lib.collections.value"
        :tags="lib.tags.value"
        :active="lib.filtersActive.value"
        @change="lib.setQuery($event)"
        @clear="lib.clearFilters()"
      />
    </div>

    <div class="lib-layout">
      <aside v-if="!phone" class="lib-side">
        <LibraryCollections
          :collections="lib.collections.value"
          :active="lib.query.value.collection"
          :create="lib.createCollection"
          :rename="lib.renameCollection"
          @select="selectCollection"
          @delete="askDeleteCollection"
        />
      </aside>

      <main class="lib-main">
        <div v-if="selected.size" class="lib-bulk-bar" data-testid="library-bulk-bar" role="region" aria-label="Bulk actions">
          <span class="lib-bulk-count">{{ selected.size }} selected</span>
          <template v-if="bulkTagOpen">
            <input ref="bulkTagInput" v-model="bulkTag" class="lib-bulk-tag-input" placeholder="tag to add" aria-label="Tag to add" @keydown="onBulkTagKeydown" />
            <button type="button" class="btn btn-ghost" @click="commitBulkTag">Add</button>
            <span v-if="bulkTagError" class="lib-bulk-error" role="alert">{{ bulkTagError }}</span>
          </template>
          <button v-else type="button" class="btn btn-ghost" data-testid="library-bulk-tag" @click="openBulkTag">Add tag</button>
          <AppMenu :entries="moveEntries" label="Move to collection" trigger-testid="library-bulk-move">
            <template #trigger>Move</template>
          </AppMenu>
          <button type="button" class="btn btn-ghost lib-danger" data-testid="library-bulk-delete" @click="askBulkDelete">Delete</button>
          <button type="button" class="lib-bulk-clear" aria-label="Clear selection" title="Clear selection" @click="toggleAll(false)">×</button>
        </div>

        <section v-if="recentShown.length" class="lib-section" data-testid="library-recent" aria-label="Recently viewed">
          <h2 class="lib-section-title">Recently viewed</h2>
          <div class="lib-recent-list">
            <a
              v-for="r in recentShown"
              :key="r.id"
              class="lib-recent-item"
              :href="docHref(r)"
              data-testid="library-recent-item"
              @click.prevent="openDoc(r)"
            >
              <span class="lib-recent-title">{{ r.title }}</span>
              <span class="lib-recent-time">{{ relativeTime(Date.parse(r.viewedAt), now) }}</span>
            </a>
          </div>
        </section>

        <section v-if="pinnedShown.length" class="lib-section" data-testid="library-pinned" aria-label="Pinned">
          <h2 class="lib-section-title">Pinned</h2>
          <div class="lib-rows" :class="{ cards: phone }">
            <LibraryRow
              v-for="it in pinnedShown"
              :key="it.id"
              v-bind="rowProps(it)"
              @open="openDoc(it)"
              @pin="lib.togglePin(it)"
              @select="setSelected(it.id, $event)"
              @tag="lib.setQuery({ tag: $event })"
            />
          </div>
        </section>

        <div v-if="loadedRows.length" class="lib-list-head">
          <label class="lib-select-all">
            <input
              type="checkbox"
              :checked="allSelected"
              :indeterminate.prop="someSelected"
              data-testid="library-select-all"
              aria-label="Select all loaded documents"
              @change="toggleAll(($event.target as HTMLInputElement).checked)"
            />
            <span>Select all</span>
          </label>
          <span v-if="pinnedShown.length" class="lib-list-label">All documents</span>
        </div>

        <div v-if="firstLoad" class="lib-loading" data-testid="library-loading" aria-busy="true" aria-label="Loading documents">
          <div v-for="i in 6" :key="i" class="lib-skel" :style="{ height: `${rowHeight - (phone ? 8 : 0)}px` }"><span /><span /></div>
        </div>

        <div v-else-if="lib.status.value === 'error'" class="lib-state" data-testid="library-error" role="alert">
          <p class="lib-state-title">Could not load the library</p>
          <p class="lib-state-text">The server is unreachable or returned an error.</p>
          <button type="button" class="btn btn-primary" data-testid="library-retry" @click="lib.reload()">Retry</button>
        </div>

        <div v-else-if="emptyState" class="lib-state" data-testid="library-empty" :data-state="emptyState">
          <template v-if="emptyState === 'no-docs'">
            <p class="lib-state-title">No documents yet</p>
            <p class="lib-state-text">Shared documents show up here.</p>
            <button type="button" class="btn btn-primary" data-testid="library-new-doc" @click="emit('new-doc')">New document</button>
          </template>
          <template v-else-if="emptyState === 'empty-collection'">
            <p class="lib-state-title">This collection is empty</p>
            <p class="lib-state-text">Select documents and use Move to add them.</p>
            <button type="button" class="btn btn-ghost" data-testid="library-clear-filters" @click="lib.clearFilters()">Show all documents</button>
          </template>
          <template v-else>
            <p class="lib-state-title">No documents match</p>
            <p class="lib-state-text">Try other words or fewer filters.</p>
            <button type="button" class="btn btn-ghost" data-testid="library-clear-filters" @click="lib.clearFilters()">Clear filters</button>
          </template>
        </div>

        <div
          v-if="mainRows.length && lib.status.value !== 'error'"
          ref="listEl"
          class="library-list lib-rows"
          :class="{ cards: phone }"
          :style="{ height: `${listHeight}px` }"
        >
          <div class="lib-window" :style="{ transform: `translateY(${windowTop}px)` }">
            <LibraryRow
              v-for="it in visibleRows"
              :key="it.id"
              v-bind="rowProps(it)"
              @open="openDoc(it)"
              @pin="lib.togglePin(it)"
              @select="setSelected(it.id, $event)"
              @tag="lib.setQuery({ tag: $event })"
            />
          </div>
        </div>

        <div v-if="lib.nextCursor.value && lib.status.value === 'ready'" class="lib-more">
          <button type="button" class="btn btn-ghost" data-testid="library-load-more" :disabled="lib.loadingMore.value" @click="lib.loadMore()">
            {{ lib.loadingMore.value ? 'Loading…' : 'Load more' }}
          </button>
        </div>
      </main>
    </div>

    <div v-if="phone && sheetOpen" class="lib-sheet-backdrop" @click.self="sheetOpen = false">
      <div ref="sheetEl" class="lib-sheet" role="dialog" aria-modal="true" aria-label="Filters and collections" @keydown="onSheetKeydown">
        <div class="lib-sheet-head">
          <span class="lib-sheet-title">Filters</span>
          <button type="button" class="btn btn-primary" @click="sheetOpen = false">Done</button>
        </div>
        <LibraryFilters
          stacked
          :query="lib.query.value"
          :collections="lib.collections.value"
          :tags="lib.tags.value"
          :active="lib.filtersActive.value"
          @change="lib.setQuery($event)"
          @clear="lib.clearFilters()"
        />
        <LibraryCollections
          :collections="lib.collections.value"
          :active="lib.query.value.collection"
          :create="lib.createCollection"
          :rename="lib.renameCollection"
          @select="selectCollection"
          @delete="askDeleteCollection"
        />
      </div>
    </div>

    <ConfirmDialog
      v-if="confirm"
      :title="confirm.title"
      :text="confirm.text"
      :ok-label="confirm.okLabel"
      @ok="confirmOk"
      @cancel="confirm = null"
    />
  </div>
</template>

<style scoped>
.library {
  box-sizing: border-box;
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  padding: 16px 24px 48px;
  font-family: var(--font-body);
  color: var(--text-primary);
  min-width: 0;
}
.library.phone { padding: 12px 16px 40px; }
.lib-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.lib-title-block { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.lib-home { font-family: var(--font-heading); font-weight: 600; font-size: 15px; color: var(--text-meta); text-decoration: none; }
.lib-home:hover { color: var(--text-primary); }
.lib-home-accent { color: var(--accent-text); }
.lib-title { margin: 0; font-family: var(--font-heading); font-size: 28px; font-weight: 600; line-height: 1.1; }
.lib-count { font-size: 13px; color: var(--text-meta); font-variant-numeric: tabular-nums; white-space: nowrap; }
.lib-header-actions { display: flex; align-items: center; gap: 8px; min-width: 0; }
.phone .lib-title { font-size: 22px; }
/* Phone: the actions get their own full-width line, so "Set your name" (or a name) is clipped only when it truly cannot fit. */
.phone .lib-header-actions { flex: 1 1 100%; }
.phone .lib-header-actions :deep(.reviewer) { flex: 0 1 auto; min-width: 0; margin-right: auto; overflow: hidden; }

.lib-toolbar {
  display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 14px;
  padding: 12px 0 14px; border-bottom: 1px solid var(--border); margin-bottom: 16px;
}
.lib-search-wrap { position: relative; flex: 1 1 260px; min-width: 0; max-width: 420px; }
.phone .lib-search-wrap { flex: 1 1 100%; max-width: none; }
.lib-search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-meta); pointer-events: none; }
.lib-search {
  box-sizing: border-box; width: 100%; padding: 8px 10px 8px 32px; font-size: 14px; font-family: var(--font-body);
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg-surface); color: var(--text-primary);
}
.lib-search:focus { outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 0; border-color: var(--accent); }
.lib-sort { display: flex; flex-direction: column; gap: 2px; }
.phone .lib-sort { flex: 1 1 auto; }
.lib-sort-label { font-size: 11px; color: var(--text-meta); font-weight: 500; }
.lib-sort select {
  font-family: var(--font-body); font-size: 13px; padding: 5px 8px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg-surface); color: var(--text-primary);
}
.phone .lib-sort select { width: 100%; padding: 8px; font-size: 15px; }
.lib-filters-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; font-size: 14px; }
.lib-filter-count {
  min-width: 18px; height: 18px; border-radius: 9px; background: var(--accent); color: var(--bg-surface);
  font-size: 11px; line-height: 18px; text-align: center; font-weight: 600;
}
.lib-toolbar-filters { flex: 1 1 auto; }

.lib-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 28px; align-items: start; }
.phone .lib-layout { display: block; }
.lib-side { position: sticky; top: 16px; }
.lib-main { min-width: 0; }

.lib-section { margin-bottom: 20px; }
.lib-section-title { margin: 0 0 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-meta); }
.lib-recent-list { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: thin; }
.lib-recent-item {
  flex: none; display: flex; flex-direction: column; gap: 2px; width: 180px; box-sizing: border-box;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-surface);
  text-decoration: none; color: var(--text-primary);
}
.lib-recent-item:hover, .lib-recent-item:focus-visible { border-color: var(--text-meta); }
.lib-recent-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-recent-time { font-size: 11px; color: var(--text-meta); }
.phone .lib-recent-item { width: 150px; }

.lib-rows:not(.cards) { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--bg-surface); }
.lib-rows:not(.cards) :deep(.library-row:last-child) { border-bottom: none; }
.library-list.lib-rows { position: relative; overflow: hidden; }
.library-list:not(.cards) { overflow: hidden; }
.lib-window { will-change: transform; }

.lib-list-head { display: flex; align-items: center; gap: 12px; margin: 0 0 8px; padding: 0 12px; min-height: 24px; }
.lib-select-all { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-meta); cursor: pointer; }
.lib-select-all input { width: 16px; height: 16px; accent-color: var(--accent); margin: 0; }
.lib-list-label { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-meta); }

.lib-bulk-bar {
  position: sticky; top: 8px; z-index: 20;
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 8px 10px; margin-bottom: 14px;
  background: var(--bg-surface); border: 1px solid var(--text-meta); border-radius: 8px;
  box-shadow: 0 4px 14px var(--shadow-color);
}
.lib-bulk-count { font-size: 13px; font-weight: 600; margin-right: 4px; }
.lib-bulk-tag-input {
  width: 10em; padding: 5px 8px; font-size: 13px; font-family: var(--font-body);
  border: 1px solid var(--accent); border-radius: 6px; background: var(--bg-surface); color: var(--text-primary);
}
.lib-bulk-error { font-size: 12px; color: var(--cat-must-fix); }
.lib-danger { color: var(--cat-must-fix); border-color: color-mix(in srgb, var(--cat-must-fix) 40%, var(--border)); }
.lib-bulk-clear { margin-left: auto; border: none; background: transparent; color: var(--text-meta); font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 4px; }
.lib-bulk-clear:hover { color: var(--text-primary); background: var(--bg-code); }

.lib-loading { display: flex; flex-direction: column; gap: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.phone .lib-loading { border: none; gap: 8px; }
.lib-skel { box-sizing: border-box; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; background: var(--bg-surface); border-bottom: 1px solid var(--border); }
.phone .lib-skel { border: 1px solid var(--border); border-radius: 10px; }
.lib-skel span { display: block; height: 12px; border-radius: 6px; background: var(--bg-code); animation: lib-pulse 1.4s ease-in-out infinite; }
.lib-skel span:first-child { width: 45%; height: 14px; }
.lib-skel span:last-child { width: 70%; }
@keyframes lib-pulse { 50% { opacity: 0.5; } }
@media (prefers-reduced-motion: reduce) { .lib-skel span { animation: none; } }

.lib-state {
  text-align: center; padding: 48px 16px; border: 1px dashed var(--border); border-radius: 10px; background: var(--bg-surface);
}
.lib-state-title { margin: 0 0 6px; font-family: var(--font-heading); font-size: 20px; font-weight: 600; }
.lib-state-text { margin: 0 0 16px; font-size: 13px; color: var(--text-meta); }
.lib-more { display: flex; justify-content: center; padding: 16px 0; }

.lib-sheet-backdrop { position: fixed; inset: 0; z-index: 300; background: var(--overlay-bg); display: flex; align-items: flex-end; }
.lib-sheet {
  box-sizing: border-box; width: 100%; max-height: 85vh; overflow-y: auto;
  padding: 14px 16px 24px; background: var(--bg-surface); color: var(--text-primary);
  border-radius: 14px 14px 0 0; border-top: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 18px;
}
.lib-sheet-head { display: flex; align-items: center; justify-content: space-between; }
.lib-sheet-title { font-family: var(--font-heading); font-size: 18px; font-weight: 600; }
</style>

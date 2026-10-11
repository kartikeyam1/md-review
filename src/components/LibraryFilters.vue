<script setup lang="ts">
// The library's filter controls (#26 rule 6): collection, tag, mode, type and
// updated, combined with AND, plus "Clear filters". Plain <select>s: native
// keyboard and phone pickers, and their values mirror the URL.
import { computed } from 'vue'
import type { LibraryCollection, TagCount } from '@/composables/useLibrary'
import type { LibraryQuery } from '@/composables/libraryQuery'

const props = defineProps<{ query: LibraryQuery; collections: LibraryCollection[]; tags: TagCount[]; active: boolean; stacked?: boolean }>()
const emit = defineEmits<{ change: [patch: Partial<LibraryQuery>]; clear: [] }>()

// A URL value the lists do not (yet) contain still shows as selected.
const tagOptions = computed(() => {
  const list = props.tags.map((t) => ({ value: t.tag, label: `${t.tag} (${t.count})` }))
  if (props.query.tag && !list.some((t) => t.value === props.query.tag)) list.unshift({ value: props.query.tag, label: props.query.tag })
  return list
})
const collectionOptions = computed(() => {
  const list = props.collections.map((c) => ({ value: c.id, label: c.name }))
  const v = props.query.collection
  if (v && v !== 'none' && !list.some((c) => c.value === v)) list.unshift({ value: v, label: 'Unknown collection' })
  return list
})

// v-model (not :value) so a selection survives options arriving after the first render.
const model = <K extends keyof LibraryQuery>(k: K) => computed<string>({
  get: () => props.query[k],
  set: (v) => emit('change', { [k]: v } as Partial<LibraryQuery>),
})
const collection = model('collection')
const tag = model('tag')
const mode = model('mode')
const type = model('type')
const updated = model('updated')
</script>

<template>
  <div class="lib-filters" :class="{ stacked }" role="group" aria-label="Filters">
    <label class="lib-filter">
      <span class="lib-filter-label">Collection</span>
      <select v-model="collection" data-testid="library-filter-collection">
        <option value="">All</option>
        <option v-for="c in collectionOptions" :key="c.value" :value="c.value">{{ c.label }}</option>
        <option value="none">Unfiled</option>
      </select>
    </label>
    <label class="lib-filter">
      <span class="lib-filter-label">Tag</span>
      <select v-model="tag" data-testid="library-filter-tag">
        <option value="">Any</option>
        <option v-for="t in tagOptions" :key="t.value" :value="t.value">{{ t.label }}</option>
      </select>
    </label>
    <label class="lib-filter">
      <span class="lib-filter-label">Mode</span>
      <select v-model="mode" data-testid="library-filter-mode">
        <option value="">Any</option>
        <option value="publish">Publish</option>
        <option value="review">Review</option>
      </select>
    </label>
    <label class="lib-filter">
      <span class="lib-filter-label">Type</span>
      <select v-model="type" data-testid="library-filter-type">
        <option value="">Any</option>
        <option value="md">Markdown</option>
        <option value="html">HTML</option>
      </select>
    </label>
    <label class="lib-filter">
      <span class="lib-filter-label">Updated</span>
      <select v-model="updated" data-testid="library-filter-updated">
        <option value="">Any time</option>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
        <option value="90d">Last 90 days</option>
      </select>
    </label>
    <button v-if="active" type="button" class="lib-clear" data-testid="library-clear-filters" @click="emit('clear')">Clear filters</button>
  </div>
</template>

<style scoped>
.lib-filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 10px; min-width: 0; }
.lib-filters.stacked { flex-direction: column; align-items: stretch; }
.lib-filter { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.lib-filter-label { font-size: 11px; color: var(--text-meta); font-weight: 500; }
.lib-filter select {
  font-family: var(--font-body); font-size: 13px; padding: 5px 8px; min-width: 7.5em; max-width: 14em;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg-surface); color: var(--text-primary);
}
.stacked .lib-filter select { max-width: none; width: 100%; padding: 8px; font-size: 15px; }
.lib-clear {
  border: none; background: transparent; color: var(--accent-text); font-size: 13px; font-weight: 600;
  padding: 6px 8px; border-radius: 6px; align-self: flex-end;
}
.lib-clear:hover, .lib-clear:focus-visible { background: var(--comment-bg); }
</style>

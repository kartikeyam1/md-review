<script setup lang="ts">
// The collections list of the library (#26 rule 11): All documents, each
// collection with its doc count (rename / delete in an AppMenu), Unfiled, and
// an inline "New collection" field. Collections need no edit capability.
import { ref, nextTick } from 'vue'
import AppMenu, { type AppMenuEntry } from '@/components/AppMenu.vue'
import type { LibraryCollection } from '@/composables/useLibrary'

const props = defineProps<{
  collections: LibraryCollection[]
  /** The collection filter in the URL: '' (all), an id, or 'none'. */
  active: string
  create: (name: string) => Promise<string | null>
  rename: (id: string, name: string) => Promise<string | null>
}>()
const emit = defineEmits<{ select: [value: string]; delete: [c: LibraryCollection] }>()

// editing: null, 'new' or a collection id being renamed
const editing = ref<string | null>(null)
const draft = ref('')
const error = ref('')
const busy = ref(false)
const input = ref<HTMLInputElement[] | HTMLInputElement | null>(null)

async function startEdit(target: 'new' | LibraryCollection) {
  editing.value = target === 'new' ? 'new' : target.id
  draft.value = target === 'new' ? '' : target.name
  error.value = ''
  await nextTick()
  const el = Array.isArray(input.value) ? input.value[0] : input.value
  el?.focus()
  el?.select()
}

function cancel() {
  editing.value = null
  error.value = ''
}

async function commit() {
  if (busy.value || !editing.value) return
  const name = draft.value.trim()
  if (!name || name.length > 60) { error.value = 'A collection name is 1–60 characters'; return }
  const lower = name.toLowerCase()
  const clash = props.collections.find((c) => c.name.toLowerCase() === lower && c.id !== editing.value)
  if (clash) { error.value = 'A collection with that name already exists'; return }
  busy.value = true
  const err = editing.value === 'new' ? await props.create(name) : await props.rename(editing.value, name)
  busy.value = false
  if (err) { error.value = err; return }
  cancel()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); void commit() }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel() }
}

function menuFor(c: LibraryCollection): AppMenuEntry[] {
  return [
    { type: 'item', id: 'rename', label: 'Rename', onSelect: () => void startEdit(c) },
    { type: 'item', id: 'delete', label: 'Delete', onSelect: () => emit('delete', c) },
  ]
}
</script>

<template>
  <nav class="lib-collections" data-testid="library-collections" aria-label="Collections">
    <div class="lib-col-head">
      <span class="lib-col-heading">Collections</span>
      <button
        type="button"
        class="lib-col-new"
        data-testid="library-collection-new"
        title="New collection"
        aria-label="New collection"
        @click="startEdit('new')"
      >+ New</button>
    </div>
    <ul class="lib-col-list">
      <li>
        <button type="button" class="lib-col-item" :class="{ active: active === '' }" :aria-current="active === '' ? 'true' : undefined"
                data-testid="library-collection-item" data-collection="" @click="emit('select', '')">
          <span class="lib-col-name">All documents</span>
        </button>
      </li>
      <li v-for="c in collections" :key="c.id" class="lib-col-row">
        <input
          v-if="editing === c.id"
          ref="input"
          v-model="draft"
          class="lib-collection-input"
          maxlength="60"
          aria-label="Collection name"
          @keydown="onKeydown"
          @blur="cancel"
        />
        <template v-else>
          <button type="button" class="lib-col-item" :class="{ active: active === c.id }" :aria-current="active === c.id ? 'true' : undefined"
                  data-testid="library-collection-item" :data-collection="c.id" @click="emit('select', c.id)">
            <span class="lib-col-name">{{ c.name }}</span>
            <span class="lib-col-count">{{ c.doc_count }}</span>
          </button>
          <AppMenu :entries="menuFor(c)" :label="`Actions for ${c.name}`" trigger-testid="library-collection-menu" trigger-class="lib-col-menu">
            <template #trigger>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
            </template>
          </AppMenu>
        </template>
      </li>
      <li>
        <button type="button" class="lib-col-item" :class="{ active: active === 'none' }" :aria-current="active === 'none' ? 'true' : undefined"
                data-testid="library-collection-item" data-collection="none" @click="emit('select', 'none')">
          <span class="lib-col-name">Unfiled</span>
        </button>
      </li>
    </ul>
    <input
      v-if="editing === 'new'"
      ref="input"
      v-model="draft"
      class="lib-collection-input"
      placeholder="Collection name"
      maxlength="60"
      aria-label="New collection name"
      @keydown="onKeydown"
    />
    <p v-if="error" class="lib-col-error" role="alert" data-testid="library-collection-error">{{ error }}</p>
  </nav>
</template>

<style scoped>
.lib-collections { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.lib-col-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.lib-col-heading { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-meta); }
.lib-col-new {
  border: none; background: transparent; color: var(--accent-text); font-size: 12px; font-weight: 600; padding: 4px 6px; border-radius: 4px;
}
.lib-col-new:hover, .lib-col-new:focus-visible { background: var(--comment-bg); }
.lib-col-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.lib-col-row { display: flex; align-items: center; gap: 2px; min-width: 0; }
.lib-col-item {
  flex: 1; min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 6px 8px; border: none; border-radius: 6px; background: transparent; color: var(--text-secondary);
  font-size: 13px; text-align: left;
}
.lib-col-item:hover { background: var(--bg-code); color: var(--text-primary); }
.lib-col-item.active { background: var(--comment-bg); color: var(--text-primary); font-weight: 600; }
.lib-col-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-col-count { font-size: 11px; color: var(--text-meta); font-variant-numeric: tabular-nums; }
.lib-col-row :deep(.lib-col-menu) {
  border: none; background: transparent; color: var(--text-meta); padding: 4px 6px; border-radius: 4px; display: inline-flex;
}
.lib-col-row :deep(.lib-col-menu:hover), .lib-col-row :deep(.lib-col-menu[aria-expanded="true"]) { background: var(--bg-code); color: var(--text-primary); }
.lib-collection-input {
  width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: 13px; font-family: var(--font-body);
  border: 1px solid var(--accent); border-radius: 6px; background: var(--bg-surface); color: var(--text-primary);
}
.lib-col-error { margin: 0; font-size: 12px; color: var(--cat-must-fix); }
</style>

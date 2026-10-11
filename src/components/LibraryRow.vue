<script setup lang="ts">
// One library row (#26 rule 3): title link, type/mode badges, author, updated
// time, reaction/view counts (hidden when null), tag chips, collection, file
// count, must-fix chip; select, pin and (editors) inline tag add/remove. On a
// phone (rule 17) it is a stacked card: title, then badges + updated, then tags
// (that line only when it has something in it). Its height is known up front
// (libraryRowHeight — the list is virtualised); text never wraps past its line.
import { ref, computed, nextTick } from 'vue'
import { normalizeTag, MAX_TAGS_PER_DOC } from '@shared/tags.mjs'
import { relativeTime } from '@/composables/docMeta'
import { cardHasTagsLine, type LibraryItem } from '@/composables/useLibrary'

const props = defineProps<{
  item: LibraryItem
  href: string
  canEdit: boolean
  selected: boolean
  phone: boolean
  now: number
  saveTags: (item: LibraryItem, tags: string[]) => Promise<string | null>
}>()
const emit = defineEmits<{ open: []; pin: []; select: [on: boolean]; tag: [tag: string] }>()

const updatedMs = computed(() => (props.item.updated_at ? Date.parse(props.item.updated_at) : NaN))
const updatedRel = computed(() => (Number.isNaN(updatedMs.value) ? '—' : relativeTime(updatedMs.value, props.now)))
const updatedAbs = computed(() => (Number.isNaN(updatedMs.value) ? '' : new Date(updatedMs.value).toLocaleString()))
const typeLabel = computed(() => (props.item.contentType === 'html' ? 'html' : 'md'))
const author = computed(() => (props.item.created_by || '').trim() || '—')

const adding = ref(false)
const draft = ref('')
const tagError = ref('')
const busy = ref(false)
const tagInput = ref<HTMLInputElement | null>(null)

async function startAdd() {
  adding.value = true
  draft.value = ''
  tagError.value = ''
  await nextTick()
  tagInput.value?.focus()
}
function stopAdd() { adding.value = false; tagError.value = '' }

async function commitTag() {
  if (busy.value) return
  const r = normalizeTag(draft.value)
  if (r.error !== undefined) { tagError.value = r.error; return }
  const tag = r.tag
  if (props.item.tags.includes(tag)) { stopAdd(); return }
  if (props.item.tags.length >= MAX_TAGS_PER_DOC) { tagError.value = `At most ${MAX_TAGS_PER_DOC} tags per document`; return }
  busy.value = true
  const err = await props.saveTags(props.item, [...props.item.tags, tag])
  busy.value = false
  if (err) { tagError.value = err; return }
  stopAdd()
}

async function removeTag(tag: string) {
  const err = await props.saveTags(props.item, props.item.tags.filter((t) => t !== tag))
  if (err) tagError.value = err
}

function onTagKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); void commitTag() }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopAdd() }
}
function onTagBlur() { if (!draft.value.trim()) stopAdd() }

/** A click anywhere on the row that is not on a control opens the doc. */
function onRowClick(e: MouseEvent) {
  const t = e.target as Element | null
  if (t?.closest('a, button, input, select, textarea, label, .lib-tag-error')) return
  if (e.metaKey || e.ctrlKey || e.shiftKey) return
  emit('open')
}
function onTitleClick(e: MouseEvent) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  emit('open')
}

const snippet = computed(() => props.item.match?.snippet ?? null)
</script>

<template>
  <div
    class="library-row"
    :class="{ selected, phone, 'has-snippet': !!snippet }"
    data-testid="library-row"
    :data-doc-id="item.id"
    @click="onRowClick"
  >
    <input
      type="checkbox"
      class="lib-select"
      :checked="selected"
      :aria-label="`Select ${item.title}`"
      data-testid="library-row-select"
      @change="emit('select', ($event.target as HTMLInputElement).checked)"
    />
    <div class="lib-body">
      <div class="lib-line lib-line-title">
        <a class="library-row-title" :href="href" @click="onTitleClick">{{ item.title }}</a>
        <template v-if="!phone">
          <span class="lib-badge lib-badge-type">{{ typeLabel }}</span>
          <span class="lib-badge lib-badge-mode" :class="item.mode" :data-mode="item.mode">{{ item.mode }}</span>
          <span v-if="item.file_count > 0" class="lib-badge lib-files" :title="`${item.file_count} attached file${item.file_count === 1 ? '' : 's'}`">{{ item.file_count }} file{{ item.file_count === 1 ? '' : 's' }}</span>
          <span v-if="item.mode === 'review' && item.must_fix_unresolved > 0" class="lib-badge lib-mustfix">{{ item.must_fix_unresolved }} must-fix</span>
        </template>
      </div>
      <div class="lib-line lib-line-meta">
        <template v-if="phone">
          <span class="lib-badge lib-badge-type">{{ typeLabel }}</span>
          <span class="lib-badge lib-badge-mode" :class="item.mode" :data-mode="item.mode">{{ item.mode }}</span>
          <span v-if="item.file_count > 0" class="lib-badge lib-files">{{ item.file_count }} file{{ item.file_count === 1 ? '' : 's' }}</span>
          <span v-if="item.mode === 'review' && item.must_fix_unresolved > 0" class="lib-badge lib-mustfix">{{ item.must_fix_unresolved }} must-fix</span>
        </template>
        <span class="lib-author" :title="item.created_by ? `Created by ${item.created_by}` : 'Author unknown'">{{ author }}</span>
        <span class="lib-dot" aria-hidden="true">·</span>
        <time class="lib-updated" :datetime="item.updated_at ?? undefined" :title="updatedAbs">{{ updatedRel }}</time>
        <template v-if="!phone">
          <span v-if="item.reaction_count !== null" class="lib-count lib-reactions" :title="`${item.reaction_count} reactions`">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/></svg>{{ item.reaction_count }}
          </span>
          <span v-if="item.view_count !== null" class="lib-count lib-views" :title="`${item.view_count} views`">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>{{ item.view_count }}
          </span>
          <span v-if="item.collection" class="lib-collection" :title="`Collection: ${item.collection.name}`">{{ item.collection.name }}</span>
        </template>
        <span v-if="!phone" class="lib-tags">
          <template v-if="adding">
            <input
              ref="tagInput"
              v-model="draft"
              class="lib-tag-input"
              placeholder="tag"
              maxlength="64"
              aria-label="New tag"
              @keydown="onTagKeydown"
              @blur="onTagBlur"
            />
            <span v-if="tagError" class="lib-tag-error" role="alert" data-testid="library-tag-error">{{ tagError }}</span>
          </template>
          <span v-for="t in item.tags" :key="t" class="lib-tag">
            <button type="button" class="lib-tag-name" :title="`Show documents tagged ${t}`" @click="emit('tag', t)">{{ t }}</button>
            <button v-if="canEdit" type="button" class="lib-tag-x" :aria-label="`Remove tag ${t}`" data-testid="library-tag-remove" @click="removeTag(t)">×</button>
          </span>
          <button v-if="canEdit && !adding" type="button" class="lib-tag-add" data-testid="library-row-tag-add" aria-label="Add a tag" title="Add a tag" @click="startAdd">+ tag</button>
          <span v-if="tagError && !adding" class="lib-tag-error" role="alert" data-testid="library-tag-error">{{ tagError }}</span>
        </span>
      </div>
      <div v-if="phone && cardHasTagsLine(item, canEdit)" class="lib-line lib-line-tags">
        <span v-if="item.collection" class="lib-collection">{{ item.collection.name }}</span>
        <span class="lib-tags">
          <template v-if="adding">
            <input ref="tagInput" v-model="draft" class="lib-tag-input" placeholder="tag" maxlength="64" aria-label="New tag" @keydown="onTagKeydown" @blur="onTagBlur" />
            <span v-if="tagError" class="lib-tag-error" role="alert" data-testid="library-tag-error">{{ tagError }}</span>
          </template>
          <span v-for="t in item.tags" :key="t" class="lib-tag">
            <button type="button" class="lib-tag-name" @click="emit('tag', t)">{{ t }}</button>
            <button v-if="canEdit" type="button" class="lib-tag-x" :aria-label="`Remove tag ${t}`" data-testid="library-tag-remove" @click="removeTag(t)">×</button>
          </span>
          <button v-if="canEdit && !adding" type="button" class="lib-tag-add" data-testid="library-row-tag-add" aria-label="Add a tag" @click="startAdd">+ tag</button>
          <span v-if="tagError && !adding" class="lib-tag-error" role="alert" data-testid="library-tag-error">{{ tagError }}</span>
        </span>
      </div>
      <div v-if="snippet" class="lib-line lib-snippet" data-testid="library-row-snippet">
        <span v-if="item.match?.field === 'file' && item.match.file" class="lib-snippet-file">{{ item.match.file }}:&nbsp;</span>
        <template v-for="(seg, i) in snippet" :key="i"><mark v-if="seg.hit" class="lib-hit" data-testid="library-snippet-hit">{{ seg.text }}</mark><span v-else>{{ seg.text }}</span></template>
      </div>
    </div>
    <button
      type="button"
      class="lib-pin"
      :aria-pressed="item.pinned ? 'true' : 'false'"
      :aria-label="item.pinned ? `Unpin ${item.title}` : `Pin ${item.title}`"
      :title="item.pinned ? 'Unpin' : 'Pin'"
      data-testid="library-pin-toggle"
      @click="emit('pin')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" :fill="item.pinned ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/></svg>
    </button>
  </div>
</template>

<style scoped>
.library-row {
  --pad-y: 10px;
  box-sizing: border-box;
  height: var(--lib-row-h, 68px);
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: var(--pad-y) 10px var(--pad-y) 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
  overflow: hidden;
  cursor: pointer;
  min-width: 0;
}
.library-row:hover { background: color-mix(in srgb, var(--bg-surface) 88%, var(--text-primary)); }
.library-row.selected { background: var(--comment-bg); }
.library-row.phone {
  --pad-y: 12px;
  height: calc(var(--lib-row-h, 112px) - 8px);
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
}
.lib-select { margin: 4px 0 0; flex: none; width: 16px; height: 16px; accent-color: var(--accent); }
.lib-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.phone .lib-body { gap: 6px; }
.lib-line { display: flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap; overflow: hidden; }
.lib-line-title { height: 22px; }
.lib-line-meta, .lib-line-tags { height: 22px; font-size: 12px; color: var(--text-meta); }
.library-row-title {
  min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis;
  font-weight: 600; font-size: 15px; color: var(--text-primary); text-decoration: none;
}
.library-row-title:hover, .library-row-title:focus-visible { text-decoration: underline; }
.lib-badge {
  flex: none; font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 999px;
  border: 1px solid var(--border); color: var(--text-secondary); background: var(--bg-page);
}
.lib-badge-mode.review { border-color: color-mix(in srgb, var(--cat-question) 45%, var(--border)); color: var(--text-primary); }
.lib-mustfix { background: var(--cat-must-fix); color: var(--cat-must-fix-on); border-color: transparent; font-weight: 600; }
.lib-author { flex: 0 1 auto; min-width: 0; max-width: 14em; overflow: hidden; text-overflow: ellipsis; }
.lib-updated { flex: none; }
.lib-dot { flex: none; }
.lib-count { flex: none; display: inline-flex; align-items: center; gap: 3px; font-variant-numeric: tabular-nums; }
.lib-collection {
  flex: none; max-width: 12em; overflow: hidden; text-overflow: ellipsis;
  padding: 0 6px; border-left: 2px solid var(--accent); color: var(--text-secondary);
}
.lib-tags { display: inline-flex; align-items: center; gap: 4px; min-width: 0; margin-left: 4px; }
.phone .lib-tags { margin-left: 0; }
.lib-tag {
  flex: none; display: inline-flex; align-items: center; border-radius: 999px;
  background: var(--bg-code); color: var(--text-secondary); font-size: 11px; line-height: 18px;
}
.lib-tag-name { border: none; background: transparent; color: inherit; font: inherit; padding: 0 7px; border-radius: 999px; }
.lib-tag-name::before { content: '#'; opacity: 0.6; }
.lib-tag-name:hover, .lib-tag-name:focus-visible { color: var(--text-primary); text-decoration: underline; }
.lib-tag-x { border: none; background: transparent; color: var(--text-meta); font-size: 13px; line-height: 1; padding: 0 6px 0 0; }
.lib-tag-x:hover { color: var(--cat-must-fix); }
.lib-tag-add {
  flex: none; border: 1px dashed var(--border); background: transparent; color: var(--text-meta);
  font-size: 11px; line-height: 16px; padding: 0 7px; border-radius: 999px;
}
.lib-tag-add:hover, .lib-tag-add:focus-visible { color: var(--text-primary); border-color: var(--text-meta); }
.lib-tag-input {
  width: 9em; font-size: 12px; padding: 1px 6px; border: 1px solid var(--accent); border-radius: 999px;
  background: var(--bg-surface); color: var(--text-primary); font-family: var(--font-body);
}
.lib-tag-error { flex: none; font-size: 11px; color: var(--cat-must-fix); font-weight: 500; }
.lib-snippet { height: 18px; font-size: 12.5px; color: var(--text-secondary); text-overflow: ellipsis; display: block; }
.lib-snippet-file { font-family: var(--font-mono); font-size: 11px; color: var(--text-meta); }
.lib-hit { background: var(--selection-bg); color: var(--text-primary); border-radius: 2px; padding: 0 1px; }
.lib-pin {
  flex: none; border: none; background: transparent; color: var(--text-meta);
  padding: 4px; border-radius: 6px; display: inline-flex; margin-top: -1px;
}
.lib-pin:hover, .lib-pin:focus-visible { color: var(--text-primary); background: var(--bg-code); }
.lib-pin[aria-pressed="true"] { color: var(--accent-text); }
</style>

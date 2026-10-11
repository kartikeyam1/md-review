<script setup lang="ts">
// "New from template" (#27 rules 9–12): pick a template, give the new doc a
// title (+ collection, author), see the substituted content rendered by the
// normal renderer (server dry run, debounced 300 ms), create → open it in
// edit view holding its edit token (#23). A modal (00 §3.4 layer 2): focus
// trapped, Esc closes it, Enter in the title submits. Mounted on demand by
// templateHost.ts (its own chunk, never in the entry — #6 AC-06.8).
// Closing it while a create is in flight does not navigate: the doc is still
// created (its edit token kept) and a toast offers to open it.
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import PreviewPane from '@/components/PreviewPane.vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { useRouter } from '@/composables/useRouter'
import { useReviewer } from '@/composables/useReviewer'
import { toast } from '@/composables/useToast'
import {
  orderTemplates, filterTemplates, showTemplateFilter, collectionChoice, apiErrorText, themeFromRoot,
  type TemplateSummary, type TemplateCollectionRef,
} from '@/composables/templateLogic'
import { listTemplates, listCollections, renderTemplate, instantiateTemplate } from '@/composables/useTemplates'

const props = defineProps<{ initialTemplateId?: string | null }>()
const emit = defineEmits<{ close: [] }>()

const router = useRouter()
const { reviewerName } = useReviewer()

const PREVIEW_DEBOUNCE_MS = 300
const MAX_TITLE = 200

const templates = ref<TemplateSummary[]>([])
const collections = ref<TemplateCollectionRef[]>([])
const status = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const filter = ref('')
const selected = ref<TemplateSummary | null>(null)
const title = ref('')
const collectionId = ref('')
const author = ref(reviewerName.value)
const busy = ref(false)
/** Set on unmount: a create still in flight then must not navigate. */
let closed = false
const previewContent = ref('')
const previewError = ref('')
const theme = themeFromRoot(document.documentElement)

const ordered = computed(() => orderTemplates(templates.value))
const showFilter = computed(() => showTemplateFilter(templates.value.length))
const shown = computed(() => (showFilter.value ? filterTemplates(ordered.value, filter.value) : ordered.value))
/** Create is possible (title + template); while `busy` it stays focusable but inert (aria-disabled). */
const createReady = computed(() => !!title.value.trim() && !!selected.value)
const canCreate = computed(() => createReady.value && !busy.value)

const backdrop = ref<HTMLElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const titleInput = ref<HTMLInputElement | null>(null)
const filterInput = ref<HTMLInputElement | null>(null)
useFocusTrap(dialogEl, computed(() => true), {
  initialFocus: () => (selected.value ? titleInput.value : filterInput.value) ?? dialogEl.value?.querySelector<HTMLElement>('.tp-item') ?? null,
})
const titleId = `tp-title-${Math.random().toString(36).slice(2, 8)}`

async function load() {
  status.value = 'loading'
  const [t, c] = await Promise.all([listTemplates(), listCollections()])
  if (!t.ok || !Array.isArray(t.data)) {
    status.value = 'error'
    loadError.value = apiErrorText(t.status, t.data)
    return
  }
  templates.value = t.data
  collections.value = c.ok && Array.isArray(c.data) ? c.data.map((x) => ({ id: x.id, name: x.name })) : []
  status.value = 'ready'
  const pre = props.initialTemplateId ? t.data.find((x) => x.id === props.initialTemplateId) : null
  if (pre) choose(pre)
  else nextTick(() => (filterInput.value ?? dialogEl.value?.querySelector<HTMLElement>('.tp-item'))?.focus())
}

function choose(t: TemplateSummary) {
  selected.value = t
  collectionId.value = collectionChoice(t, collections.value)
  previewContent.value = ''
  previewError.value = ''
  nextTick(() => titleInput.value?.focus())
}

function back() {
  selected.value = null
  nextTick(() => (filterInput.value ?? dialogEl.value?.querySelector<HTMLElement>('.tp-item'))?.focus())
}

// ── Preview (rule 10): debounced dry run, rendered with PreviewPane ──
let previewTimer: ReturnType<typeof setTimeout> | null = null
let previewAbort: AbortController | null = null
async function refreshPreview() {
  const t = selected.value
  if (!t) return
  previewAbort?.abort()
  const ac = new AbortController()
  previewAbort = ac
  try {
    const r = await renderTemplate(t.id, { title: title.value.trim(), author: author.value.trim() || undefined, collectionId: collectionId.value || null }, ac.signal)
    if (ac.signal.aborted || selected.value !== t) return
    if (r.ok && r.data) { previewContent.value = r.data.content; previewError.value = '' }
    else previewError.value = apiErrorText(r.status, r.data)
  } catch { /* aborted by a newer keystroke */ }
}
watch([selected, title, author, collectionId], () => {
  if (previewTimer) clearTimeout(previewTimer)
  if (!selected.value) return
  previewTimer = setTimeout(() => { previewTimer = null; void refreshPreview() }, PREVIEW_DEBOUNCE_MS)
})

// ── Create (rules 11–13) ──
async function create() {
  const t = selected.value
  if (!t || !canCreate.value) return
  const docTitle = title.value.trim()
  busy.value = true
  const r = await instantiateTemplate(t.id, { title: docTitle, author: author.value.trim() || undefined, collectionId: collectionId.value || null })
  busy.value = false
  if (!r.ok || !r.data?.id) {
    // Rule 12: the picker stays open with its inputs intact.
    toast.error(`Could not create the document: ${apiErrorText(r.status, r.data)}`)
    return
  }
  const target = { kind: 'doc' as const, id: r.data.slug || r.data.id }
  if (closed) {
    // Closed (Esc, Cancel, Back) while creating: never navigate behind the reader's back.
    toast.success(`Created “${docTitle}”`, { action: { label: 'Open', onClick: () => router.pushRoute(target, 'view=edit') } })
    return
  }
  emit('close')
  router.pushRoute(target, 'view=edit')
}

// Esc closes this layer (00 §3.4 layer 2) and goes no further. Handled on the dialog,
// so a layer above it (the #15 zoom viewer) sees Esc first; focus never leaves the
// dialog (Create is aria-disabled, not disabled, while busy; the dialog is focusable).
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return
  e.preventDefault()
  e.stopPropagation()
  emit('close')
}
function onTitleKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.isComposing) return
  e.preventDefault()
  void create()
}

// Navigating away (Back, a link) closes the picker.
const stopRoute = watch(() => router.current.value.href, () => emit('close'))
onMounted(load)
onUnmounted(() => {
  closed = true
  stopRoute()
  if (previewTimer) clearTimeout(previewTimer)
  previewAbort?.abort()
})

const typeLabel = (t: TemplateSummary) => (t.contentType === 'html' ? 'HTML' : 'Markdown')
</script>

<template>
  <div ref="backdrop" class="tp-backdrop" data-testid="template-picker" @mousedown.self.prevent @click.self="emit('close')">
    <div
      ref="dialogEl"
      class="tp-dialog"
      :class="{ 'tp-has-form': selected }"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      :aria-busy="busy ? 'true' : undefined"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="tp-head">
        <button v-if="selected" type="button" class="tp-back" aria-label="All templates" title="All templates" @click="back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <h2 :id="titleId" class="tp-title">{{ selected ? selected.name : 'New from template' }}</h2>
        <button type="button" class="tp-close" aria-label="Close" title="Close (Esc)" @click="emit('close')">×</button>
      </header>

      <div v-if="status === 'loading'" class="tp-state" aria-busy="true">Loading templates…</div>
      <div v-else-if="status === 'error'" class="tp-state" role="alert">
        <p>Could not load templates. {{ loadError }}</p>
        <button type="button" class="btn btn-primary" @click="load">Retry</button>
      </div>

      <div v-else-if="!selected" class="tp-body tp-list-body">
        <input
          v-if="showFilter"
          ref="filterInput"
          v-model="filter"
          type="search"
          class="tp-input tp-filter"
          placeholder="Filter templates…"
          aria-label="Filter templates"
          data-testid="template-picker-filter"
        />
        <ul class="tp-list" role="list">
          <li v-for="t in shown" :key="t.id">
            <button type="button" class="tp-item" data-testid="template-picker-item" :data-template-id="t.id" @click="choose(t)">
              <span class="tp-item-top">
                <span class="tp-item-name">{{ t.name }}</span>
                <span v-if="t.builtin" class="tp-badge" data-testid="template-builtin-badge">Built-in</span>
              </span>
              <span v-if="t.description" class="tp-item-desc">{{ t.description }}</span>
              <span class="tp-item-meta">
                <span class="tp-type">{{ typeLabel(t) }}</span>
                <span class="tp-type">{{ t.mode === 'review' ? 'Review' : 'Publish' }}</span>
                <span v-if="t.variables.length" class="tp-sr">Variables:</span>
                <span v-for="v in t.variables" :key="v" class="tp-chip">{{ v }}</span>
              </span>
            </button>
          </li>
        </ul>
        <p v-if="!shown.length" class="tp-empty">No templates match “{{ filter }}”.</p>
      </div>

      <template v-else>
        <div class="tp-body tp-form-body">
          <div class="tp-form">
            <label class="tp-field">
              <span class="tp-label">Title</span>
              <input
                ref="titleInput"
                v-model="title"
                class="tp-input"
                :maxlength="MAX_TITLE"
                placeholder="The new document's title"
                required
                data-testid="template-title-input"
                @keydown="onTitleKeydown"
              />
            </label>
            <label class="tp-field">
              <span class="tp-label">Collection</span>
              <select v-model="collectionId" class="tp-input" data-testid="template-collection-select">
                <option value="">Unfiled</option>
                <option v-for="c in collections" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </label>
            <label class="tp-field">
              <span class="tp-label">Author</span>
              <input v-model="author" class="tp-input" maxlength="80" placeholder="Your name (optional)" data-testid="template-author-input" />
            </label>
            <p class="tp-hint">Placeholders like <code v-pre>{{date}}</code> are filled in; any without a value stay as they are.</p>
          </div>
          <section class="tp-preview-wrap" aria-label="Preview">
            <span class="tp-label">Preview</span>
            <div class="tp-preview" :class="{ html: selected.contentType === 'html' }" data-testid="template-preview">
              <p v-if="previewError" class="tp-preview-msg" aria-live="polite">{{ previewError }}</p>
              <PreviewPane
                v-else-if="previewContent"
                standalone
                :content="previewContent"
                :comments="[]"
                :commenting="false"
                :theme="theme"
                :content-type="selected.contentType"
              />
              <p v-else class="tp-preview-msg">Rendering…</p>
            </div>
          </section>
        </div>
        <footer class="tp-foot">
          <button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button>
          <button
            type="button"
            class="btn btn-primary"
            :disabled="!createReady"
            :aria-disabled="busy ? 'true' : undefined"
            data-testid="template-create-btn"
            @click="create"
          >
            {{ busy ? 'Creating…' : 'Create document' }}
          </button>
        </footer>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tp-backdrop {
  position: fixed; inset: 0; z-index: 400; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: var(--overlay-bg); box-sizing: border-box;
}
.tp-dialog {
  box-sizing: border-box; width: min(640px, 100%); max-height: min(88vh, 900px);
  display: flex; flex-direction: column; min-width: 0;
  background: var(--bg-surface); color: var(--text-primary); font-family: var(--font-body);
  border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 40px var(--shadow-color);
  overflow: hidden;
}
.tp-dialog:focus { outline: none; }
.tp-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.tp-dialog.tp-has-form { width: min(1040px, 100%); height: min(88vh, 900px); }
.tp-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
.tp-title { flex: 1; min-width: 0; margin: 0; font-family: var(--font-heading); font-size: 18px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-back, .tp-close {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px;
  border: none; border-radius: 6px; background: transparent; color: var(--text-meta); font-size: 22px; line-height: 1; cursor: pointer;
}
.tp-back:hover, .tp-close:hover { background: var(--bg-code); color: var(--text-primary); }
.tp-state { padding: 32px 16px; text-align: center; color: var(--text-meta); font-size: 14px; }
.tp-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px; }
.tp-input {
  box-sizing: border-box; width: 100%; padding: 8px 10px; font-size: 14px; font-family: var(--font-body);
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg-page); color: var(--text-primary);
}
.tp-input:focus { outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 0; border-color: var(--accent); }
.tp-filter { margin-bottom: 12px; }
.tp-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.tp-item {
  box-sizing: border-box; width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
  padding: 10px 12px; text-align: left; cursor: pointer; font-family: var(--font-body);
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg-surface); color: var(--text-primary);
}
.tp-item:hover, .tp-item:focus-visible { border-color: var(--text-meta); background: var(--bg-page); }
.tp-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.tp-item-top { display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
.tp-item-name { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.tp-badge {
  flex: none; font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 10px;
  background: var(--comment-bg); color: var(--accent-text);
}
.tp-item-desc { font-size: 13px; color: var(--text-secondary); line-height: 1.4; overflow-wrap: anywhere; }
.tp-item-meta { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.tp-type, .tp-chip {
  font-size: 11px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border); color: var(--text-meta);
}
.tp-chip { font-family: var(--font-mono); background: var(--bg-code); border-color: transparent; }
.tp-empty { margin: 12px 0 0; font-size: 13px; color: var(--text-meta); }

.tp-form-body { display: grid; grid-template-columns: minmax(240px, 300px) minmax(0, 1fr); gap: 18px; overflow: hidden; }
.tp-form { display: flex; flex-direction: column; gap: 12px; min-width: 0; overflow-y: auto; }
.tp-field { display: flex; flex-direction: column; gap: 4px; }
.tp-label { font-size: 12px; font-weight: 600; color: var(--text-meta); }
.tp-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-meta); }
.tp-hint code { font-family: var(--font-mono); font-size: 11px; background: var(--bg-code); padding: 0 3px; border-radius: 3px; }
.tp-preview-wrap { display: flex; flex-direction: column; gap: 4px; min-width: 0; min-height: 0; }
.tp-preview {
  flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-page);
}
.tp-preview.html { overflow: hidden; }
.tp-preview :deep(.preview-pane) { padding: 16px 20px; max-width: none; margin: 0; zoom: 0.85; }
.tp-preview :deep(.html-frame) { height: 100%; min-height: 320px; }
.tp-preview-msg { margin: 0; padding: 16px; font-size: 13px; color: var(--text-meta); }
.tp-foot .btn[aria-disabled="true"] { cursor: progress; opacity: 0.7; }
.tp-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); background: var(--bg-surface); }

@media (max-width: 640px) {
  .tp-backdrop { padding: 0; align-items: stretch; }
  .tp-dialog, .tp-dialog.tp-has-form { width: 100%; max-height: none; height: 100%; border-radius: 0; border: none; }
  .tp-form-body { display: flex; flex-direction: column; overflow-y: auto; }
  .tp-form { overflow: visible; }
  .tp-preview { flex: none; height: 46vh; }
  .tp-input { font-size: 16px; }
  .tp-foot .btn { flex: 1; padding-top: 10px; padding-bottom: 10px; }
}
</style>

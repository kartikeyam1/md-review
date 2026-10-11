<script setup lang="ts">
// "Save as template" (#27 rules 14–17): copy what is on screen for the primary
// doc (unsaved editor edits included; session files are not captured) into a
// template. Name clash with a user template → error + Replace; with a builtin →
// error only. Success → toast linking the library Templates tab. A modal
// (00 §3.4 layer 2). Mounted on demand by templateHost.ts (its own chunk).
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { useRouter } from '@/composables/useRouter'
import { useReviewer } from '@/composables/useReviewer'
import { toast } from '@/composables/useToast'
import { applyTitleVar, tooLarge, TOO_LARGE_MESSAGE, apiErrorText, type TemplateCollectionRef } from '@/composables/templateLogic'
import { listCollections, saveTemplate, docCollectionId, type NameClash } from '@/composables/useTemplates'

const props = defineProps<{
  /** The doc title (00 §5): the default name. */
  title: string
  /** The primary doc's content as on screen. */
  content: string
  contentType: 'markdown' | 'html'
  mode: 'publish' | 'review'
  /** The shared doc's id, for its collection (null for a local doc). */
  docId: string | null
}>()
const emit = defineEmits<{ close: [] }>()

const router = useRouter()
const { reviewerName } = useReviewer()

const MAX_NAME = 80
const MAX_DESCRIPTION = 280

const name = ref(props.title.trim().slice(0, MAX_NAME))
const description = ref('')
const collectionId = ref('')
const mode = ref<'publish' | 'review'>(props.mode)
const useTitleVar = ref(true)
const collections = ref<TemplateCollectionRef[]>([])
const busy = ref(false)
const error = ref('')
/** A clash with a user template: Replace is offered (cleared by any edit of the name). */
const replaceable = ref(false)

/** Save is possible (a name); while `busy` the buttons stay focusable but inert (aria-disabled). */
const saveReady = computed(() => !!name.value.trim())
const canSave = computed(() => saveReady.value && !busy.value)

const dialogEl = ref<HTMLElement | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)
useFocusTrap(dialogEl, computed(() => true), { initialFocus: () => nameInput.value })
const titleId = `ts-title-${Math.random().toString(36).slice(2, 8)}`

onMounted(async () => {
  nextTick(() => nameInput.value?.select())
  const [c, docCol] = await Promise.all([listCollections(), props.docId ? docCollectionId(props.docId) : Promise.resolve(null)])
  collections.value = c.ok && Array.isArray(c.data) ? c.data.map((x) => ({ id: x.id, name: x.name })) : []
  // Rule 15: prefilled with the doc's collection — unless the reader already picked one.
  if (docCol && !collectionId.value && collections.value.some((x) => x.id === docCol)) collectionId.value = docCol
})

function onNameInput() {
  error.value = ''
  replaceable.value = false
}

async function save(replace = false) {
  if (!canSave.value) return
  // Replace keeps its error row (and so the focused Replace button) on screen until the answer.
  if (!replace) { error.value = ''; replaceable.value = false }
  const content = useTitleVar.value ? applyTitleVar(props.content, props.contentType).content : props.content
  if (tooLarge(content)) { error.value = TOO_LARGE_MESSAGE; replaceable.value = false; return }
  busy.value = true
  const r = await saveTemplate({
    name: name.value.trim(), description: description.value.trim(), content, contentType: props.contentType,
    mode: mode.value, collectionId: collectionId.value || null,
    ...(reviewerName.value ? { author: reviewerName.value } : {}),
    ...(replace ? { replace: true } : {}),
  })
  busy.value = false
  error.value = ''
  replaceable.value = false
  if (!r.ok) nextTick(() => nameInput.value?.focus()) // back to the name, the field to change
  if (r.status === 409 && r.data && (r.data as unknown as NameClash).code === 'name_taken') {
    const clash = r.data as unknown as NameClash
    // Quote the existing template's name (it may differ from the typed one in case or spacing).
    const existing = clash.name || name.value.trim()
    if (clash.builtin) {
      error.value = `“${existing}” is the name of a built-in template. Choose another name.`
    } else {
      error.value = `A template named “${existing}” already exists.`
      replaceable.value = true
    }
    return
  }
  if (!r.ok || !r.data) { error.value = apiErrorText(r.status, r.data); return }
  emit('close')
  const tab = `${router.base}library?tab=templates`
  toast.success(`Saved as template “${r.data.name}”`, { action: { label: 'View templates', href: tab, onClick: () => router.push(tab) } })
}

// Esc closes this layer (00 §3.4 layer 2) and goes no further. Handled on the dialog,
// so a layer above it sees Esc first; focus never leaves the dialog (Save and Replace
// are aria-disabled, not disabled, while busy; the dialog itself is focusable).
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return
  e.preventDefault()
  e.stopPropagation()
  emit('close')
}

// Leaving the doc (Back/Forward, a link, another doc) closes the dialog: it holds that doc's content.
const stopRoute = watch(() => router.current.value, (loc, prev) => {
  if (loc.key !== prev.key || loc.source === 'pop') emit('close')
})
onUnmounted(stopRoute)
</script>

<template>
  <div class="ts-backdrop" @mousedown.self.prevent @click.self="emit('close')">
    <form
      ref="dialogEl"
      class="ts-dialog"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      :aria-busy="busy ? 'true' : undefined"
      tabindex="-1"
      data-testid="template-save-dialog"
      @submit.prevent="save(false)"
      @keydown="onKeydown"
    >
      <header class="ts-head">
        <h2 :id="titleId" class="ts-title">Save as template</h2>
        <button type="button" class="ts-close" aria-label="Close" title="Close (Esc)" @click="emit('close')">×</button>
      </header>
      <div class="ts-body">
        <label class="ts-field">
          <span class="ts-label">Name</span>
          <input
            ref="nameInput"
            v-model="name"
            class="ts-input"
            :maxlength="MAX_NAME"
            required
            data-testid="template-save-name"
            @input="onNameInput"
          />
        </label>
        <label class="ts-field">
          <span class="ts-label">Description <span class="ts-optional">(optional)</span></span>
          <textarea
            v-model="description"
            class="ts-input ts-textarea"
            rows="2"
            :maxlength="MAX_DESCRIPTION"
            placeholder="What it is for, in a sentence"
            data-testid="template-save-description"
          />
        </label>
        <div class="ts-row">
          <label class="ts-field">
            <span class="ts-label">Default collection</span>
            <select v-model="collectionId" class="ts-input" data-testid="template-save-collection">
              <option value="">Unfiled</option>
              <option v-for="c in collections" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
          <label class="ts-field">
            <span class="ts-label">Mode</span>
            <select v-model="mode" class="ts-input" data-testid="template-save-mode">
              <option value="publish">Publish</option>
              <option value="review">Review</option>
            </select>
          </label>
        </div>
        <label class="ts-check">
          <input v-model="useTitleVar" type="checkbox" data-testid="template-save-title-var" />
          <span>Use <code v-pre>{{title}}</code> in place of this doc's title</span>
        </label>
        <p class="ts-note">Copies this document's content as it is on screen. Attached files are not included.</p>
        <div v-if="error" class="ts-error" role="alert" data-testid="template-save-error">
          <span>{{ error }}</span>
          <button
            v-if="replaceable"
            type="button"
            class="btn btn-ghost ts-replace"
            :aria-disabled="busy ? 'true' : undefined"
            data-testid="template-save-replace"
            @click="save(true)"
          >
            Replace it
          </button>
        </div>
      </div>
      <footer class="ts-foot">
        <button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button>
        <button type="submit" class="btn btn-primary" :disabled="!saveReady" :aria-disabled="busy ? 'true' : undefined">
          {{ busy ? 'Saving…' : 'Save template' }}
        </button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.ts-backdrop {
  position: fixed; inset: 0; z-index: 400; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: var(--overlay-bg); box-sizing: border-box;
}
.ts-dialog {
  box-sizing: border-box; width: min(480px, 100%); max-height: min(90vh, 760px); display: flex; flex-direction: column;
  background: var(--bg-surface); color: var(--text-primary); font-family: var(--font-body);
  border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 40px var(--shadow-color); overflow: hidden; margin: 0;
}
.ts-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
.ts-title { flex: 1; margin: 0; font-family: var(--font-heading); font-size: 18px; font-weight: 600; }
.ts-close {
  flex: none; width: 32px; height: 32px; border: none; border-radius: 6px; background: transparent;
  color: var(--text-meta); font-size: 22px; line-height: 1; cursor: pointer;
}
.ts-close:hover { background: var(--bg-code); color: var(--text-primary); }
.ts-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.ts-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
.ts-row { display: flex; gap: 12px; }
.ts-label { font-size: 12px; font-weight: 600; color: var(--text-meta); }
.ts-optional { font-weight: 400; }
.ts-input {
  box-sizing: border-box; width: 100%; padding: 8px 10px; font-size: 14px; font-family: var(--font-body);
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg-page); color: var(--text-primary);
}
.ts-input:focus { outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 0; border-color: var(--accent); }
.ts-textarea { resize: vertical; min-height: 54px; }
.ts-check { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: var(--text-secondary); cursor: pointer; line-height: 1.4; }
.ts-check input { width: 16px; height: 16px; margin: 1px 0 0; accent-color: var(--accent); flex: none; }
.ts-check code { font-family: var(--font-mono); font-size: 12px; background: var(--bg-code); padding: 0 3px; border-radius: 3px; }
.ts-note { margin: 0; font-size: 12px; color: var(--text-meta); line-height: 1.5; }
.ts-error {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 10px; border-radius: 6px; font-size: 13px;
  color: var(--cat-must-fix); background: color-mix(in srgb, var(--cat-must-fix) 10%, var(--bg-surface));
  border: 1px solid color-mix(in srgb, var(--cat-must-fix) 35%, var(--border));
}
.ts-error > span { flex: 1 1 200px; overflow-wrap: anywhere; }
.ts-replace { color: var(--text-primary); }
.ts-dialog:focus { outline: none; }
.ts-dialog .btn[aria-disabled="true"] { cursor: progress; opacity: 0.7; }
.ts-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }

@media (max-width: 640px) {
  .ts-backdrop { padding: 0; align-items: flex-end; }
  .ts-dialog { width: 100%; max-height: 92vh; border-radius: 14px 14px 0 0; border-left: none; border-right: none; border-bottom: none; }
  .ts-row { flex-direction: column; }
  .ts-input { font-size: 16px; }
  .ts-foot .btn { flex: 1; padding-top: 10px; padding-bottom: 10px; }
}
</style>

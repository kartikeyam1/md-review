<script setup lang="ts">
// The library's Templates tab (#27 rule 18): every template with Use (opens the
// picker preselected) and, for user templates, a menu with Rename (same name
// rules as saving) and Delete (confirmed). Deleting a template never affects the
// docs created from it. Built-in templates have a badge and no menu.
import { ref, computed, nextTick, onMounted } from 'vue'
import AppMenu, { type AppMenuEntry } from '@/components/AppMenu.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { toast } from '@/composables/useToast'
import { orderTemplates, apiErrorText, type TemplateSummary } from '@/composables/templateLogic'
import { listTemplates, renameTemplate, deleteTemplate } from '@/composables/useTemplates'
import { newFromTemplateId } from '@/composables/templateEntry'

defineProps<{ phone?: boolean }>()

const MAX_NAME = 80

const templates = ref<TemplateSummary[]>([])
const status = ref<'loading' | 'ready' | 'error'>('loading')
const ordered = computed(() => orderTemplates(templates.value))

const renaming = ref<string | null>(null)
const draft = ref('')
const error = ref('')
const busy = ref(false)
const renameInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null)
const confirm = ref<TemplateSummary | null>(null)

async function load() {
  status.value = templates.value.length ? 'ready' : 'loading'
  const r = await listTemplates()
  if (r.ok && Array.isArray(r.data)) { templates.value = r.data; status.value = 'ready' }
  else if (!templates.value.length) status.value = 'error'
  else toast.error(`Could not refresh templates: ${apiErrorText(r.status, r.data)}`)
}

async function startRename(t: TemplateSummary) {
  renaming.value = t.id
  draft.value = t.name
  error.value = ''
  await nextTick()
  const el = Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value
  el?.focus()
  el?.select()
}
function cancelRename() { renaming.value = null; error.value = '' }
/** Blur cancels a rename, except while its request is in flight (its answer, maybe an error, is still to come). */
function onRenameBlur() { if (!busy.value) cancelRename() }

/** After a rename, Esc or a delete, focus that fell to <body> goes to a row's Use button (focus put elsewhere stays). */
async function focusUse(id: string | null) {
  await nextTick()
  const active = document.activeElement
  if (active && active !== document.body && active.isConnected) return
  const rows = [...document.querySelectorAll<HTMLElement>('.tpl-tab [data-testid="template-item"]')]
  const row = rows.find((r) => r.dataset.templateId === id) ?? null
  row?.querySelector<HTMLElement>('[data-testid="template-use"]')?.focus()
}

async function commitRename() {
  const id = renaming.value
  if (!id || busy.value) return
  const name = draft.value.trim()
  if (!name || name.length > MAX_NAME) { error.value = `A template name is 1–${MAX_NAME} characters`; return }
  busy.value = true
  const r = await renameTemplate(id, name)
  busy.value = false
  if (!r.ok) {
    error.value = apiErrorText(r.status, r.data)
    // The input may have lost focus while the request ran: keep the rename open, back in the input.
    if (renaming.value === id) await nextTick(() => (Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value)?.focus())
    return
  }
  cancelRename()
  await load()
  await focusUse(id)
}
function onRenameKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); void commitRename() }
  else if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation()
    const id = renaming.value
    cancelRename()
    void focusUse(id)
  }
}

async function confirmDelete() {
  const t = confirm.value
  confirm.value = null
  if (!t) return
  const r = await deleteTemplate(t.id)
  if (!r.ok && r.status !== 404) { toast.error(`Could not delete “${t.name}”: ${apiErrorText(r.status, r.data)}`); return }
  toast.success(`Deleted the template “${t.name}”`)
  // Focus goes to the row that takes its place (the next one, else the previous one).
  const list = ordered.value
  const i = list.findIndex((x) => x.id === t.id)
  const neighbour = list[i + 1] ?? list[i - 1] ?? null
  await load()
  await focusUse(neighbour?.id ?? null)
}

function menuFor(t: TemplateSummary): AppMenuEntry[] {
  return [
    { type: 'item', id: 'rename', label: 'Rename', onSelect: () => void startRename(t) },
    { type: 'item', id: 'delete', label: 'Delete', onSelect: () => { confirm.value = t } },
  ]
}

onMounted(load)
</script>

<template>
  <section class="tpl-tab" aria-label="Templates">
    <p class="tpl-intro">Start recurring documents from a template. Save any document as one from its ☰ menu.</p>
    <div v-if="status === 'loading'" class="tpl-state" aria-busy="true">Loading templates…</div>
    <div v-else-if="status === 'error'" class="tpl-state" role="alert">
      <p class="tpl-state-title">Could not load templates</p>
      <button type="button" class="btn btn-primary" @click="load">Retry</button>
    </div>
    <ul v-else class="tpl-list" :class="{ phone }">
      <li v-for="t in ordered" :key="t.id" class="tpl-row" data-testid="template-item" :data-template-id="t.id">
        <div class="tpl-main">
          <div class="tpl-top">
            <template v-if="renaming === t.id">
              <input
                ref="renameInput"
                v-model="draft"
                class="tpl-rename-input"
                :maxlength="MAX_NAME"
                aria-label="Template name"
                @keydown="onRenameKeydown"
                @input="error = ''"
                @blur="onRenameBlur"
              />
            </template>
            <template v-else>
              <span class="tpl-name">{{ t.name }}</span>
              <span v-if="t.builtin" class="tpl-badge" data-testid="template-builtin-badge">Built-in</span>
            </template>
          </div>
          <p v-if="renaming === t.id && error" class="tpl-error" role="alert">{{ error }}</p>
          <p v-if="t.description" class="tpl-desc">{{ t.description }}</p>
          <p class="tpl-meta">
            <span>{{ t.contentType === 'html' ? 'HTML' : 'Markdown' }}</span>
            <span>{{ t.mode === 'review' ? 'Review' : 'Publish' }}</span>
            <span v-if="t.collection">{{ t.collection.name }}</span>
            <span v-if="t.created_by">by {{ t.created_by }}</span>
          </p>
        </div>
        <div class="tpl-actions">
          <button type="button" class="btn btn-ghost tpl-use" data-testid="template-use" @click="newFromTemplateId(t.id)">Use</button>
          <AppMenu v-if="!t.builtin" :entries="menuFor(t)" :label="`Actions for ${t.name}`" trigger-testid="template-menu" trigger-class="tpl-menu">
            <template #trigger>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
            </template>
          </AppMenu>
        </div>
      </li>
    </ul>
    <ConfirmDialog
      v-if="confirm"
      dialog-testid="template-delete-confirm"
      :title="`Delete the template “${confirm.name}”?`"
      text="Documents created from it are not affected."
      ok-label="Delete template"
      @ok="confirmDelete"
      @cancel="confirm = null"
    />
  </section>
</template>

<style scoped>
.tpl-tab { min-width: 0; }
.tpl-intro { margin: 0 0 14px; font-size: 13px; color: var(--text-meta); }
.tpl-state { text-align: center; padding: 40px 16px; border: 1px dashed var(--border); border-radius: 10px; background: var(--bg-surface); color: var(--text-meta); font-size: 14px; }
.tpl-state-title { margin: 0 0 12px; font-family: var(--font-heading); font-size: 18px; font-weight: 600; color: var(--text-primary); }
.tpl-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-surface); overflow: hidden; }
.tpl-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--border); min-width: 0; }
.tpl-row:last-child { border-bottom: none; }
.tpl-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.tpl-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tpl-name { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.tpl-badge { flex: none; font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 10px; background: var(--comment-bg); color: var(--accent-text); }
.tpl-desc { margin: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.4; overflow-wrap: anywhere; }
.tpl-meta { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; color: var(--text-meta); }
.tpl-error { margin: 0; font-size: 12px; color: var(--cat-must-fix); }
.tpl-rename-input {
  box-sizing: border-box; width: min(360px, 100%); padding: 5px 8px; font-size: 14px; font-family: var(--font-body);
  border: 1px solid var(--accent); border-radius: 6px; background: var(--bg-surface); color: var(--text-primary);
}
.tpl-actions { flex: none; display: flex; align-items: center; gap: 4px; }
.tpl-actions :deep(.tpl-menu) {
  border: none; background: transparent; color: var(--text-meta); padding: 6px 8px; border-radius: 4px; display: inline-flex;
}
.tpl-actions :deep(.tpl-menu:hover), .tpl-actions :deep(.tpl-menu[aria-expanded="true"]) { background: var(--bg-code); color: var(--text-primary); }
.phone .tpl-row { align-items: flex-start; }
.phone .tpl-rename-input { font-size: 16px; }
</style>

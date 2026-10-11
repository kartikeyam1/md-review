<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useDocState } from '@/composables/useDocState'
import { useBreakpoint } from '@/composables/useBreakpoint'
import { useSessionFiles } from '@/composables/useSessionFiles'
import { primaryTabLabel, attachmentOpensInApp, formatFileSize } from '@/composables/sessionFiles'
import AppMenu, { type AppMenuEntry } from '@/components/AppMenu.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

// #26 rules 20 + 25: the file strip under the breadcrumb (00 §2.4 position 8).
// A tab for the primary doc, one per document file (sorted by name), the
// attachments menu, and — for editors — add / remove. Selecting a tab pushes
// its URL; the router (Back/Forward included) decides what is shown.
const doc = useDocState()
const files = useSessionFiles()
const bp = useBreakpoint()
const phone = computed(() => bp.value === 'phone')

const listRef = ref<HTMLElement>()
const inputRef = ref<HTMLInputElement>()

const primaryLabel = computed(() => primaryTabLabel(doc.filename.value))
const current = computed(() => files.currentFile.value)
const currentIsTab = computed(() => current.value === null || files.documents.value.some((d) => d.name === current.value))
/** The tab that takes Tab focus (roving tabindex): the selected one, else the primary. */
const focusName = computed(() => (currentIsTab.value ? current.value : null))

function onTabClick(e: MouseEvent, name: string | null) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  if (name === current.value) return
  files.select(name)
}

function onListKeydown(e: KeyboardEvent) {
  const tabs = Array.from(listRef.value?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
  const i = tabs.indexOf(document.activeElement as HTMLElement)
  if (i === -1) return
  let next = -1
  if (e.key === 'ArrowRight') next = (i + 1) % tabs.length
  else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = tabs.length - 1
  if (next === -1) return
  e.preventDefault()
  tabs[next].focus()
}

// Keep the selected tab in view inside the strip (it scrolls sideways on narrow screens).
watch(current, async () => {
  await nextTick()
  const list = listRef.value
  const sel = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
  if (!list || !sel) return
  const left = sel.offsetLeft - list.offsetLeft
  if (left < list.scrollLeft) list.scrollLeft = left
  else if (left + sel.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = left + sel.offsetWidth - list.clientWidth
}, { flush: 'post' })

function pickFiles() {
  inputRef.value?.click()
}

async function onPicked() {
  const input = inputRef.value
  const picked = input?.files ? Array.from(input.files) : []
  if (input) input.value = ''
  if (picked.length) await files.addFiles(picked)
}

const attachmentEntries = computed<AppMenuEntry[]>(() => {
  const out: AppMenuEntry[] = files.attachments.value.map((a) => ({
    type: 'item',
    id: `open:${a.name}`,
    testid: 'file-attachment-item',
    label: `${a.name}${a.size >= 0 ? ` · ${formatFileSize(a.size)}` : ''}`,
    title: attachmentOpensInApp(a.name, a.type) ? `Open ${a.name}` : `Download ${a.name}`,
    attrs: { 'data-file': a.name },
    onSelect: () => (attachmentOpensInApp(a.name, a.type) ? files.select(a.name) : files.download(a.name)),
  }))
  if (files.canManage.value && files.attachments.value.length) {
    out.push({ type: 'separator', id: 'sep-remove' })
    out.push({
      type: 'group',
      id: 'remove',
      label: 'Remove',
      entries: files.attachments.value.map((a) => ({
        type: 'item' as const,
        id: `remove:${a.name}`,
        testid: 'file-tab-remove',
        label: `Remove ${a.name}`,
        attrs: { 'data-file': a.name },
        onSelect: () => { files.removeFile(a.name) },
      })),
    })
  }
  return out
})
</script>

<template>
  <div v-if="files.stripShown.value" class="file-tabs" data-testid="file-tabs" :data-breakpoint="bp">
    <div ref="listRef" class="file-tab-list" role="tablist" aria-label="Document files" @keydown="onListKeydown">
      <span class="file-tab-item" role="presentation">
        <a
          class="file-tab"
          role="tab"
          data-testid="file-tab"
          data-file=""
          aria-controls="doc-tabpanel"
          :href="files.docPath()"
          :aria-selected="current === null ? 'true' : 'false'"
          :tabindex="focusName === null ? 0 : -1"
          :title="primaryLabel"
          @click="onTabClick($event, null)"
        >{{ primaryLabel }}</a>
      </span>
      <span v-for="d in files.documents.value" :key="d.name" class="file-tab-item" role="presentation">
        <a
          class="file-tab"
          role="tab"
          data-testid="file-tab"
          :data-file="d.name"
          aria-controls="doc-tabpanel"
          :href="files.filePath(d.name)"
          :aria-selected="current === d.name ? 'true' : 'false'"
          :tabindex="focusName === d.name ? 0 : -1"
          :title="d.name"
          @click="onTabClick($event, d.name)"
        >{{ d.name }}</a>
        <button
          v-if="files.canManage.value"
          type="button"
          class="file-tab-remove"
          data-testid="file-tab-remove"
          :data-file="d.name"
          :aria-label="`Remove ${d.name}`"
          :title="`Remove ${d.name}`"
          @click="files.removeFile(d.name)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
        </button>
      </span>
    </div>
    <span v-if="files.uploads.value.length" class="file-uploads" role="status" data-testid="file-upload-progress">
      <span class="file-upload-spinner" aria-hidden="true"></span>
      <span class="file-upload-text">Uploading {{ files.uploads.value.length === 1 ? files.uploads.value[0].name : `${files.uploads.value.length} files` }}…</span>
    </span>
    <div class="file-tabs-actions">
      <div v-if="files.attachments.value.length" class="file-attachments" data-testid="file-attachments-menu">
        <AppMenu
          :entries="attachmentEntries"
          :label="`Attachments (${files.attachments.value.length})`"
          menu-label="Attachments"
          trigger-class="btn btn-ghost file-tabs-btn"
          :trigger-title="`Attachments (${files.attachments.value.length})`"
          :sheet="phone"
        >
          <template #trigger>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
            <span class="file-tabs-count">{{ files.attachments.value.length }}</span>
          </template>
        </AppMenu>
      </div>
      <button
        v-if="files.canManage.value"
        type="button"
        class="btn btn-ghost file-tabs-btn"
        data-testid="file-add-btn"
        title="Add files to this document"
        aria-label="Add files"
        @click="pickFiles"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        <span v-if="!phone">Add file</span>
      </button>
      <input ref="inputRef" class="file-tabs-input" type="file" multiple tabindex="-1" aria-hidden="true" @change="onPicked" />
    </div>
    <ConfirmDialog
      v-if="files.confirmation.value"
      testid="file-confirm"
      :title="files.confirmation.value.title"
      :text="files.confirmation.value.text"
      :ok-label="files.confirmation.value.okLabel"
      @ok="files.confirmation.value?.answer(true)"
      @cancel="files.confirmation.value?.answer(false)"
    />
  </div>
</template>

<style scoped>
.file-tabs {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  min-width: 0;
  padding: 4px 16px 0;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
}

.file-tabs[data-breakpoint='phone'] {
  padding: 4px 8px 0;
  gap: 4px;
}

.file-tab-list {
  display: flex;
  align-items: flex-end;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}

.file-tab-item {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  max-width: 260px;
  border-bottom: 2px solid transparent;
}

.file-tab-item:has(.file-tab[aria-selected='true']) {
  border-bottom-color: var(--accent);
}

.file-tab {
  display: block;
  min-width: 0;
  padding: 7px 10px 6px;
  font-size: 13px;
  line-height: 18px;
  color: var(--text-secondary);
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-radius: 4px 4px 0 0;
}

.file-tab:hover {
  color: var(--text-primary);
}

.file-tab[aria-selected='true'] {
  color: var(--text-primary);
  font-weight: 600;
}

.file-tab:focus-visible,
.file-tab-remove:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.file-tab-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin: 0 4px 0 -4px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
}

.file-tab-remove:hover {
  color: var(--text-primary);
  background: var(--bg-code);
}

.file-uploads {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 1;
  min-width: 0;
  padding-bottom: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.file-upload-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-upload-spinner {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: file-spin 0.8s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .file-upload-spinner { animation: none; }
}

@keyframes file-spin {
  to { transform: rotate(360deg); }
}

.file-tabs-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding-bottom: 4px;
}

.file-tabs-actions :deep(.file-tabs-btn) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 18px;
}

.file-tabs[data-breakpoint='phone'] .file-tabs-actions :deep(.file-tabs-btn) {
  min-width: 36px;
  min-height: 36px;
  justify-content: center;
  padding: 4px 8px;
}

.file-tabs-count {
  font-variant-numeric: tabular-nums;
}

.file-tabs-input {
  display: none;
}
</style>

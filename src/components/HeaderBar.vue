<script setup lang="ts">
import { ref, nextTick } from 'vue'
import type { PaneMode, ThemeMode } from '@/types'
import { nextTheme, THEME_META } from '@/composables/useTheme'

const props = defineProps<{
  filename: string
  paneMode: PaneMode
  commentCount: number
  theme: ThemeMode
  wordCount: number
  charCount: number
  canRefresh: boolean
  sharing: boolean
  syncStatus: 'local' | 'synced' | 'error'
  hasUnsavedMarkdown: boolean
  pasteId: string | null
}>()

const emit = defineEmits<{
  'update:paneMode': [mode: PaneMode]
  'update:theme': [mode: ThemeMode]
  'update:filename': [name: string]
  'open-file': []
  'new-doc': []
  'refresh': []
  'generate-prompt': []
  'share': []
  'save-markdown': []
}>()

const editingFilename = ref(false)
const filenameInput = ref<HTMLInputElement>()

async function startEditFilename() {
  editingFilename.value = true
  await nextTick()
  filenameInput.value?.select()
}

function commitFilename() {
  const val = filenameInput.value?.value.trim()
  if (val && val !== props.filename) {
    emit('update:filename', val)
  }
  editingFilename.value = false
}

function onFilenameKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') commitFilename()
  if (e.key === 'Escape') editingFilename.value = false
}
</script>

<template>
  <header class="header">
    <div class="header-left">
      <h1 class="logo">mdreview<span class="logo-accent">.oss</span></h1>
      <input
        v-if="editingFilename"
        ref="filenameInput"
        class="filename-edit"
        :value="filename"
        @blur="commitFilename"
        @keydown="onFilenameKeydown"
      />
      <span v-else-if="filename" class="filename" title="Click to rename" @click="startEditFilename">{{ filename }}</span>
      <span v-if="pasteId" class="paste-id" :title="pasteId">id: {{ pasteId }}</span>
      <span v-if="filename" class="doc-stats">
        <span class="doc-stats-sep">·</span>
        <span class="doc-stats-num">{{ wordCount.toLocaleString() }}</span> words
        <span class="doc-stats-sep">·</span>
        <span class="doc-stats-num">{{ charCount.toLocaleString() }}</span> chars
      </span>
    </div>
    <div class="header-right">
      <template v-if="filename">
        <div class="toggle">
          <button
            class="toggle-btn"
            :class="{ active: paneMode === 'edit' }"
            @click="emit('update:paneMode', 'edit')"
          >
            Edit
          </button>
          <button
            class="toggle-btn"
            :class="{ active: paneMode === 'preview' }"
            @click="emit('update:paneMode', 'preview')"
          >
            Preview
          </button>
        </div>
        <span v-if="syncStatus !== 'local'" class="sync-indicator" :class="syncStatus" :title="syncStatus === 'synced' ? 'Synced with server' : 'Sync error'">
          <span class="sync-dot"></span>
          <span class="sync-label">{{ syncStatus === 'synced' ? 'Live' : 'Offline' }}</span>
        </span>
        <button
          v-if="syncStatus !== 'local' && hasUnsavedMarkdown && paneMode === 'edit'"
          class="btn btn-primary btn-save"
          @click="emit('save-markdown')"
        >
          Save
        </button>
        <button v-if="canRefresh" class="btn btn-ghost" title="Reload file from disk and reset comments" @click="emit('refresh')">Refresh</button>
        <button class="btn btn-ghost" @click="emit('new-doc')">New</button>
      </template>
      <button class="btn btn-ghost" @click="emit('open-file')">Open .md</button>
      <button class="btn btn-ghost" :disabled="!filename || sharing" @click="emit('share')">{{ sharing ? 'Sharing…' : 'Share' }}</button>
      <button class="btn btn-primary" :disabled="commentCount === 0 || !filename" @click="emit('generate-prompt')">Generate Prompt</button>
      <button
        class="btn-icon"
        :title="THEME_META[theme].title"
        @click="emit('update:theme', nextTheme(theme))"
      >
        <svg v-if="theme === 'light'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        <svg v-else-if="theme === 'dark'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
  height: 52px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.logo {
  font-family: var(--font-heading);
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.logo-accent {
  color: var(--accent);
}

.filename {
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  border-radius: 3px;
  padding: 2px 4px;
}

.filename:hover {
  background: var(--bg-page);
  color: var(--text-primary);
}

.filename-edit {
  font-size: 13px;
  font-family: var(--font-body);
  color: var(--text-primary);
  background: var(--bg-page);
  border: 1px solid var(--accent);
  border-radius: 3px;
  padding: 2px 4px;
  outline: none;
  width: 180px;
}

.paste-id {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-muted);
  opacity: 0.6;
  user-select: all;
}

.doc-stats {
  color: var(--text-muted);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.doc-stats-sep {
  color: var(--text-muted);
  opacity: 0.5;
}

.doc-stats-num {
  font-family: var(--font-mono);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toggle {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}

.toggle-btn {
  padding: 4px 14px;
  font-size: 13px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-body);
}

.toggle-btn.active {
  background: var(--text-primary);
  color: var(--bg-surface);
}

.toggle-btn + .toggle-btn {
  border-left: 1px solid var(--border);
}

.btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.btn-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  transition: opacity 0.15s;
}

.btn-icon:hover {
  opacity: 0.7;
}

.sync-indicator {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-muted);
  padding: 0 4px;
}

.sync-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #22c55e;
}

.sync-indicator.error .sync-dot {
  background: #ef4444;
}

.sync-label {
  font-weight: 500;
}

.btn-save {
  padding: 4px 14px;
  font-size: 13px;
}
</style>

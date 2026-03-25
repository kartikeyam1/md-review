<script setup lang="ts">
import type { PaneMode, ThemeMode } from '@/types'

defineProps<{
  filename: string
  paneMode: PaneMode
  commentCount: number
  theme: ThemeMode
  wordCount: number
  charCount: number
  canRefresh: boolean
  sharing: boolean
}>()

const emit = defineEmits<{
  'update:paneMode': [mode: PaneMode]
  'update:theme': [mode: ThemeMode]
  'open-file': []
  'new-doc': []
  'refresh': []
  'generate-prompt': []
  'share': []
}>()
</script>

<template>
  <header class="header">
    <div class="header-left">
      <h1 class="logo">mdreview<span class="logo-accent">.oss</span></h1>
      <span v-if="filename" class="filename">{{ filename }}</span>
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
        <button v-if="canRefresh" class="btn btn-ghost" title="Reload file from disk and reset comments" @click="emit('refresh')">Refresh</button>
        <button class="btn btn-ghost" @click="emit('new-doc')">New</button>
      </template>
      <button class="btn btn-ghost" @click="emit('open-file')">Open .md</button>
      <button class="btn btn-ghost" :disabled="!filename || sharing" @click="emit('share')">{{ sharing ? 'Sharing…' : 'Share' }}</button>
      <button class="btn btn-primary" :disabled="commentCount === 0 || !filename" @click="emit('generate-prompt')">Generate Prompt</button>
      <button
        class="btn-icon"
        :title="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
        @click="emit('update:theme', theme === 'dark' ? 'light' : 'dark')"
      >
        <svg v-if="theme === 'light'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
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
</style>

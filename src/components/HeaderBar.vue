<script setup lang="ts">
import type { PaneMode } from '@/types'

defineProps<{
  filename: string
  paneMode: PaneMode
  commentCount: number
}>()

const emit = defineEmits<{
  'update:paneMode': [mode: PaneMode]
  'open-file': []
  'generate-prompt': []
}>()
</script>

<template>
  <header class="header">
    <div class="header-left">
      <h1 class="logo">mdreview<span class="logo-accent">.oss</span></h1>
      <span v-if="filename" class="filename">{{ filename }}</span>
    </div>
    <div v-if="filename" class="header-right">
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
      <button class="btn btn-ghost" @click="emit('open-file')">Open .md</button>
      <button class="btn btn-primary" @click="emit('generate-prompt')">Generate Prompt</button>
    </div>
    <div v-else class="header-right">
      <button class="btn btn-ghost" @click="emit('open-file')">Open .md</button>
      <button class="btn btn-primary" disabled>Generate Prompt</button>
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
</style>

<script setup lang="ts">
import { computed } from 'vue'
import type { PaneMode } from '@/types'
import { useDocState } from '@/composables/useDocState'
import { useDocActions } from '@/composables/useDocLoader'
import FilenameField from '@/components/FilenameField.vue'
import ReviewerName from '@/components/ReviewerName.vue'
import DocStats from '@/components/DocStats.vue'
import ViewToggle from '@/components/ViewToggle.vue'
import SyncIndicator from '@/components/SyncIndicator.vue'
import SaveState from '@/components/SaveState.vue'
import HistoryButton from '@/components/HistoryButton.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'

// The doc header: one component per control (00 §4.3).
const doc = useDocState()
const actions = useDocActions()
const { readOnly, onScreen, comments, showPromptModal, route } = doc

const emit = defineEmits<{ 'update:paneMode': [mode: PaneMode] }>()

/** Only the route's own content names the header. */
const filename = computed(() => (onScreen.value ? doc.filename.value : ''))
const pasteId = computed(() => (onScreen.value ? doc.pasteId.value : null))
const canRefresh = computed(() => !!doc.filePathParam.value && onScreen.value && route.value.kind === 'landing')
const sharing = computed(() => doc.share.sharing.value)
</script>

<template>
  <header class="header">
    <div class="header-left">
      <h1 class="logo">mdreview<span class="logo-accent">.oss</span></h1>
      <FilenameField />
      <span v-if="pasteId" class="paste-id" :title="pasteId">id: {{ pasteId }}</span>
      <ReviewerName />
      <DocStats v-if="filename" />
    </div>
    <div class="header-right">
      <template v-if="filename && !readOnly">
        <ViewToggle @change="emit('update:paneMode', $event)" />
        <SyncIndicator />
        <SaveState />
        <HistoryButton v-if="pasteId" />
        <button v-if="canRefresh" class="btn btn-ghost" title="Reload file from disk and reset comments" @click="actions.loadFromFilePath()">Refresh</button>
        <button class="btn btn-ghost" @click="actions.handleNewDoc()">New</button>
      </template>
      <button class="btn btn-ghost" @click="actions.handleOpenFile()">Open file</button>
      <template v-if="!readOnly">
        <button class="btn btn-ghost" :disabled="!filename || sharing" @click="actions.handleShare()">{{ sharing ? 'Sharing…' : 'Share' }}</button>
        <button class="btn btn-primary" :disabled="comments.length === 0 || !filename" @click="showPromptModal = true">Generate Prompt</button>
      </template>
      <ThemeToggle />
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

.paste-id {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-muted);
  opacity: 0.6;
  user-select: all;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>

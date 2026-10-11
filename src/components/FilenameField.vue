<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { useDocState } from '@/composables/useDocState'

// The document's filename; click to rename (editors).
const { filename, onScreen, readOnly } = useDocState()

const editingFilename = ref(false)
const filenameInput = ref<HTMLInputElement>()

async function startEditFilename() {
  editingFilename.value = true
  await nextTick()
  filenameInput.value?.select()
}

function commitFilename() {
  const val = filenameInput.value?.value.trim()
  if (val && val !== filename.value) {
    filename.value = val
  }
  editingFilename.value = false
}

function onFilenameKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') commitFilename()
  if (e.key === 'Escape') editingFilename.value = false
}
</script>

<template>
  <input
    v-if="editingFilename"
    ref="filenameInput"
    class="filename-edit"
    :value="filename"
    @blur="commitFilename"
    @keydown="onFilenameKeydown"
  />
  <span v-else-if="onScreen && filename && readOnly" class="filename read-only">{{ filename }}</span>
  <span v-else-if="onScreen && filename" class="filename" title="Click to rename" @click="startEditFilename">{{ filename }}</span>
</template>

<style scoped>
.filename {
  color: var(--text-meta);
  font-size: 13px;
  cursor: pointer;
  border-radius: 3px;
  padding: 2px 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.filename.read-only {
  cursor: default;
}

.filename:not(.read-only):hover {
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
</style>

<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{
  'file-loaded': [content: string, filename: string]
}>()

const isDragging = ref(false)
const fileInput = ref<HTMLInputElement>()

function handleFiles(files: FileList | null) {
  if (!files || files.length === 0) return
  const file = files[0]
  const reader = new FileReader()
  reader.onload = () => {
    emit('file-loaded', reader.result as string, file.name)
  }
  reader.readAsText(file)
}

function onDrop(e: DragEvent) {
  isDragging.value = false
  handleFiles(e.dataTransfer?.files ?? null)
}

function onInputChange(e: Event) {
  const target = e.target as HTMLInputElement
  handleFiles(target.files)
}

function openPicker() {
  fileInput.value?.click()
}
</script>

<template>
  <div class="upload-screen">
    <div
      class="upload-area"
      :class="{ dragging: isDragging }"
      @dragover.prevent="isDragging = true"
      @dragleave="isDragging = false"
      @drop.prevent="onDrop"
      @click="openPicker"
    >
      <div class="upload-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="12" y1="18" x2="12" y2="12" />
          <polyline points="9 15 12 12 15 15" />
        </svg>
      </div>
      <h2 class="upload-title">
        Review your markdown, comment like Google Docs, and generate prompts for your favorite LLM.
      </h2>
      <p class="upload-subtitle">Drop your file here or click to browse</p>
      <p class="upload-hint">.md, .markdown, .txt</p>
      <input
        ref="fileInput"
        type="file"
        accept=".md,.markdown,.txt"
        class="file-input"
        @change="onInputChange"
      />
    </div>
  </div>
</template>

<style scoped>
.upload-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: calc(100vh - 52px);
  padding: 40px;
}

.upload-area {
  background: var(--bg-surface);
  border: 2px dashed var(--border);
  border-radius: 12px;
  padding: 60px 80px;
  text-align: center;
  cursor: pointer;
  max-width: 640px;
  transition: border-color 0.2s;
}

.upload-area.dragging,
.upload-area:hover {
  border-color: var(--text-muted);
}

.upload-icon {
  color: var(--text-muted);
  margin-bottom: 20px;
}

.upload-title {
  font-family: var(--font-heading);
  font-size: 20px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 12px;
  line-height: 1.4;
}

.upload-subtitle {
  color: var(--text-muted);
  font-size: 14px;
  margin-bottom: 12px;
}

.upload-hint {
  display: inline-block;
  background: var(--bg-page);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.file-input {
  display: none;
}
</style>

<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{
  'file-loaded': [content: string, filename: string]
}>()

const isDragging = ref(false)
const showPaste = ref(false)
const pasteContent = ref('')
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

function startBlank() {
  emit('file-loaded', '', 'untitled.md')
}

function submitPaste() {
  if (!pasteContent.value.trim()) return
  emit('file-loaded', pasteContent.value, 'pasted.md')
  pasteContent.value = ''
  showPaste.value = false
}
</script>

<template>
  <div class="upload-screen">
    <template v-if="!showPaste">
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
      <div class="alt-actions">
        <button class="btn btn-ghost" @click.stop="showPaste = true">Paste markdown</button>
        <span class="alt-divider">or</span>
        <button class="btn btn-ghost" @click.stop="startBlank">Start blank</button>
      </div>
    </template>

    <div v-else class="paste-area">
      <h2 class="upload-title">Paste your markdown</h2>
      <textarea
        v-model="pasteContent"
        class="paste-input"
        placeholder="Paste markdown content here..."
        rows="12"
        autofocus
      />
      <div class="paste-actions">
        <button class="btn btn-ghost" @click="showPaste = false">Back</button>
        <button class="btn btn-primary" @click="submitPaste">Start Review</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.upload-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: calc(100vh - 52px);
  padding: 40px;
  padding-top: calc(12vh);
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

.alt-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 20px;
}

.alt-divider {
  color: var(--text-muted);
  font-size: 13px;
}

.paste-area {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 32px 40px;
  max-width: 640px;
  width: 100%;
}

.paste-input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  font-size: 13px;
  font-family: var(--font-mono);
  background: var(--bg-page);
  color: var(--text-primary);
  resize: vertical;
  min-height: 200px;
  margin-top: 12px;
}

.paste-input:focus {
  outline: none;
  border-color: var(--text-muted);
}

.paste-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
</style>

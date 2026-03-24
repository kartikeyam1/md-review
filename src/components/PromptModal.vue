<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  visible: boolean
  prompt: string
}>()

const emit = defineEmits<{
  close: []
}>()

const copied = ref(false)

const copyFailed = ref(false)

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    copyFailed.value = true
    setTimeout(() => { copyFailed.value = false }, 3000)
  }
}
</script>

<template>
  <div v-if="visible" class="modal-overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-header">
        <h2 class="modal-title">Generated Prompt</h2>
        <button class="modal-close" @click="emit('close')">&times;</button>
      </div>
      <div class="modal-body">
        <pre class="prompt-text">{{ prompt }}</pre>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" @click="emit('close')">Back to Review</button>
        <button class="btn btn-primary" @click="copyToClipboard(prompt)">
          {{ copyFailed ? 'Copy failed' : copied ? 'Copied!' : 'Copy to Clipboard' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-bg, rgba(26, 22, 18, 0.5));
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.modal {
  background: var(--bg-surface);
  border-radius: 8px;
  width: 90%;
  max-width: 640px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px var(--shadow-color, rgba(26, 22, 18, 0.15));
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.modal-title {
  font-family: var(--font-heading);
  font-size: 18px;
  font-weight: 600;
}

.modal-close {
  background: none;
  border: none;
  font-size: 20px;
  color: var(--text-muted);
  padding: 4px 8px;
}

.modal-close:hover {
  color: var(--text-primary);
}

.modal-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.prompt-text {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  background: var(--bg-page);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
}
</style>

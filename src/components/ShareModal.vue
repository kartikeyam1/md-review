<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{
  visible: boolean
  filename: string
  urls: { ui: string; api: string; comments: string; markdown: string } | null
  commentCount: number
}>()

const emit = defineEmits<{
  close: []
}>()

const copied = ref<string | null>(null)

const sharePrompt = computed(() => {
  if (!props.urls) return ''
  const lines = [
    `Review the document "${props.filename}" and address the review comments.`,
    '',
    `Document + comments: ${props.urls.api}`,
    `Comments only:       ${props.urls.comments}`,
    `Markdown only:       ${props.urls.markdown}`,
    '',
    `Fetch the URLs above (JSON) to get the content. The document has ${props.commentCount} review comment${props.commentCount === 1 ? '' : 's'}.`,
  ]
  return lines.join('\n')
})

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = label
    setTimeout(() => { copied.value = null }, 2000)
  } catch {
    // ignore
  }
}
</script>

<template>
  <div v-if="visible" class="modal-overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-header">
        <h2 class="modal-title">Shared</h2>
        <button class="modal-close" @click="emit('close')">&times;</button>
      </div>
      <div class="modal-body">
        <div class="url-row">
          <label class="url-label">Share link</label>
          <div class="url-value">
            <code>{{ urls?.ui }}</code>
            <button class="btn-copy" @click="copyText(urls?.ui ?? '', 'ui')">{{ copied === 'ui' ? 'Copied!' : 'Copy' }}</button>
          </div>
        </div>

        <div class="divider"></div>

        <label class="url-label">Agent prompt</label>
        <pre class="prompt-text">{{ sharePrompt }}</pre>
        <div class="prompt-actions">
          <button class="btn btn-primary" @click="copyText(sharePrompt, 'prompt')">{{ copied === 'prompt' ? 'Copied!' : 'Copy Prompt' }}</button>
        </div>
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
  max-width: 580px;
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

.url-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.url-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.url-value {
  display: flex;
  align-items: center;
  gap: 8px;
}

.url-value code {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 13px;
  background: var(--bg-page);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.btn-copy {
  flex-shrink: 0;
  padding: 6px 12px;
  font-size: 12px;
  font-family: var(--font-body);
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
}

.btn-copy:hover {
  color: var(--text-primary);
  border-color: var(--text-muted);
}

.divider {
  height: 1px;
  background: var(--border);
  margin: 16px 0;
}

.prompt-text {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  background: var(--bg-page);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 14px;
  white-space: pre-wrap;
  word-wrap: break-word;
  margin-top: 6px;
}

.prompt-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
</style>

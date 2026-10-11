<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import type { Comment } from '@/types'
import { generatePrompt } from '@/composables/usePromptGenerator'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { copyText } from '@/composables/useCopyLink'
import { toast } from '@/composables/useToast'

const props = defineProps<{
  visible: boolean
  filename: string
  comments: Comment[]
  content: string
}>()

const emit = defineEmits<{
  close: []
}>()

const includeFullDocument = ref(true)
const copied = ref(false)
const copyFailed = ref(false)

const prompt = computed(() => {
  if (!props.visible) return ''
  return generatePrompt(props.filename, props.comments, props.content, {
    includeFullDocument: includeFullDocument.value,
  })
})

async function copyToClipboard(text: string) {
  if (await copyText(text)) {
    copied.value = true
    toast.info('Prompt copied')
    setTimeout(() => { copied.value = false }, 2000)
  } else {
    copyFailed.value = true
    setTimeout(() => { copyFailed.value = false }, 3000)
  }
}

// 00 §3.4: a modal dialog traps focus, Esc closes it, and focus goes back to the overflow menu that opened it.
const dialogRef = ref<HTMLElement | null>(null)
const open = computed(() => props.visible)
useFocusTrap(dialogRef, open, {
  initialFocus: () => dialogRef.value?.querySelector<HTMLElement>('[data-testid="prompt-copy-btn"]'),
  returnFocus: () => document.querySelector<HTMLElement>('[data-testid="header-overflow-btn"]'),
})
function onEscape(e: KeyboardEvent) { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); emit('close') } }
watch(open, (v) => {
  if (v) document.addEventListener('keydown', onEscape)
  else document.removeEventListener('keydown', onEscape)
}, { immediate: true })
onUnmounted(() => document.removeEventListener('keydown', onEscape))
</script>

<template>
  <div v-if="visible" class="modal-overlay" @click.self="emit('close')">
    <div ref="dialogRef" class="modal" role="dialog" aria-modal="true" aria-labelledby="prompt-dialog-title" data-testid="prompt-dialog">
      <div class="modal-header">
        <h2 id="prompt-dialog-title" class="modal-title">Generated Prompt <span class="modal-title-count" v-if="comments.length">({{ comments.length }} {{ comments.length === 1 ? 'comment' : 'comments' }})</span></h2>
        <button type="button" class="modal-close" aria-label="Close" @click="emit('close')">&times;</button>
      </div>
      <div class="modal-body">
        <pre class="prompt-text">{{ prompt }}</pre>
      </div>
      <div class="modal-footer">
        <label class="include-doc-toggle">
          <input type="checkbox" v-model="includeFullDocument" />
          <span>Include full document</span>
        </label>
        <div class="modal-footer-actions">
          <button class="btn btn-ghost" @click="emit('close')">Back to Review</button>
          <button type="button" class="btn btn-primary" data-testid="prompt-copy-btn" @click="copyToClipboard(prompt)">
            {{ copyFailed ? 'Copy failed' : copied ? 'Copied!' : 'Copy to Clipboard' }}
          </button>
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
  width: min(calc(100vw - 32px), 640px);
  max-height: 80vh;
  max-height: 80dvh;
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

.modal-title-count {
  font-size: 14px;
  font-weight: 400;
  color: var(--text-muted);
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
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
}

.modal-footer-actions {
  display: flex;
  gap: 8px;
}

.include-doc-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}

.include-doc-toggle input[type="checkbox"] {
  accent-color: var(--accent);
  cursor: pointer;
}
</style>

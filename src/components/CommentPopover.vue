<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  visible: boolean
  selectedText: string
  coords: { x: number; y: number }
}>()

const emit = defineEmits<{
  add: [body: string]
  cancel: []
}>()

const body = ref('')
const popoverRef = ref<HTMLElement>()

watch(
  () => props.visible,
  (v) => {
    if (v) {
      body.value = ''
      requestAnimationFrame(() => {
        popoverRef.value?.querySelector('textarea')?.focus()
      })
    }
  }
)

function submit() {
  const trimmed = body.value.trim()
  if (!trimmed) return
  emit('add', trimmed)
  body.value = ''
}
</script>

<template>
  <div
    v-if="visible"
    ref="popoverRef"
    class="popover"
    :style="{ left: coords.x + 'px', top: coords.y + 8 + 'px' }"
  >
    <div class="popover-quote">{{ selectedText }}</div>
    <textarea
      v-model="body"
      class="popover-input"
      placeholder="Add your comment..."
      rows="3"
      @keydown.enter.meta="submit"
      @keydown.enter.ctrl="submit"
    />
    <div class="popover-actions">
      <button class="btn btn-ghost btn-sm" @click="emit('cancel')">Cancel</button>
      <button class="btn btn-primary btn-sm" @click="submit">Add</button>
    </div>
  </div>
</template>

<style scoped>
.popover {
  position: fixed;
  z-index: 100;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  width: 300px;
  box-shadow: 0 2px 12px rgba(26, 22, 18, 0.1);
}

.popover-quote {
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.popover-input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px;
  font-size: 13px;
  font-family: var(--font-body);
  background: var(--bg-page);
  color: var(--text-primary);
  resize: vertical;
  min-height: 60px;
}

.popover-input:focus {
  outline: none;
  border-color: var(--text-muted);
}

.popover-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 8px;
}

.btn-sm {
  padding: 4px 12px;
  font-size: 12px;
}
</style>

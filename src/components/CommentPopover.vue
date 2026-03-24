<script setup lang="ts">
import { ref, reactive, watch, onBeforeUnmount } from 'vue'
import type { CommentCategory } from '@/types'
import { COMMENT_CATEGORIES, DEFAULT_CATEGORY } from '@/types'

const POPOVER_WIDTH = 320
const MARGIN = 8

const props = defineProps<{
  visible: boolean
  selectedText: string
  coords: { x: number; y: number }
}>()

const emit = defineEmits<{
  add: [body: string, category: CommentCategory]
  cancel: []
}>()

const body = ref('')
const category = ref<CommentCategory>(DEFAULT_CATEGORY)
const popoverRef = ref<HTMLElement>()
const adjustedPos = reactive({ x: 0, y: 0 })

function clampToViewport() {
  if (!popoverRef.value) return
  const rect = popoverRef.value.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight

  let x = props.coords.x
  let y = props.coords.y + MARGIN

  // Clamp horizontal: prefer showing to the right of cursor, pull left if overflow
  if (x + POPOVER_WIDTH > vw - MARGIN) {
    x = vw - POPOVER_WIDTH - MARGIN
  }
  if (x < MARGIN) x = MARGIN

  // Clamp vertical: if overflows bottom, show above the selection instead
  if (y + rect.height > vh - MARGIN) {
    y = props.coords.y - rect.height - MARGIN
  }
  if (y < MARGIN) y = MARGIN

  adjustedPos.x = x
  adjustedPos.y = y
}

function onDocumentMouseDown(e: MouseEvent) {
  if (!popoverRef.value) return
  if (popoverRef.value.contains(e.target as Node)) return
  if (!body.value.trim()) {
    emit('cancel')
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      body.value = ''
      category.value = DEFAULT_CATEGORY
      // Set initial position before render, then refine after
      adjustedPos.x = props.coords.x
      adjustedPos.y = props.coords.y + MARGIN
      requestAnimationFrame(() => {
        clampToViewport()
        // Don't auto-focus the textarea — it clears the native browser
        // selection highlight in preview mode, making the user think their
        // selected text was lost.
        document.addEventListener('mousedown', onDocumentMouseDown)
      })
    } else {
      document.removeEventListener('mousedown', onDocumentMouseDown)
    }
  }
)

// Re-clamp when coords change while visible (e.g. scrolling)
watch(
  () => props.coords,
  () => {
    if (props.visible) {
      adjustedPos.x = props.coords.x
      adjustedPos.y = props.coords.y + MARGIN
      requestAnimationFrame(clampToViewport)
    }
  }
)

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown)
})

function submit() {
  const trimmed = body.value.trim()
  if (!trimmed) return
  emit('add', trimmed, category.value)
  body.value = ''
}
</script>

<template>
  <div
    v-if="visible"
    ref="popoverRef"
    class="popover"
    :style="{ left: adjustedPos.x + 'px', top: adjustedPos.y + 'px' }"
  >
    <div class="popover-quote">{{ selectedText }}</div>
    <div class="category-row">
      <button
        v-for="cat in COMMENT_CATEGORIES"
        :key="cat.value"
        class="category-btn"
        :class="{ active: category === cat.value }"
        :style="category === cat.value ? { background: cat.color, color: '#fff', borderColor: cat.color } : {}"
        @click="category = cat.value"
      >
        {{ cat.label }}
      </button>
    </div>
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
  width: 320px;
  box-shadow: 0 2px 12px var(--shadow-color, rgba(26, 22, 18, 0.1));
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

.category-row {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}

.category-btn {
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  font-family: var(--font-body);
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.1s;
}

.category-btn:hover {
  border-color: var(--text-muted);
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

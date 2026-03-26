<script setup lang="ts">
import { reactive, watch, onBeforeUnmount } from 'vue'

const MARGIN = 6

const props = defineProps<{
  visible: boolean
  coords: { x: number; y: number }
}>()

const emit = defineEmits<{
  comment: []
  dismiss: []
}>()

const pos = reactive({ x: 0, y: 0 })

function clamp() {
  const vw = window.innerWidth
  let x = props.coords.x
  let y = props.coords.y - 36 // show above selection

  if (x + 90 > vw - MARGIN) x = vw - 90 - MARGIN
  if (x < MARGIN) x = MARGIN
  if (y < MARGIN) y = props.coords.y + MARGIN // flip below if no room above

  pos.x = x
  pos.y = y
}

function onDocMouseDown(e: MouseEvent) {
  const bar = document.querySelector('.selection-action-bar')
  if (bar?.contains(e.target as Node)) return
  emit('dismiss')
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      clamp()
      requestAnimationFrame(() => {
        document.addEventListener('mousedown', onDocMouseDown, true)
      })
    } else {
      document.removeEventListener('mousedown', onDocMouseDown, true)
    }
  }
)

watch(() => props.coords, () => {
  if (props.visible) clamp()
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown, true)
})
</script>

<template>
  <div
    v-if="visible"
    class="selection-action-bar"
    :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
  >
    <button class="action-btn" @click="emit('comment')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Comment
    </button>
  </div>
</template>

<style scoped>
.selection-action-bar {
  position: fixed;
  z-index: 99;
  display: flex;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px;
  box-shadow: 0 2px 8px var(--shadow-color, rgba(26, 22, 18, 0.12));
  animation: action-bar-in 0.1s ease-out;
}

@keyframes action-bar-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  font-family: var(--font-body);
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.1s, color 0.1s;
}

.action-btn:hover {
  background: var(--accent);
  color: #fff;
}

.action-btn svg {
  flex-shrink: 0;
}
</style>

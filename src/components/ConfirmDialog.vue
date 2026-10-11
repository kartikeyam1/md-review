<script setup lang="ts">
// In-app confirmation (#26): library bulk delete ("Delete N documents? This
// cannot be undone.") and collection delete (testids `library-confirm-*`), and
// the doc view's file remove / replace (`file-confirm-*`). A modal (00 §3.4
// layer 2): focus trapped and starting on Cancel (Enter never confirms a
// destructive action by accident), Esc or a backdrop click cancel.
import { ref, computed } from 'vue'
import { useFocusTrap } from '@/composables/useFocusTrap'

withDefaults(defineProps<{ title: string; text?: string; okLabel?: string; danger?: boolean; testid?: string; dialogTestid?: string }>(), {
  text: '', okLabel: 'Delete', danger: true, testid: 'library-confirm', dialogTestid: '', // #27: template-delete-confirm
})
const emit = defineEmits<{ ok: []; cancel: [] }>()

const dialog = ref<HTMLElement | null>(null)
const cancelBtn = ref<HTMLButtonElement | null>(null)
useFocusTrap(dialog, computed(() => true), { initialFocus: () => cancelBtn.value })

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  emit('cancel')
}
const titleId = `confirm-${Math.random().toString(36).slice(2, 8)}`
</script>

<template>
  <Teleport to="body">
    <div class="confirm-dlg-backdrop" @mousedown.self.prevent @click.self="emit('cancel')">
      <div
        ref="dialog"
        class="confirm-dlg"
        role="alertdialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :data-testid="dialogTestid || `${testid}-dialog`"
        @keydown="onKeydown"
      >
        <h2 :id="titleId" class="confirm-dlg-title">{{ title }}</h2>
        <p v-if="text" class="confirm-dlg-text">{{ text }}</p>
        <div class="confirm-dlg-actions">
          <button ref="cancelBtn" type="button" class="btn btn-ghost" :data-testid="`${testid}-cancel`" @click="emit('cancel')">Cancel</button>
          <button type="button" class="btn btn-primary" :class="{ danger }" :data-testid="`${testid}-ok`" @click="emit('ok')">{{ okLabel }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.confirm-dlg-backdrop {
  position: fixed;
  inset: 0;
  z-index: 400;
  background: var(--overlay-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.confirm-dlg {
  width: min(420px, 100%);
  padding: 18px;
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 32px var(--shadow-color);
  font-family: var(--font-body);
}
.confirm-dlg-title { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
.confirm-dlg-text { margin: 0 0 16px; font-size: 13px; line-height: 1.5; color: var(--text-secondary); }
.confirm-dlg-actions { display: flex; justify-content: flex-end; gap: 8px; }
.btn-primary.danger { background: var(--cat-must-fix); color: var(--cat-must-fix-on); }
</style>

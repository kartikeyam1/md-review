<script setup lang="ts">
// "Share first" prompt for pasting/dropping images into a never-shared doc
// (spec #10 rule 14). Images live in the shared doc's attachment store, so the
// doc must be shared before an image can be added. Confirm runs the normal
// share flow; Cancel, Esc or a backdrop click change nothing.
// TODO(#3): switch the inline focus trap to `useFocusTrap` once #3 lands it.
import { nextTick, onMounted, ref } from 'vue'

const emit = defineEmits<{ confirm: []; cancel: [] }>()

const dialog = ref<HTMLElement | null>(null)
const confirmBtn = ref<HTMLButtonElement | null>(null)

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    // One Esc closes exactly one layer (00 §3.4).
    e.preventDefault()
    e.stopPropagation()
    close('cancel')
    return
  }
  if (e.key !== 'Tab' || !dialog.value) return
  const els = [...dialog.value.querySelectorAll<HTMLElement>('button:not([disabled])')]
  if (!els.length) return
  const first = els[0]!
  const last = els[els.length - 1]!
  const active = document.activeElement
  if (e.shiftKey && (active === first || !dialog.value.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (active === last || !dialog.value.contains(active))) {
    e.preventDefault()
    first.focus()
  }
}

// Cancel puts focus back where it was (the editor); Confirm hands over to the share modal.
let returnTo: HTMLElement | null = null
onMounted(() => {
  returnTo = document.activeElement as HTMLElement | null
  nextTick(() => confirmBtn.value?.focus())
})

function close(kind: 'confirm' | 'cancel') {
  if (kind === 'confirm') return emit('confirm')
  const back = returnTo
  emit('cancel')
  nextTick(() => { if (back?.isConnected) back.focus() })
}
</script>

<template>
  <Teleport to="body">
    <div class="sr-backdrop" @mousedown.self.prevent @click.self="close('cancel')">
      <div
        ref="dialog"
        class="sr-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-required-title"
        aria-describedby="share-required-text"
        data-testid="share-required-dialog"
        @keydown="onKeydown"
      >
        <h2 id="share-required-title" class="sr-title">Share to add images</h2>
        <p id="share-required-text" class="sr-text">Images are stored with the shared document. Share it to add images.</p>
        <div class="sr-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-testid="share-required-cancel" @click="close('cancel')">Cancel</button>
          <button ref="confirmBtn" type="button" class="btn btn-primary btn-sm" data-testid="share-required-confirm" @click="close('confirm')">Share and insert</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sr-backdrop {
  position: fixed;
  inset: 0;
  z-index: 400;
  background: var(--overlay-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.sr-dialog {
  width: min(420px, 100%);
  padding: 16px;
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 32px var(--shadow-color);
  font-family: var(--font-body);
}

.sr-title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
}

.sr-text {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.sr-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>

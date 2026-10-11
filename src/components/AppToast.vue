<script setup lang="ts">
import { useToast, type ToastItem } from '@/composables/useToast'

// The toast stack (00 §3.1). Each toast carries its role (status | alert) as
// the contract says, but screen readers hear it through two live regions that
// are always in the DOM — a region inserted together with its text is often
// not announced. Hovering or focusing a toast pauses its auto-dismiss.
const { toasts, dismiss, pause, resume, latestPolite, latestAssertive } = useToast()

function runAction(t: ToastItem) {
  t.action?.onClick?.()
  dismiss(t.id)
}

/** A link action with an onClick too (an in-app page): a plain click runs it instead of a reload; modified clicks open the href. */
function onActionLink(e: MouseEvent, t: ToastItem) {
  if (t.action?.onClick && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
    e.preventDefault()
    runAction(t)
    return
  }
  dismiss(t.id)
}

function onFocusOut(e: FocusEvent, id: number) {
  const el = e.currentTarget as HTMLElement
  if (!el.contains(e.relatedTarget as Node | null)) resume(id)
}
</script>

<template>
  <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ latestPolite }}</div>
  <div class="sr-only" role="alert" aria-live="assertive" aria-atomic="true">{{ latestAssertive }}</div>
  <div class="app-toasts">
    <div
      v-for="t in toasts"
      :key="t.id"
      class="app-toast"
      :class="t.kind"
      data-testid="app-toast"
      :data-kind="t.kind"
      :data-toast="t.key"
      :role="t.kind === 'error' ? 'alert' : 'status'"
      aria-live="off"
      @mouseenter="pause(t.id)"
      @mouseleave="resume(t.id)"
      @focusin="pause(t.id)"
      @focusout="onFocusOut($event, t.id)"
    >
      <span class="app-toast-text">{{ t.text }}</span>
      <template v-if="t.action">
        <a v-if="t.action.href" class="app-toast-action" :href="t.action.href" @click="onActionLink($event, t as ToastItem)">{{ t.action.label }}</a>
        <button v-else type="button" class="app-toast-action" @click="runAction(t as ToastItem)">{{ t.action.label }}</button>
      </template>
      <button type="button" class="app-toast-close" data-testid="app-toast-close" aria-label="Dismiss" @click="dismiss(t.id)">×</button>
    </div>
  </div>
</template>

<style scoped>
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.app-toasts {
  position: fixed;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  z-index: 600;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: max-content;
  max-width: calc(100vw - 32px);
  pointer-events: none;
}

.app-toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  padding: 8px 8px 8px 14px;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  overflow-wrap: anywhere;
}

.app-toast.error {
  border-color: rgba(220, 38, 38, 0.45);
  background: color-mix(in srgb, var(--bg-surface) 92%, #dc2626);
}

.app-toast.success {
  border-color: rgba(22, 163, 74, 0.45);
}

.app-toast-action {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 2px 4px;
  text-decoration: none;
}

.app-toast-close {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.app-toast-close:hover {
  color: var(--text-primary);
  background: var(--bg-page);
}
</style>

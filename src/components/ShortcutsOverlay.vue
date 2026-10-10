<script setup lang="ts">
// Keyboard-shortcuts help (spec #9 rule 11b). A modal dialog listing every
// editor binding; rows are data (`SHORTCUT_ROWS`) so later items append theirs.
// Esc, the close button or a backdrop click closes it; focus returns to where it
// was (useShortcutsOverlay). Focus is trapped inside while open.
// TODO(#3): switch the inline trap to `useFocusTrap` once #3 lands it.
import { nextTick, onMounted, ref } from 'vue'
import { SHORTCUT_ROWS, formatCombo, isMacPlatform } from '@/editor/shortcutList'

const emit = defineEmits<{ close: [] }>()

const mac = isMacPlatform()
const rows = SHORTCUT_ROWS.map((r) => ({ ...r, combos: r.keys.map((k) => formatCombo(k, mac)) }))

const dialog = ref<HTMLElement | null>(null)
const closeBtn = ref<HTMLButtonElement | null>(null)

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

function focusables(): HTMLElement[] {
  return dialog.value ? [...dialog.value.querySelectorAll<HTMLElement>(FOCUSABLE)] : []
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    // One Esc closes exactly one layer (00 §3.4).
    e.preventDefault()
    e.stopPropagation()
    emit('close')
    return
  }
  if (e.key !== 'Tab') return
  const els = focusables()
  if (!els.length) { e.preventDefault(); return }
  const first = els[0]!
  const last = els[els.length - 1]!
  const active = document.activeElement
  if (e.shiftKey && (active === first || !dialog.value?.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (active === last || !dialog.value?.contains(active))) {
    e.preventDefault()
    first.focus()
  }
}

onMounted(() => nextTick(() => closeBtn.value?.focus()))
</script>

<template>
  <Teleport to="body">
    <div class="sc-backdrop" @mousedown.self.prevent @click.self="emit('close')">
      <div
        ref="dialog"
        class="sc-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-overlay-title"
        data-testid="shortcuts-overlay"
        @keydown="onKeydown"
      >
        <div class="sc-header">
          <h2 id="shortcuts-overlay-title" class="sc-title">Keyboard shortcuts</h2>
          <button
            ref="closeBtn"
            type="button"
            class="sc-close"
            aria-label="Close keyboard shortcuts"
            data-testid="shortcuts-close-btn"
            @click="emit('close')"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div class="sc-body" tabindex="0" role="region" aria-label="Shortcut list">
          <ul class="sc-list">
            <li v-for="row in rows" :key="row.label" class="sc-row" data-testid="shortcuts-row">
              <span class="sc-label">{{ row.label }}<span v-if="row.note" class="sc-note"> — {{ row.note }}</span></span>
              <span class="sc-keys">
                <template v-for="(combo, i) in row.combos" :key="combo">
                  <span v-if="i > 0" class="sc-or"> or </span><kbd>{{ combo }}</kbd>
                </template>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sc-backdrop {
  position: fixed;
  inset: 0;
  z-index: 400;
  background: var(--overlay-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.sc-dialog {
  width: min(520px, 100%);
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 32px var(--shadow-color);
}

.sc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.sc-title {
  margin: 0;
  font-family: var(--font-body);
  font-size: 15px;
  font-weight: 600;
}

.sc-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.sc-close:hover {
  background: var(--bg-page);
  color: var(--text-primary);
}

.sc-close:focus-visible,
.sc-body:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.sc-body {
  overflow-y: auto;
  padding: 4px 16px 12px;
}

.sc-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.sc-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}

.sc-row:last-child {
  border-bottom: none;
}

.sc-note {
  color: var(--text-secondary);
}

.sc-keys {
  flex: 0 0 auto;
  white-space: nowrap;
  color: var(--text-secondary);
}

kbd {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-code);
  color: var(--text-primary);
}
</style>

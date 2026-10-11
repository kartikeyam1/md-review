<script setup lang="ts">
import { computed } from 'vue'
import AppMenu, { type AppMenuEntry } from '@/components/AppMenu.vue'
import { isDark, themeFor, themeStyle, toggleDark, THEME_STYLES, THEME_STYLE_LABELS } from '@/composables/useTheme'
import { useDocState } from '@/composables/useDocState'

// The theme switcher (#1 rule 5): a light/dark toggle, then a "Style" menu
// (Default / GitHub / Locus). The toggle must stay the first `.btn-icon` in
// the document (00 §2.1); the Style trigger must not carry that class.
const { theme, setTheme } = useDocState()

const dark = computed(() => isDark(theme.value))
const style = computed(() => themeStyle(theme.value))
const toggleLabel = computed(() => (dark.value ? 'Switch to light mode' : 'Switch to dark mode'))

const entries = computed<AppMenuEntry[]>(() => THEME_STYLES.map((s) => ({
  type: 'radio',
  id: s,
  label: THEME_STYLE_LABELS[s],
  testid: 'theme-style-option',
  attrs: { 'data-style': s },
  checked: s === style.value,
  onSelect: () => setTheme(themeFor(s, dark.value)),
})))
</script>

<template>
  <div class="theme-switcher">
    <button
      type="button"
      class="btn-icon"
      data-testid="theme-toggle"
      :title="toggleLabel"
      :aria-label="toggleLabel"
      @click="setTheme(toggleDark(theme))"
    >
      <svg v-if="!dark" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
    </button>
    <AppMenu
      :entries="entries"
      :label="`Style: ${THEME_STYLE_LABELS[style]}`"
      menu-label="Theme style"
      trigger-testid="theme-style-menu"
      menu-testid="theme-style-menu-list"
      trigger-class="theme-style-trigger"
      :trigger-title="`Style: ${THEME_STYLE_LABELS[style]}`"
    >
      <template #trigger>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22a10 10 0 1 1 10-10c0 2.2-1.8 3.5-4 3.5h-2.2a1.8 1.8 0 0 0-1.3 3.1A1.8 1.8 0 0 1 12 22z"/><circle cx="7.5" cy="10.5" r="1.2" fill="currentColor"/><circle cx="10.5" cy="6.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="7" r="1.2" fill="currentColor"/></svg>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </template>
    </AppMenu>
  </div>
</template>

<style scoped>
.theme-switcher {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.btn-icon,
.theme-switcher :deep(.theme-style-trigger) {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  transition: opacity 0.15s;
}

.btn-icon {
  width: 32px;
}

.theme-switcher :deep(.theme-style-trigger) {
  gap: 3px;
  padding: 0 7px;
}

.btn-icon:hover,
.theme-switcher :deep(.theme-style-trigger:hover) {
  opacity: 0.7;
}

.btn-icon:focus-visible,
.theme-switcher :deep(.theme-style-trigger:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* Three items never scroll, so the list need not clip; the square hit area
   keeps the rounded corners inside the menu for pointer and hit tests. */
.theme-switcher :deep([data-testid='theme-style-menu-list']) {
  overflow: visible;
}

.theme-switcher :deep([data-testid='theme-style-menu-list'])::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
}
</style>

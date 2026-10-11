<script setup lang="ts">
import { computed } from 'vue'
import AppMenu, { type AppMenuEntry } from '@/components/AppMenu.vue'
import { useDocState } from '@/composables/useDocState'
import { useDocActions } from '@/composables/useDocLoader'
import { downloadEntries } from '@/components/headerMenuExtras'
import { downloadBusy } from '@/composables/downloadActions'

// #19: the Download menu in the desktop header bar (00 §2.2: before the theme
// toggle, so never `.btn-icon` — 00 §2.1). Below 1100px the same items are the
// overflow menu's "Download" group. Lazy-loaded by DocHeader (#6 entry budget).
const doc = useDocState()
const actions = useDocActions()
const entries = computed<AppMenuEntry[]>(() => downloadEntries({ doc, setView: actions.setView }))
const busy = computed(() => downloadBusy.value)
</script>

<template>
  <AppMenu
    :entries="entries"
    label="Download"
    trigger-title="Download"
    trigger-testid="download-menu-btn"
    menu-testid="download-menu"
    :trigger-class="busy ? 'btn btn-ghost download-btn is-busy' : 'btn btn-ghost download-btn'"
    :trigger-attrs="{ 'aria-busy': busy ? 'true' : undefined }"
  >
    <template #trigger>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/></svg>
    </template>
  </AppMenu>
</template>

<style scoped>
:deep(.download-btn) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
}

:deep(.download-btn.is-busy) {
  cursor: progress;
  opacity: 0.6;
}
</style>

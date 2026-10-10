<script setup lang="ts">
import { ref } from 'vue'
import { useMenu } from '@/composables/useMenu'

// A menu button (00 §3.2): the trigger is the `trigger` slot's content, the
// items are declared as data so every menu shares one keyboard model.

export type AppMenuEntry =
  | { type: 'item'; id: string; label: string; testid?: string; title?: string; disabled?: boolean; onSelect: () => void }
  | { type: 'radio'; id: string; label: string; testid?: string; checked: boolean; disabled?: boolean; onSelect: () => void }
  | { type: 'group'; id: string; label: string; testid?: string; entries: AppMenuEntry[]; note?: { text: string; testid?: string } | null }
  | { type: 'separator'; id: string }

withDefaults(defineProps<{
  entries: AppMenuEntry[]
  /** Accessible name of the trigger. */
  label: string
  triggerTestid?: string
  menuTestid?: string
  triggerClass?: string
  triggerTitle?: string
}>(), {
  triggerTestid: undefined,
  menuTestid: undefined,
  triggerClass: 'btn btn-ghost',
  triggerTitle: undefined,
})

const triggerRef = ref<HTMLButtonElement>()
const listRef = ref<HTMLElement>()
const menu = useMenu(triggerRef, listRef)

function select(entry: AppMenuEntry) {
  if (entry.type !== 'item' && entry.type !== 'radio') return
  if (entry.disabled) return
  menu.close({ focusTrigger: true })
  entry.onSelect()
}

defineExpose({ open: menu.open, close: menu.close, show: menu.show })
</script>

<template>
  <div class="app-menu">
    <button
      ref="triggerRef"
      type="button"
      :class="triggerClass"
      :title="triggerTitle"
      :aria-label="label"
      aria-haspopup="menu"
      :aria-expanded="menu.open.value ? 'true' : 'false'"
      :data-testid="triggerTestid"
      @click="menu.toggle()"
      @keydown="menu.onTriggerKeydown"
    >
      <slot name="trigger" />
    </button>
    <div
      v-if="menu.open.value"
      ref="listRef"
      class="app-menu-list"
      role="menu"
      :aria-label="label"
      :data-testid="menuTestid"
      @keydown="menu.onListKeydown"
    >
      <template v-for="entry in entries" :key="entry.id">
        <div v-if="entry.type === 'separator'" class="app-menu-sep" role="separator"></div>
        <div v-else-if="entry.type === 'group'" class="app-menu-group" role="group" :aria-label="entry.label" :data-testid="entry.testid">
          <div class="app-menu-group-label" aria-hidden="true">{{ entry.label }}</div>
          <template v-for="sub in entry.entries" :key="sub.id">
            <button
              v-if="sub.type === 'radio'"
              type="button"
              class="app-menu-item"
              role="menuitemradio"
              tabindex="-1"
              :aria-checked="sub.checked ? 'true' : 'false'"
              :aria-disabled="sub.disabled ? 'true' : undefined"
              :data-testid="sub.testid"
              @click="select(sub)"
            >
              <span class="app-menu-check" aria-hidden="true">{{ sub.checked ? '●' : '' }}</span>{{ sub.label }}
            </button>
            <button
              v-else-if="sub.type === 'item'"
              type="button"
              class="app-menu-item"
              role="menuitem"
              tabindex="-1"
              :title="sub.title"
              :aria-disabled="sub.disabled ? 'true' : undefined"
              :data-testid="sub.testid"
              @click="select(sub)"
            >{{ sub.label }}</button>
          </template>
          <div v-if="entry.note" class="app-menu-note" role="none" :data-testid="entry.note.testid">{{ entry.note.text }}</div>
        </div>
        <button
          v-else-if="entry.type === 'radio'"
          type="button"
          class="app-menu-item"
          role="menuitemradio"
          tabindex="-1"
          :aria-checked="entry.checked ? 'true' : 'false'"
          :aria-disabled="entry.disabled ? 'true' : undefined"
          :data-testid="entry.testid"
          @click="select(entry)"
        >
          <span class="app-menu-check" aria-hidden="true">{{ entry.checked ? '●' : '' }}</span>{{ entry.label }}
        </button>
        <button
          v-else
          type="button"
          class="app-menu-item"
          role="menuitem"
          tabindex="-1"
          :title="entry.title"
          :aria-disabled="entry.disabled ? 'true' : undefined"
          :data-testid="entry.testid"
          @click="select(entry)"
        >{{ entry.label }}</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.app-menu {
  position: relative;
  display: inline-flex;
}

.app-menu-list {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 200;
  min-width: 220px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 72px);
  overflow-y: auto;
  padding: 4px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
  display: flex;
  flex-direction: column;
}

.app-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 13px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}

.app-menu-item:hover,
.app-menu-item:focus-visible {
  background: var(--bg-page);
  outline: none;
}

.app-menu-item:focus-visible {
  box-shadow: inset 0 0 0 2px var(--accent);
}

.app-menu-item[aria-disabled='true'] {
  opacity: 0.45;
  cursor: default;
}

.app-menu-check {
  display: inline-block;
  width: 12px;
  font-size: 9px;
  color: var(--accent);
}

.app-menu-group {
  display: flex;
  flex-direction: column;
  padding-top: 4px;
  margin-top: 4px;
  border-top: 1px solid var(--border);
}

.app-menu-group-label {
  padding: 4px 10px 2px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.app-menu-note {
  padding: 4px 10px 6px 28px;
  font-size: 12px;
  color: var(--text-muted);
  white-space: normal;
}

.app-menu-sep {
  height: 1px;
  margin: 4px 0;
  background: var(--border);
}
</style>

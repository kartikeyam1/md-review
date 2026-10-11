<script setup lang="ts">
import { computed, onUnmounted } from 'vue'
import { REACTIONS } from '@shared/reactions.mjs'
import { groupsOf } from '@/composables/useReactions'
import { useDocState } from '@/composables/useDocState'

// #24 rule 6: doc-level reactions at the end of the rendered document (read
// view, publish and review modes, markdown and HTML docs; never in ?embed=1).
// One button per emoji in the fixed order, count when > 0, pressed when mine;
// hover / focus / long-press shows who reacted (ReactionOverlays draws it).
const { reactions } = useDocState()
const groups = computed(() => new Map(groupsOf(reactions.summary.value, null).map((g) => [g.code, g])))

const LONG_PRESS_MS = 500
let pressTimer: ReturnType<typeof setTimeout> | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null
let suppressClick = false
onUnmounted(() => { touchEnd(); if (hideTimer) clearTimeout(hideTimer) })

// Mouse events a touch synthesises must not re-open the tooltip a long-press closed.
let lastTouchAt = 0
function show(code: string, e: Event) {
  if (e.type === 'mouseenter' && Date.now() - lastTouchAt < 1000) return
  reactions.showWho(groups.value.get(code), e.currentTarget as HTMLElement)
}
function click(code: string, e: MouseEvent) {
  if (suppressClick) { suppressClick = false; return }
  reactions.toggle(code, null)
  const el = e.currentTarget as HTMLElement
  requestAnimationFrame(() => { if (el.isConnected && el.matches(':hover, :focus')) reactions.showWho(groups.value.get(code), el) })
}
function touchStart(code: string, e: TouchEvent) {
  const el = e.currentTarget as HTMLElement
  suppressClick = false // a long-press whose click never came must not swallow this tap
  lastTouchAt = Date.now()
  touchEnd()
  pressTimer = setTimeout(() => {
    pressTimer = null
    suppressClick = true
    reactions.showWho(groups.value.get(code), el)
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => reactions.hideWho(), 2000)
  }, LONG_PRESS_MS)
}
function touchEnd() { lastTouchAt = Date.now(); if (pressTimer) { clearTimeout(pressTimer); pressTimer = null } }
</script>

<template>
  <div class="reaction-bar" data-testid="reaction-bar" role="group" aria-label="Reactions to this document">
    <button
      v-for="r in REACTIONS"
      :key="r.code"
      type="button"
      class="reaction-btn"
      data-testid="reaction-btn"
      :data-code="r.code"
      :aria-pressed="groups.get(r.code)?.mine ? 'true' : 'false'"
      :aria-label="`${r.label} ${r.emoji}${groups.get(r.code) ? `: ${groups.get(r.code)!.count}` : ''}`"
      @click="click(r.code, $event)"
      @mouseenter="show(r.code, $event)"
      @mouseleave="reactions.hideWho()"
      @focus="show(r.code, $event)"
      @blur="reactions.hideWho()"
      @touchstart.passive="touchStart(r.code, $event)"
      @touchend="touchEnd"
      @touchmove.passive="touchEnd"
      @contextmenu.prevent
    >
      <span class="reaction-emoji" aria-hidden="true">{{ r.emoji }}</span>
      <span v-if="groups.get(r.code)" class="reaction-count" data-testid="reaction-count">{{ groups.get(r.code)!.count }}</span>
    </button>
  </div>
</template>

<style scoped>
/* Lined up with the reading column (.preview-pane: 50em + its side padding, #18 Wide lifts the cap),
   like the agent-sections notice above the doc; its rule spans the column, not the window. */
.reaction-bar {
  --read-pad: 32px;
  flex: none;
  box-sizing: border-box;
  width: calc(100% - 2 * var(--read-pad));
  max-width: 50em;
  margin: 0 auto;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
  background: var(--bg-surface);
  /* The preview's base size, so 50em matches its column. */
  font-size: calc(15px * var(--reader-scale, 1));
  user-select: none;
  -webkit-user-select: none;
}

html[data-reader-width='wide'] .reaction-bar {
  max-width: none;
}

@media (max-width: 1099.98px) {
  .reaction-bar { --read-pad: 24px; }
}

.reaction-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  min-width: 40px;
  padding: 2px 10px;
  border-radius: 999px;
  /* ≥ 3:1 against the bar in every theme (AC-24.13; --text-muted is not, in dark). */
  border: 1px solid var(--text-secondary);
  background: var(--bg-surface);
  color: var(--text-primary);
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
}

.reaction-btn:hover { background: var(--bg-page); }

.reaction-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.reaction-btn[aria-pressed='true'] {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--bg-surface));
}

.reaction-emoji { font-size: 16px; }
.reaction-count { font-variant-numeric: tabular-nums; font-weight: 500; }

@media (max-width: 640.98px) {
  .reaction-bar { --read-pad: 16px; padding: 8px 0; }
}

/* Touch: 44px targets. */
@media (pointer: coarse) {
  .reaction-btn { min-height: 44px; min-width: 44px; }
}
</style>

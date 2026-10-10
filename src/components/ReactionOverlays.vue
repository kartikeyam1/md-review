<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { REACTIONS } from '@shared/reactions.mjs'
import { useDocState } from '@/composables/useDocState'

// #24: the section `reaction-picker` (rule 7; an Esc layer-3 panel, 00 §3.4)
// and the `reaction-who` tooltip (rule 8), both driven by the reactions store
// and drawn fixed over the page next to the element that asked for them.
const { reactions } = useDocState()
const { picker, who } = reactions

const pickerRef = ref<HTMLElement | null>(null)
const pos = ref({ top: 0, left: 0 })
const PICKER_W = 6 * 44 + 16

function place() {
  const p = picker.value
  if (!p) return
  const trigger = p.trigger.isConnected ? p.trigger
    : document.querySelector<HTMLElement>(`.section-reaction-trigger[data-section="${CSS.escape(p.section)}"]`)
  if (!trigger) { reactions.closePicker({ restoreFocus: false }); return }
  if (trigger !== p.trigger) picker.value = { ...p, trigger }
  const r = trigger.getBoundingClientRect()
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  const width = Math.min(PICKER_W, vw - 16)
  const top = r.bottom + 6 + 56 > vh ? Math.max(8, r.top - 6 - 56) : r.bottom + 6
  pos.value = { top, left: Math.max(8, Math.min(r.left - 8, vw - width - 8)) }
}

let raf = 0
const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place) }

function onPointerDown(e: PointerEvent) {
  const t = e.target as Node | null
  const p = picker.value
  if (!p || !t) return
  if (pickerRef.value?.contains(t) || p.trigger.contains(t)) return
  reactions.closePicker({ restoreFocus: false })
}

watch(picker, async (p, prev) => {
  if (p && !prev) {
    place()
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onDocKeydown)
    await nextTick()
    pickerRef.value?.querySelector<HTMLElement>('[data-testid="reaction-picker-option"]')?.focus()
  } else if (!p && prev) {
    window.removeEventListener('scroll', schedule, true)
    window.removeEventListener('resize', schedule)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onDocKeydown)
  }
})

onUnmounted(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('scroll', schedule, true)
  window.removeEventListener('resize', schedule)
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('keydown', onDocKeydown)
})

/** Esc while focus is elsewhere on the page (e.g. it came back from another window): still this layer's. */
function onDocKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || !picker.value) return
  e.preventDefault()
  reactions.closePicker()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    // One Esc closes exactly this layer (00 §3.4).
    e.preventDefault()
    e.stopPropagation()
    reactions.closePicker()
    return
  }
  if (e.key === 'Tab') {
    // The picker belongs right after its trigger in the reading order: tabbing out of it closes it
    // and returns to the trigger, so the next Tab continues from there in the document.
    const opts = Array.from(pickerRef.value?.querySelectorAll<HTMLElement>('[data-testid="reaction-picker-option"]') ?? [])
    const i = opts.indexOf(document.activeElement as HTMLElement)
    if ((!e.shiftKey && i === opts.length - 1) || (e.shiftKey && i === 0)) {
      e.preventDefault()
      reactions.closePicker()
    }
    return
  }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
    const opts = Array.from(pickerRef.value?.querySelectorAll<HTMLElement>('[data-testid="reaction-picker-option"]') ?? [])
    const i = opts.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? opts.length - 1
      : (i + (e.key === 'ArrowRight' ? 1 : -1) + opts.length) % opts.length
    opts[next]?.focus()
    e.preventDefault()
  }
}

function onFocusOut(e: FocusEvent) {
  const to = e.relatedTarget as Node | null
  const p = picker.value
  if (!p) return
  if (to && (pickerRef.value?.contains(to) || p.trigger.contains(to))) return
  if (!to) {
    // Focus went nowhere focusable (Tab past the last option onto the page) or left the window:
    // close only in the first case — a window switch keeps the picker for when the reader comes back.
    setTimeout(() => {
      const a = document.activeElement
      if (picker.value === p && document.hasFocus() && !(a && (pickerRef.value?.contains(a) || p.trigger.contains(a)))) {
        reactions.closePicker({ restoreFocus: false })
      }
    }, 0)
    return
  }
  reactions.closePicker({ restoreFocus: false })
}

function pick(code: string) {
  const p = picker.value
  if (p) reactions.toggle(code, p.section)
}

const whoStyle = computed(() => {
  const w = who.value
  if (!w) return {}
  const vw = document.documentElement.clientWidth
  const left = Math.max(8, Math.min((w.rect.left + w.rect.right) / 2, vw - 8))
  const above = w.rect.top > 48
  return above
    ? { left: `${left}px`, top: `${w.rect.top - 6}px`, transform: 'translate(-50%, -100%)' }
    : { left: `${left}px`, top: `${w.rect.bottom + 6}px`, transform: 'translateX(-50%)' }
})
</script>

<template>
  <div
    v-if="picker"
    ref="pickerRef"
    class="reaction-picker"
    data-testid="reaction-picker"
    role="dialog"
    :aria-label="`React to section ${picker.label}`"
    :style="{ top: `${pos.top}px`, left: `${pos.left}px` }"
    @keydown="onKeydown"
    @focusout="onFocusOut"
  >
    <button
      v-for="r in REACTIONS"
      :key="r.code"
      type="button"
      class="reaction-picker-option"
      data-testid="reaction-picker-option"
      :data-code="r.code"
      :aria-label="r.label"
      :title="r.label"
      :aria-pressed="reactions.isMine(r.code, picker.section) ? 'true' : 'false'"
      @click="pick(r.code)"
    >{{ r.emoji }}</button>
  </div>
  <div v-if="who" class="reaction-who" data-testid="reaction-who" role="tooltip" :style="whoStyle">{{ who.text }}</div>
</template>

<style scoped>
.reaction-picker {
  position: fixed;
  z-index: 200; /* panels (00 §3.7) */
  display: flex;
  gap: 4px;
  padding: 6px;
  max-width: calc(100vw - 16px);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
  user-select: none;
  -webkit-user-select: none;
}

.reaction-picker-option {
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
}

.reaction-picker-option:hover { background: var(--bg-page); }
.reaction-picker-option:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.reaction-picker-option[aria-pressed='true'] {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--bg-surface));
}

.reaction-who {
  position: fixed;
  z-index: 210;
  max-width: min(320px, calc(100vw - 16px));
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--text-primary);
  color: var(--bg-surface);
  font-size: 12px;
  line-height: 1.4;
  pointer-events: none;
  white-space: normal;
}
</style>

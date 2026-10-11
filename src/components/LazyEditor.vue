<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { editorComponent, loadEditor, looksLikeStaleDeploy } from '@/composables/useEditorLoader'

// #6: the editor slot. Loads the EditorPane chunk on mount (the parent mounts
// this only once someone switches to edit), shows a placeholder while it
// loads and a retry on failure, then renders EditorPane with every attr and
// listener passed straight through (v-model, comments, selection events…).
// The parent keeps this mounted (v-show) after first use, so the editor
// instance survives read ↔ edit switches (rule 5).

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  /** Is the slot on screen? Focus moves into the editor when it mounts while active (rule 3). */
  active?: boolean
}>()

type EditorHandle = {
  scrollToLine?: (line: number) => void
  focus?: () => void
  scrollElement?: () => HTMLElement | null
  topLine?: () => number | null
  scrollTopForLine?: (line: number) => number | null
}

const inner = ref<EditorHandle | null>(null)
const failed = ref(false)
const stale = ref(false)
const loading = ref(!editorComponent.value)

async function load() {
  failed.value = false
  stale.value = false
  loading.value = true
  try {
    await loadEditor()
    loading.value = false
  } catch (err) {
    loading.value = false
    failed.value = true
    // The diagnosis needs a round trip; the error shows meanwhile.
    stale.value = await looksLikeStaleDeploy(err)
  }
}

function reload() {
  window.location.reload()
}

onMounted(() => { if (!editorComponent.value) load() })

// First mount of the editor itself: move focus in, so typing goes there.
watch(inner, (now, before) => {
  if (now && !before && props.active) now.focus?.()
})

/** Calls made before the editor mounts are no-ops (rule 6). */
function scrollToLine(line: number) {
  inner.value?.scrollToLine?.(line)
}

function focus() {
  inner.value?.focus?.()
}

// Split view's scroll sync (#7); null until the editor has mounted.
const scrollElement = () => inner.value?.scrollElement?.() ?? null
const topLine = () => inner.value?.topLine?.() ?? null
const scrollTopForLine = (line: number) => inner.value?.scrollTopForLine?.(line) ?? null

defineExpose({ scrollToLine, focus, scrollElement, topLine, scrollTopForLine })
</script>

<template>
  <div class="lazy-editor">
    <component :is="editorComponent" v-if="editorComponent" ref="inner" v-bind="$attrs" />
    <div v-else-if="failed && !loading" class="editor-state editor-error" role="alert" data-testid="editor-load-error">
      <p class="editor-state-title">Couldn't load the editor</p>
      <p v-if="stale" class="editor-state-hint">Reload the page to get the latest version</p>
      <div class="editor-state-actions">
        <button type="button" class="btn btn-primary btn-sm" data-testid="editor-load-retry" @click="load">Retry</button>
        <button v-if="stale" type="button" class="btn btn-ghost btn-sm" data-testid="editor-load-reload" @click="reload">Reload page</button>
      </div>
    </div>
    <div v-else class="editor-state editor-loading" role="status" aria-busy="true" data-testid="editor-loading">
      <div class="skeleton-gutter" aria-hidden="true"></div>
      <div class="skeleton-body">
        <span class="skeleton-label">Loading editor…</span>
        <span v-for="n in 8" :key="n" class="skeleton-line" :style="{ width: `${40 + ((n * 37) % 50)}%` }" aria-hidden="true"></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lazy-editor {
  height: 100%;
  overflow: hidden;
}

.editor-state {
  height: 100%;
  background: var(--bg-surface);
}

.editor-loading {
  display: flex;
}

.skeleton-gutter {
  width: 44px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--bg-page);
}

.skeleton-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px;
}

.skeleton-label {
  font-size: 13px;
  color: var(--text-meta);
  font-family: var(--font-body);
}

.skeleton-line {
  display: block;
  height: 10px;
  border-radius: 3px;
  background: var(--border);
  opacity: 0.6;
}

.editor-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  font-family: var(--font-body);
}

.editor-state-title {
  margin: 0;
  font-size: 15px;
  color: var(--text-primary);
}

.editor-state-hint {
  margin: 0;
  font-size: 13px;
  color: var(--text-meta);
}

.editor-state-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
</style>

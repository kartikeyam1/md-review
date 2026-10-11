<script setup lang="ts">
// Not-found states for path routes (spec #4): an unknown route, a doc that
// answered 404/410 (never the upload screen), or a pinned revision whose
// content is no longer stored.
// Persona-QA M2: when this browser held unsaved edits for a doc that is gone,
// they are offered here as a download (the doc itself is never rendered).
import type { LocalCopy } from '@/composables/localCopy'

const props = defineProps<{
  kind: 'route' | 'doc' | 'revision-gone'
  /** The landing URL (app base). */
  home: string
  /** Unsaved edits kept for the missing doc (kind 'doc' only). */
  copy?: LocalCopy | null
}>()

const emit = defineEmits<{ home: []; discard: [] }>()

function download() {
  const c = props.copy
  if (!c) return
  const base = (c.filename || 'document.md').replace(/\.(md|markdown|txt|html?)$/i, '')
  const url = URL.createObjectURL(new Blob([c.markdown], { type: 'text/markdown;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${base} (my changes).md`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function discard() {
  if (!window.confirm('Discard your unsaved changes? The document no longer exists on the server.')) return
  emit('discard')
}

function onHome(e: MouseEvent) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  emit('home')
}

const TEXT = {
  route: { title: 'Page not found', body: 'There is nothing at this address.' },
  doc: { title: 'Document not found', body: "This document doesn't exist or has expired." },
  'revision-gone': { title: 'Version not available', body: 'This version of the document is no longer stored.' },
} as const
</script>

<template>
  <div class="route-not-found" :data-testid="props.kind === 'route' ? 'not-found' : 'doc-not-found'" role="status">
    <h2>{{ TEXT[props.kind].title }}</h2>
    <p>{{ TEXT[props.kind].body }}</p>
    <div v-if="props.kind === 'doc' && props.copy" class="nf-copy" data-testid="doc-not-found-copy">
      <p>This browser still has your unsaved changes to it.</p>
      <div class="nf-copy-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-testid="doc-not-found-download" @click="download">Download my changes</button>
        <button type="button" class="btn btn-ghost btn-sm" data-testid="doc-not-found-discard" @click="discard">Discard</button>
      </div>
    </div>
    <a class="btn btn-primary" :href="props.home" @click="onHome">Go to md-review home</a>
  </div>
</template>

<style scoped>
.route-not-found {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px 16px;
  text-align: center;
  color: var(--text-secondary);
}

.route-not-found h2 {
  font-family: var(--font-heading);
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary);
}

.route-not-found a {
  text-decoration: none;
}

.nf-copy {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--comment-bg);
  max-width: 100%;
}

.nf-copy-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
</style>

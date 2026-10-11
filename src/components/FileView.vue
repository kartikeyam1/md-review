<script setup lang="ts">
import { computed } from 'vue'
import { useDocState } from '@/composables/useDocState'
import { useSessionFiles } from '@/composables/useSessionFiles'
import { codeFence, formatFileSize } from '@/composables/sessionFiles'
import PreviewPane from '@/components/PreviewPane.vue'

// #26 rules 22–23: one session file on its route, read-only. Markdown uses the
// doc's renderer, HTML the sandboxed preview, text/code a highlighted code
// block, images an <img> fitted to the width, anything else a download card.
// An unknown name is a file-not-found state with a link back to the doc.
const doc = useDocState()
const files = useSessionFiles()
const c = computed(() => files.content.value)
const baseName = (p: string) => p.split('/').pop() || p

/** Markdown source for PreviewPane (markdown files as-is, code as one fenced block). */
const source = computed(() => {
  const v = c.value
  if (!v || v.status !== 'ready') return ''
  if (v.kind === 'markdown' || v.kind === 'html') return v.text
  if (v.kind === 'code') return codeFence(v.text, v.lang)
  return ''
})

function backToDoc(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  doc.router.push(files.docPath())
}

function retry() {
  const v = c.value
  if (v) files.openFile(v.id, v.path)
}
</script>

<template>
  <div v-if="!c || c.status === 'loading'" class="file-view file-loading" aria-busy="true"></div>
  <div v-else-if="c.status === 'not-found'" class="file-view" data-testid="file-not-found">
    <div class="file-card" role="status">
      <h2 class="file-card-title">File not found</h2>
      <p class="file-card-text">“{{ c.path }}” is not part of this document. It may have been removed or renamed.</p>
      <a class="btn btn-primary" :href="files.docPath()" :title="doc.docTitle.value" @click="backToDoc">Back to the document</a>
    </div>
  </div>
  <div v-else-if="c.status === 'error'" class="file-view">
    <div class="file-card" role="alert">
      <h2 class="file-card-title">Couldn't load this file</h2>
      <p class="file-card-text">The review server did not answer. Try again in a moment.</p>
      <button type="button" class="btn btn-primary" @click="retry">Try again</button>
    </div>
  </div>
  <div v-else-if="c.kind === 'image'" class="file-view file-image">
    <img :src="c.url" :alt="c.path" />
  </div>
  <div v-else-if="c.kind === 'download'" class="file-view">
    <div class="file-card file-download-card" data-testid="file-download-card">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
      <div class="file-card-name">{{ c.path }}</div>
      <div v-if="c.size !== null" class="file-card-text">{{ formatFileSize(c.size) }} · this file type isn't shown in the browser</div>
      <a class="btn btn-primary" :href="c.url" :download="baseName(c.path)">Download</a>
    </div>
  </div>
  <PreviewPane
    v-else
    :key="`${c.id}/${c.path}`"
    :content="source"
    :comments="doc.NO_COMMENTS"
    :commenting="false"
    :theme="doc.theme.value"
    :content-type="c.kind === 'html' ? 'html' : 'markdown'"
  />
</template>

<style scoped>
.file-view {
  height: 100%;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg-surface);
}

.file-image {
  align-items: flex-start;
}

/* Rule 22: fitted to the width (never wider than the column). */
.file-image img {
  display: block;
  max-width: 100%;
  height: auto;
}

.file-loading {
  min-height: 120px;
}

.file-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 420px;
  padding: 24px;
  text-align: center;
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-surface);
}

.file-card-title {
  margin: 0;
  font-size: 18px;
  color: var(--text-primary);
}

.file-card-name {
  max-width: 100%;
  font-weight: 600;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.file-card .btn {
  text-decoration: none;
}

.file-card-text {
  margin: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
</style>

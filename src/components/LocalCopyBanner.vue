<script setup lang="ts">
import { ref, computed } from 'vue'
import { useDocState } from '@/composables/useDocState'
import { toast } from '@/composables/useToast'

// #23: edits that never reached the server, set aside when the doc turned
// view-only. Shown as what they are — an unsaved local copy — next to the
// server version, never as the document. The user copies, downloads or
// discards it. The copy renders with the preview styles (.preview-pane).
const doc = useDocState()
const { localCopy, onScreen, filename, capability } = doc
const canEdit = computed(() => capability.value === 'editor')
/** QA M6: a copy set aside by "Use server version" in a conflict (restorable while the link can edit). */
const fromConflict = computed(() => localCopy.value?.reason === 'conflict')
const expanded = ref(true)

const when = computed(() => {
  const at = localCopy.value?.at
  const d = at ? new Date(at) : null
  return d && !isNaN(d.getTime()) ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : null
})

async function copy() {
  if (!localCopy.value) return
  try {
    await navigator.clipboard.writeText(localCopy.value.markdown)
    toast.success('Your changes were copied')
  } catch {
    toast.error("Couldn't copy. Use Download instead.")
  }
}

function download() {
  const c = localCopy.value
  if (!c) return
  const base = (c.filename || filename.value || 'document.md').replace(/\.(md|markdown|txt)$/i, '')
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
  if (!window.confirm('Discard your unsaved changes? They are not on the server.')) return
  doc.discardLocalCopy()
}
</script>

<template>
  <section v-if="onScreen && localCopy" class="local-copy" role="region" aria-labelledby="local-copy-title" data-testid="local-copy-banner">
    <div class="local-copy-bar">
      <div class="local-copy-text">
        <strong id="local-copy-title">Your unsaved changes (not on the server)</strong>
        <span v-if="fromConflict" class="local-copy-sub">You chose the server version in a conflict, so your edits were set aside{{ when ? ` (${when})` : '' }}. The document shows the server version.</span>
        <span v-else class="local-copy-sub">This link is view-only, so these edits could not be saved{{ when ? ` (${when})` : '' }}. Below them is the server version.</span>
      </div>
      <div class="local-copy-actions">
        <button type="button" class="btn btn-ghost btn-sm" :aria-expanded="expanded ? 'true' : 'false'" data-testid="local-copy-toggle" @click="expanded = !expanded">{{ expanded ? 'Hide' : 'Show' }}</button>
        <button v-if="canEdit" type="button" class="btn btn-ghost btn-sm" data-testid="local-copy-restore" title="Put these edits back in the editor as unsaved edits" @click="doc.restoreLocalCopy()">Restore</button>
        <button type="button" class="btn btn-ghost btn-sm" data-testid="local-copy-copy" @click="copy">Copy</button>
        <button type="button" class="btn btn-ghost btn-sm" data-testid="local-copy-download" @click="download">Download</button>
        <button type="button" class="btn btn-ghost btn-sm" data-testid="local-copy-discard" @click="discard">Discard</button>
      </div>
    </div>
    <div v-if="expanded" class="preview-pane local-copy-body" data-testid="local-copy-body"><pre>{{ localCopy.markdown }}</pre></div>
  </section>
</template>

<style scoped>
.local-copy {
  border-bottom: 1px solid var(--border);
  background: var(--comment-bg);
}
.local-copy-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 8px 16px;
}
.local-copy-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  min-width: 0;
}
.local-copy-sub {
  color: var(--text-secondary);
}
.local-copy-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.local-copy-body {
  height: auto;
  max-height: 35vh;
  margin: 0 16px 10px;
  padding: 10px 14px;
  border: 1px dashed var(--border);
  border-radius: 6px;
}
.local-copy-body pre {
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: var(--font-mono);
  font-size: 13px;
  background: none;
  border: none;
  padding: 0;
}
</style>

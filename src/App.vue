<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { AppMode, PaneMode, CommentCategory } from '@/types'
import { useComments } from '@/composables/useComments'
import { usePersistence, useThemePersistence } from '@/composables/usePersistence'
import { useShare } from '@/composables/useShare'
import HeaderBar from '@/components/HeaderBar.vue'
import FileUpload from '@/components/FileUpload.vue'
import EditorPane from '@/components/EditorPane.vue'
import PreviewPane from '@/components/PreviewPane.vue'
import CommentsSidebar from '@/components/CommentsSidebar.vue'
import CommentPopover from '@/components/CommentPopover.vue'
import PromptModal from '@/components/PromptModal.vue'
import ShareModal from '@/components/ShareModal.vue'

const appMode = ref<AppMode>('upload')
const paneMode = ref<PaneMode>('edit')
const markdown = ref('')
const filename = ref('')
const showPromptModal = ref(false)
const sidebarHidden = ref(false)

const { comments, addComment, editComment, deleteComment, clearComments, loadComments } = useComments()

const { theme, setTheme } = useThemePersistence()

const { clearPersisted } = usePersistence(
  markdown,
  filename,
  comments,
  loadComments,
  (mode) => { appMode.value = mode },
)

const { sharing, shareError, createShare, loadShare, fetchGithub, getShareIdFromHash, setShareHash, getShareUrls } = useShare()

const showShareModal = ref(false)
const shareResult = ref<{ ui: string; api: string; comments: string; markdown: string } | null>(null)

// Load file from ?filePath= URL param (dev server only)
const filePathParam = ref<string | null>(null)

async function loadFromFilePath() {
  const filePath = filePathParam.value
  if (!filePath) return

  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`)
    if (!res.ok) return
    const { content, filename: name } = await res.json()
    handleFileLoaded(content, name)
  } catch {
    // API not available (production build) — ignore
  }
}

async function handleShare() {
  const id = await createShare(markdown.value, filename.value, comments.value)
  if (id) {
    setShareHash(id)
    shareResult.value = getShareUrls(id)
    showShareModal.value = true
  } else {
    alert(shareError.value || 'Failed to create share link.')
  }
}

async function loadSharedDoc() {
  const shareId = getShareIdFromHash()
  if (!shareId) return

  const data = await loadShare(shareId)
  if (data) {
    handleFileLoaded(data.markdown, data.filename)
    if (data.comments?.length) {
      loadComments(data.comments)
    }
  }
}

async function loadFromGithubHash() {
  const hash = window.location.hash
  const match = hash.match(/^#github=(.+)$/)
  if (!match) return

  const githubUrl = decodeURIComponent(match[1])
  const data = await fetchGithub(githubUrl)
  if (data) {
    handleFileLoaded(data.content, data.filename)
  }
}

onMounted(() => {
  filePathParam.value = new URLSearchParams(window.location.search).get('filePath')
  loadFromFilePath()
  loadSharedDoc()
  loadFromGithubHash()
})

const selection = ref<{
  startLine: number
  endLine: number
  selectedText: string
  coords: { x: number; y: number }
} | null>(null)

const showPopover = ref(false)

const editorRef = ref<InstanceType<typeof EditorPane>>()
const previewRef = ref<InstanceType<typeof PreviewPane>>()

function handleFileLoaded(content: string, name: string) {
  clearComments()
  showPopover.value = false
  selection.value = null
  markdown.value = content
  filename.value = name
  appMode.value = 'review'
}

function handleNewDoc() {
  clearComments()
  clearPersisted()
  showPopover.value = false
  selection.value = null
  markdown.value = ''
  filename.value = ''
  appMode.value = 'upload'
  if (window.location.search || window.location.hash) {
    window.history.replaceState({}, '', window.location.pathname)
  }
}

function handleSelection(info: {
  startLine: number
  endLine: number
  selectedText: string
  coords: { x: number; y: number }
}) {
  selection.value = info
  showPopover.value = true
}

function handleSelectionClear() {
  setTimeout(() => {
    if (!showPopover.value) {
      selection.value = null
    }
  }, 200)
}

function handleAddComment(body: string, category: CommentCategory) {
  if (!selection.value) return
  addComment({
    startLine: selection.value.startLine,
    endLine: selection.value.endLine,
    selectedText: selection.value.selectedText,
    body,
    category,
  })
  showPopover.value = false
  selection.value = null
}

function handleCancelPopover() {
  showPopover.value = false
  selection.value = null
}

function handleScrollTo(line: number) {
  if (paneMode.value === 'edit') {
    editorRef.value?.scrollToLine(line)
  } else {
    previewRef.value?.scrollToLine(line)
  }
}

function handleOpenFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.md,.markdown,.txt'
  input.onchange = () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      handleFileLoaded(reader.result as string, file.name)
    }
    reader.readAsText(file)
  }
  input.click()
}

const wordCount = computed(() => {
  if (!markdown.value) return 0
  return markdown.value.split(/\s+/).filter(w => w.length > 0).length
})

const charCount = computed(() => markdown.value.length)

// ── Export / Import comments ──────────────────────────────────

function handleExportComments() {
  if (comments.value.length === 0) return

  const data = {
    version: 1,
    filename: filename.value,
    exportedAt: new Date().toISOString(),
    comments: comments.value,
  }

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const baseName = filename.value.replace(/\.[^.]+$/, '')
  a.download = `${baseName}.comments.json`
  a.click()
  URL.revokeObjectURL(url)
}

function handleImportComments() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string)
        const imported = Array.isArray(data.comments) ? data.comments : Array.isArray(data) ? data : null
        if (!imported || !imported.every((c: any) => typeof c.startLine === 'number' && typeof c.body === 'string')) {
          alert('Invalid comment file format.')
          return
        }
        loadComments(imported)
      } catch {
        alert('Could not parse comment file.')
      }
    }
    reader.readAsText(file)
  }
  input.click()
}
</script>

<template>
  <div class="app">
    <HeaderBar
      :filename="filename"
      :pane-mode="paneMode"
      :comment-count="comments.length"
      :theme="theme"
      :word-count="wordCount"
      :char-count="charCount"
      :can-refresh="!!filePathParam"
      :sharing="sharing"
      @update:pane-mode="paneMode = $event"
      @update:theme="setTheme"
      @open-file="handleOpenFile"
      @new-doc="handleNewDoc"
      @generate-prompt="showPromptModal = true"
      @refresh="loadFromFilePath"
      @share="handleShare"
    />

    <FileUpload v-if="appMode === 'upload'" @file-loaded="handleFileLoaded" />

    <div v-else class="review-layout">
      <div class="main-pane">
        <EditorPane
          v-if="paneMode === 'edit'"
          ref="editorRef"
          v-model="markdown"
          :comments="comments"
          @selection="handleSelection"
          @selection-clear="handleSelectionClear"
        />
        <PreviewPane
          v-if="paneMode === 'preview'"
          ref="previewRef"
          :content="markdown"
          :comments="comments"
          @selection="handleSelection"
          @selection-clear="handleSelectionClear"
        />
      </div>
      <button
        class="sidebar-toggle"
        :class="{ collapsed: sidebarHidden }"
        :title="sidebarHidden ? 'Show comments panel' : 'Hide comments panel'"
        @click="sidebarHidden = !sidebarHidden"
      >
        <span class="sidebar-toggle-grip"></span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        <span class="sidebar-toggle-grip"></span>
      </button>
      <CommentsSidebar
        v-show="!sidebarHidden"
        :comments="comments"
        @delete="deleteComment"
        @edit="editComment"
        @scroll-to="handleScrollTo"
        @export-comments="handleExportComments"
        @import-comments="handleImportComments"
      />
    </div>

    <CommentPopover
      :visible="showPopover"
      :selected-text="selection?.selectedText ?? ''"
      :coords="selection?.coords ?? { x: 0, y: 0 }"
      @add="handleAddComment"
      @cancel="handleCancelPopover"
    />

    <PromptModal
      :visible="showPromptModal"
      :filename="filename"
      :comments="comments"
      :content="markdown"
      @close="showPromptModal = false"
    />

    <ShareModal
      :visible="showShareModal"
      :filename="filename"
      :urls="shareResult"
      :comment-count="comments.length"
      @close="showShareModal = false"
    />
  </div>
</template>

<style scoped>
.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.review-layout {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.main-pane {
  flex: 7;
  overflow: hidden;
}

.sidebar-toggle {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 16px;
  flex-shrink: 0;
  border: none;
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
  background: var(--bg-page);
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
  transition: color 0.15s, background 0.15s;
}

.sidebar-toggle:hover {
  color: var(--text-primary);
  background: var(--bg-surface);
}

.sidebar-toggle-grip {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.4;
}

.sidebar-toggle:hover .sidebar-toggle-grip {
  opacity: 0.7;
}

.sidebar-toggle svg {
  transition: transform 0.15s;
}

.sidebar-toggle.collapsed svg {
  transform: rotate(180deg);
}

.review-layout > :deep(.sidebar) {
  flex: 3;
  max-width: 340px;
  min-width: 260px;
}
</style>

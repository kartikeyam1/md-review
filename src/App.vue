<script setup lang="ts">
import { ref, computed } from 'vue'
import type { AppMode, PaneMode } from '@/types'
import { useComments } from '@/composables/useComments'
import { generatePrompt } from '@/composables/usePromptGenerator'
import HeaderBar from '@/components/HeaderBar.vue'
import FileUpload from '@/components/FileUpload.vue'
import EditorPane from '@/components/EditorPane.vue'
import PreviewPane from '@/components/PreviewPane.vue'
import CommentsSidebar from '@/components/CommentsSidebar.vue'
import CommentPopover from '@/components/CommentPopover.vue'
import PromptModal from '@/components/PromptModal.vue'

const appMode = ref<AppMode>('upload')
const paneMode = ref<PaneMode>('edit')
const markdown = ref('')
const filename = ref('')
const showPromptModal = ref(false)

const { comments, addComment, deleteComment } = useComments()

// Selection state for CommentPopover
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
  markdown.value = content
  filename.value = name
  appMode.value = 'review'
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

function handleAddComment(body: string) {
  if (!selection.value) return
  addComment({
    startLine: selection.value.startLine,
    endLine: selection.value.endLine,
    selectedText: selection.value.selectedText,
    body,
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

const prompt = computed(() =>
  generatePrompt(filename.value, comments.value, markdown.value)
)
</script>

<template>
  <div class="app">
    <HeaderBar
      :filename="filename"
      :pane-mode="paneMode"
      :comment-count="comments.length"
      @update:pane-mode="paneMode = $event"
      @open-file="handleOpenFile"
      @generate-prompt="showPromptModal = true"
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
      <CommentsSidebar
        :comments="comments"
        @delete="deleteComment"
        @scroll-to="handleScrollTo"
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
      :prompt="prompt"
      @close="showPromptModal = false"
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

.review-layout > :deep(.sidebar) {
  flex: 3;
  max-width: 340px;
  min-width: 260px;
}
</style>

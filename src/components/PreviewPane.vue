<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import type { Comment } from '@/types'
import { useMarkdown } from '@/composables/useMarkdown'

const props = defineProps<{
  content: string
  comments: Comment[]
}>()

const emit = defineEmits<{
  selection: [payload: {
    startLine: number
    endLine: number
    selectedText: string
    coords: { x: number; y: number }
  }]
  'selection-clear': []
}>()

const { renderHtml } = useMarkdown()
const containerRef = ref<HTMLElement | null>(null)

// renderHtml now injects data-line-start/data-line-end via the markdown-it plugin
const renderedHtml = computed(() => renderHtml(props.content))

function applyCommentHighlights() {
  const container = containerRef.value
  if (!container) return

  const annotated = container.querySelectorAll<HTMLElement>('[data-line-start]')

  for (const el of annotated) {
    el.classList.remove('comment-highlight')
    const elStart = parseInt(el.getAttribute('data-line-start')!, 10)
    const elEnd = parseInt(el.getAttribute('data-line-end')!, 10)

    for (const comment of props.comments) {
      if (elStart < comment.endLine && elEnd > comment.startLine) {
        el.classList.add('comment-highlight')
        break
      }
    }
  }
}

watch(
  () => renderedHtml.value,
  async () => {
    await nextTick()
    applyCommentHighlights()
  }
)

watch(
  () => props.comments,
  async () => {
    await nextTick()
    applyCommentHighlights()
  },
  { deep: true }
)

onMounted(() => {
  nextTick(() => applyCommentHighlights())
})

function findBlockAncestor(node: Node): HTMLElement | null {
  let current: Node | null = node
  const container = containerRef.value
  while (current && current !== container) {
    if (
      current instanceof HTMLElement &&
      current.hasAttribute('data-line-start')
    ) {
      return current
    }
    current = current.parentNode
  }
  return null
}

function onMouseUp() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    emit('selection-clear')
    return
  }

  const selectedText = selection.toString().trim()
  if (!selectedText) {
    emit('selection-clear')
    return
  }

  const range = selection.getRangeAt(0)
  const startBlock = findBlockAncestor(range.startContainer)
  const endBlock = findBlockAncestor(range.endContainer)

  if (!startBlock && !endBlock) {
    emit('selection-clear')
    return
  }

  const firstBlock = startBlock || endBlock!
  const lastBlock = endBlock || startBlock!

  const startLine = parseInt(firstBlock.getAttribute('data-line-start')!, 10)
  const endLine = parseInt(lastBlock.getAttribute('data-line-end')!, 10)

  const rect = range.getBoundingClientRect()

  emit('selection', {
    startLine,
    endLine,
    selectedText,
    coords: {
      x: rect.right,
      y: rect.top,
    },
  })
}

function onMouseDown() {
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed) {
    emit('selection-clear')
  }
}

function scrollToLine(line: number) {
  const container = containerRef.value
  if (!container) return

  const annotated = container.querySelectorAll<HTMLElement>('[data-line-start]')
  for (const el of annotated) {
    const start = parseInt(el.getAttribute('data-line-start')!, 10)
    const end = parseInt(el.getAttribute('data-line-end')!, 10)
    if (line >= start && line < end) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
  }
}

defineExpose({ scrollToLine })
</script>

<template>
  <div
    ref="containerRef"
    class="preview-pane"
    @mouseup="onMouseUp"
    @mousedown="onMouseDown"
    v-html="renderedHtml"
  />
</template>

<style scoped>
.preview-pane {
  padding: 24px 32px;
  font-family: var(--font-body);
  font-size: 15px;
  line-height: 1.7;
  color: var(--text-primary);
  overflow-y: auto;
  height: 100%;
}

.preview-pane :deep(h1) {
  font-family: var(--font-heading);
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 24px 0 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.preview-pane :deep(h2) {
  font-family: var(--font-heading);
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 20px 0 10px;
}

.preview-pane :deep(h3) {
  font-family: var(--font-heading);
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 16px 0 8px;
}

.preview-pane :deep(p) {
  color: var(--text-secondary);
  margin: 0 0 12px;
}

.preview-pane :deep(ul),
.preview-pane :deep(ol) {
  color: var(--text-secondary);
  padding-left: 24px;
  margin: 0 0 12px;
}

.preview-pane :deep(li) {
  margin: 4px 0;
}

.preview-pane :deep(code) {
  font-family: var(--font-mono);
  background: var(--bg-page);
  padding: 2px 5px;
  border-radius: 3px;
  font-size: 13px;
}

.preview-pane :deep(pre) {
  background: var(--bg-page);
  padding: 12px;
  border-radius: 6px;
  margin: 0 0 12px;
  overflow-x: auto;
}

.preview-pane :deep(pre code) {
  background: none;
  padding: 0;
}

.preview-pane :deep(strong) {
  color: var(--text-primary);
}

.preview-pane :deep(blockquote) {
  border-left: 3px solid var(--border);
  padding-left: 16px;
  color: var(--text-muted);
  margin: 0 0 12px;
}

.preview-pane :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 24px 0;
}

.preview-pane :deep(a) {
  color: var(--accent);
  text-decoration: none;
}

.preview-pane :deep(a:hover) {
  text-decoration: underline;
}

.preview-pane :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0 0 12px;
}

.preview-pane :deep(th),
.preview-pane :deep(td) {
  border: 1px solid var(--border);
  padding: 8px 12px;
  text-align: left;
}

.preview-pane :deep(th) {
  background: var(--bg-page);
  font-weight: 600;
}

.preview-pane :deep(.comment-highlight) {
  background: var(--comment-bg);
  border-left: 2px solid var(--accent);
  padding-left: 8px;
  margin-left: -10px;
}
</style>

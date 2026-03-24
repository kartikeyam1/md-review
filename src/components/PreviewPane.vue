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
  background: var(--bg-surface);
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
  background: var(--bg-code, var(--bg-page));
  padding: 2px 5px;
  border-radius: 3px;
  font-size: 13px;
}

.preview-pane :deep(pre) {
  background: var(--bg-code, var(--bg-page));
  border: 1px solid var(--border);
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
  font-size: 14px;
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
  color: var(--text-primary);
}

.preview-pane :deep(tbody tr:nth-child(even)) {
  background: var(--bg-page);
}

.preview-pane :deep(tbody tr:hover) {
  background: var(--comment-bg);
}

.preview-pane :deep(.comment-highlight) {
  background: var(--comment-bg);
  border-left: 2px solid var(--accent);
  padding-left: 8px;
  margin-left: -10px;
}

/* highlight.js token colours — mapped to theme CSS custom properties */
.preview-pane :deep(.hljs-keyword),
.preview-pane :deep(.hljs-selector-tag),
.preview-pane :deep(.hljs-tag) {
  color: var(--accent);
  font-weight: 500;
}

.preview-pane :deep(.hljs-string),
.preview-pane :deep(.hljs-attr),
.preview-pane :deep(.hljs-selector-attr) {
  color: var(--text-secondary);
}

.preview-pane :deep(.hljs-comment),
.preview-pane :deep(.hljs-quote) {
  color: var(--text-muted);
  font-style: italic;
}

.preview-pane :deep(.hljs-number),
.preview-pane :deep(.hljs-literal) {
  color: var(--accent);
  opacity: 0.85;
}

.preview-pane :deep(.hljs-function),
.preview-pane :deep(.hljs-title),
.preview-pane :deep(.hljs-title\.function_) {
  color: var(--text-primary);
  font-weight: 600;
}

.preview-pane :deep(.hljs-built_in),
.preview-pane :deep(.hljs-class) {
  color: var(--text-primary);
  opacity: 0.9;
}

.preview-pane :deep(.hljs-type),
.preview-pane :deep(.hljs-selector-class) {
  color: var(--text-secondary);
  font-weight: 500;
}

.preview-pane :deep(.hljs-variable),
.preview-pane :deep(.hljs-template-variable) {
  color: var(--text-secondary);
}

.preview-pane :deep(.hljs-meta),
.preview-pane :deep(.hljs-meta-keyword) {
  color: var(--text-muted);
}

.preview-pane :deep(.hljs-punctuation),
.preview-pane :deep(.hljs-operator) {
  color: var(--text-muted);
}

/* h4 / h5 / h6 */
.preview-pane :deep(h4) {
  font-family: var(--font-heading);
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 14px 0 6px;
}

.preview-pane :deep(h5) {
  font-family: var(--font-heading);
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 12px 0 6px;
}

.preview-pane :deep(h6) {
  font-family: var(--font-heading);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin: 10px 0 6px;
}

/* Images */
.preview-pane :deep(img) {
  max-width: 100%;
  border-radius: 6px;
  display: block;
  margin: 12px auto;
}

/* Task list checkboxes */
.preview-pane :deep(.contains-task-list) {
  list-style: none;
  padding-left: 4px;
}

.preview-pane :deep(.task-list-item) {
  list-style: none;
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.preview-pane :deep(.task-list-item input[type='checkbox']) {
  appearance: auto;
  margin: 0;
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  accent-color: var(--accent);
  cursor: default;
}

.preview-pane :deep(.task-list-item input[type='checkbox']:checked + span),
.preview-pane :deep(.task-list-item input[type='checkbox']:checked ~ *) {
  color: var(--text-muted);
  text-decoration: line-through;
  text-decoration-color: var(--text-muted);
}
</style>

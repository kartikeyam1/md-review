<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, shallowRef } from 'vue'
import { EditorView, Decoration, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { EditorState, StateField, StateEffect, RangeSetBuilder, Compartment, type Extension } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { languages } from '@codemirror/language-data'
import { undo, redo, undoDepth, redoDepth } from '@codemirror/commands'
import type { Comment, ContentType } from '@/types'
import EditorToolbar from '@/components/EditorToolbar.vue'
import { editorExtensions } from '@/editor/extensions'
import { applyExternal, clearHistory, externalWrite, keepState, takeKeptState } from '@/editor/history'
import { onHistoryBarrier, takeExternalOrigin } from '@/composables/useExternalChange'
import { formatTable as formatTableCommand } from '@/editor/tablePaste'

// ── Props & Emits ──────────────────────────────────────────────

const props = defineProps<{
  modelValue: string
  comments: Comment[]
  contentType?: ContentType
}>()

// Language is swappable at runtime via a compartment so switching document type
// doesn't require tearing down the editor.
const languageCompartment = new Compartment()

function languageExtension(type: ContentType | undefined): Extension {
  return type === 'html' ? html() : markdown({ codeLanguages: languages })
}

const emit = defineEmits<{
  'update:modelValue': [value: string]
  selection: [payload: { startLine: number; endLine: number; selectedText: string; coords: { x: number; y: number } }]
  'selection-clear': []
}>()

// ── Refs ───────────────────────────────────────────────────────

const container = ref<HTMLDivElement | null>(null)
const view = shallowRef<EditorView | null>(null)

// Toolbar state: each button is enabled exactly when its stack has a step.
const canUndo = ref(false)
const canRedo = ref(false)

function syncDepths(state: EditorState) {
  canUndo.value = undoDepth(state) > 0
  canRedo.value = redoDepth(state) > 0
}

// ── Comment decoration machinery ───────────────────────────────

const setCommentsEffect = StateEffect.define<Comment[]>()

const commentLineDecoration = Decoration.line({
  attributes: {
    style: 'background: var(--comment-bg); border-left: 2px solid var(--accent);',
  },
})

const commentField = StateField.define({
  create() {
    return Decoration.none
  },
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCommentsEffect)) {
        return buildDecorations(tr.state, effect.value)
      }
    }
    // remap on doc changes so positions stay correct
    if (tr.docChanged) {
      return decorations.map(tr.changes)
    }
    return decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

function buildDecorations(state: EditorState, comments: Comment[]) {
  const builder = new RangeSetBuilder<Decoration>()
  const totalLines = state.doc.lines

  // Collect all lines that should be decorated (sorted, unique)
  const lineSet = new Set<number>()
  for (const c of comments) {
    // startLine is 0-indexed, endLine is exclusive
    for (let l = c.startLine; l < c.endLine; l++) {
      const cmLine = l + 1 // CodeMirror lines are 1-indexed
      if (cmLine >= 1 && cmLine <= totalLines) {
        lineSet.add(cmLine)
      }
    }
  }

  const sortedLines = Array.from(lineSet).sort((a, b) => a - b)
  for (const lineNum of sortedLines) {
    const lineObj = state.doc.line(lineNum)
    builder.add(lineObj.from, lineObj.from, commentLineDecoration)
  }

  return builder.finish()
}

// ── Theme ──────────────────────────────────────────────────────

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '14px',
    fontFamily: 'var(--font-mono)',
    backgroundColor: 'var(--bg-surface)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    overflow: 'auto',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-muted)',
    border: 'none',
  },
  '.cm-content': {
    caretColor: 'var(--text-primary)',
  },
  // CodeMirror draws its own caret (black by default): follow the theme ink so
  // it stays visible in every dark theme.
  '&.cm-editor .cm-cursor, &.cm-editor .cm-dropCursor': {
    borderLeftColor: 'var(--text-primary)',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--selection-bg) !important',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'var(--selection-bg) !important',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
})

// ── Selection listener ─────────────────────────────────────────

const selectionListener = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (!update.selectionSet && !update.docChanged) return

      const state = update.state
      const sel = state.selection.main

      if (sel.empty) {
        emit('selection-clear')
        return
      }

      const selectedText = state.sliceDoc(sel.from, sel.to)
      if (!selectedText.trim()) {
        emit('selection-clear')
        return
      }

      const startLineObj = state.doc.lineAt(sel.from)
      let endLineObj = state.doc.lineAt(sel.to)

      // Triple-click includes trailing newline, placing sel.to at the start
      // of the next line. Adjust back if no content is selected on that line.
      if (sel.to === endLineObj.from && endLineObj.number > startLineObj.number) {
        endLineObj = state.doc.lineAt(sel.to - 1)
      }

      const startLine = startLineObj.number - 1
      const endLine = endLineObj.number
      const selTo = sel.to
      const editorView = update.view

      // coordsAtPos cannot be called during an update — defer to next frame
      requestAnimationFrame(() => {
        // By the next frame the doc may have shrunk (or the view gone): measure a
        // position that still exists, and never let a stale one throw.
        if (!editorView.dom.isConnected) return
        let coords: { left: number; bottom: number } | null = null
        try {
          coords = editorView.coordsAtPos(Math.min(selTo, editorView.state.doc.length))
        } catch {
          coords = null
        }
        const x = coords ? coords.left : 0
        const y = coords ? coords.bottom : 0
        emit('selection', { startLine, endLine, selectedText, coords: { x, y } })
      })
    }
  },
)

// ── Lifecycle ──────────────────────────────────────────────────

onMounted(() => {
  if (!container.value) return

  // Same document as when this editor was last unmounted (a view switch):
  // take its selection and undo history back (#8 rule 7).
  const kept = takeKeptState(props.modelValue)
  const state = EditorState.create({
    doc: props.modelValue,
    selection: kept?.selection,
    extensions: [
      ...editorExtensions({ restoredHistory: kept?.extension ?? null }),
      languageCompartment.of(languageExtension(props.contentType)),
      commentField,
      editorTheme,
      selectionListener,
      EditorView.updateListener.of((update: ViewUpdate) => {
        // External writes already come from the model: never echo them back.
        const external = update.transactions.some((tr) => tr.annotation(externalWrite) !== undefined)
        if (update.docChanged && !external) {
          emit('update:modelValue', update.state.doc.toString())
        }
        syncDepths(update.state)
      }),
    ],
  })

  view.value = new EditorView({
    state,
    parent: container.value,
  })
  syncDepths(state)

  // Apply initial comments
  if (props.comments.length > 0) {
    view.value.dispatch({
      effects: setCommentsEffect.of(props.comments),
    })
  }
})

// A barrier (another document, a remote write) also empties this live
// editor's history: #6 keeps the instance across a local file replacement.
const stopBarrier = onHistoryBarrier(() => {
  if (!view.value) return
  clearHistory(view.value)
  syncDepths(view.value.state)
})

onBeforeUnmount(() => {
  stopBarrier()
  if (view.value) keepState(view.value.state)
  view.value?.destroy()
})

// ── Watchers ───────────────────────────────────────────────────

// Only rebuild decorations when comment line ranges change (not body/category edits)
function commentLineKey(comments: Comment[]): string {
  return comments.map((c) => `${c.id}:${c.startLine}:${c.endLine}`).join(',')
}

let lastLineKey = ''

watch(
  () => props.contentType,
  (type) => {
    if (!view.value) return
    view.value.dispatch({
      effects: languageCompartment.reconfigure(languageExtension(type)),
    })
  },
)

watch(
  () => props.comments,
  (newComments) => {
    if (!view.value) return
    const key = commentLineKey(newComments)
    if (key === lastLineKey) return
    lastLineKey = key
    view.value.dispatch({
      effects: setCommentsEffect.of(newComments),
    })
  },
  { deep: true },
)

watch(
  () => props.modelValue,
  (newValue) => {
    if (!view.value) return
    // An external write (the editor's own edits arrive here equal to its doc):
    // a minimal change; remote ones bypass and clear history, local ones
    // (revision restore) are one undo step (#8 rules 4, 6).
    const origin = takeExternalOrigin(newValue)
    if (newValue === view.value.state.doc.toString()) return
    applyExternal(view.value, newValue, origin)
  },
)

// ── Exposed methods ────────────────────────────────────────────

function scrollToLine(line: number) {
  if (!view.value) return
  // line is 0-indexed from external callers; CM uses 1-indexed
  const cmLine = Math.max(1, Math.min(line + 1, view.value.state.doc.lines))
  const lineObj = view.value.state.doc.line(cmLine)
  view.value.dispatch({
    effects: EditorView.scrollIntoView(lineObj.from, { y: 'center' }),
  })
}

/** Move keyboard focus into the editor (used by the lazy slot once it mounts, #6). */
function focus() {
  view.value?.focus()
}

function runHistory(command: typeof undo) {
  const v = view.value
  if (!v) return
  command(v)
  v.focus()
}

/** Re-align the table under the cursor (#11; also Shift+Alt+F). */
function formatTable() {
  const v = view.value
  if (!v) return
  formatTableCommand(v)
  v.focus()
}

defineExpose({ scrollToLine, focus, formatTable })
</script>

<template>
  <div class="editor-pane">
    <EditorToolbar
      :can-undo="canUndo"
      :can-redo="canRedo"
      @undo="runHistory(undo)"
      @redo="runHistory(redo)"
    />
    <div ref="container" class="editor-host" />
  </div>
</template>

<style scoped>
.editor-pane {
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.editor-host {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.editor-pane :deep(.cm-editor) {
  height: 100%;
}

/* CodeMirror search panel */
.editor-pane :deep(.cm-panels) {
  background: var(--bg-page);
  border-bottom: 1px solid var(--border);
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--text-primary);
}

.editor-pane :deep(.cm-search) {
  padding: 6px 10px;
}

.editor-pane :deep(.cm-search input),
.editor-pane :deep(.cm-search [type="text"]) {
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 3px 6px;
  font-family: var(--font-mono);
  font-size: 13px;
  outline: none;
}

.editor-pane :deep(.cm-search input:focus) {
  border-color: var(--accent);
}

.editor-pane :deep(.cm-search button) {
  background: var(--bg-surface);
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 3px 8px;
  font-size: 12px;
  cursor: pointer;
}

.editor-pane :deep(.cm-search button:hover) {
  background: var(--bg-page);
  color: var(--text-primary);
}

.editor-pane :deep(.cm-search label) {
  color: var(--text-secondary);
  font-size: 12px;
}

.editor-pane :deep(.cm-searchMatch) {
  background: var(--selection-bg);
  outline: 1px solid var(--accent);
  border-radius: 1px;
}

.editor-pane :deep(.cm-searchMatch-selected) {
  background: var(--comment-bg);
  outline: 2px solid var(--accent);
}
</style>

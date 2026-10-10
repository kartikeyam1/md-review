<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import type { Comment, ThemeMode, ContentType } from '@/types'
import { useMarkdown } from '@/composables/useMarkdown'
import { isGithub, isDark } from '@/composables/useTheme'
import { findLineRange } from '@/composables/useHtmlSource'
import { useRouter, scrollToAnchorElement, findAnchorIn } from '@/composables/useRouter'

const props = defineProps<{
  content: string
  comments: Comment[]
  theme?: ThemeMode
  contentType?: ContentType
}>()

// Mermaid is loaded on demand — only documents that actually contain a
// diagram pay for it (it and its plugins are the bulk of the bundle).
type MermaidApi = typeof import('mermaid')['default']
let mermaidApi: MermaidApi | null = null
let mermaidLoading: Promise<MermaidApi> | null = null

function loadMermaid(): Promise<MermaidApi> {
  if (mermaidApi) return Promise.resolve(mermaidApi)
  mermaidLoading ??= import('mermaid').then((m) => {
    mermaidApi = m.default
    return mermaidApi
  })
  return mermaidLoading
}

function mermaidTheme(): 'dark' | 'neutral' {
  return isDark(props.theme ?? 'light') ? 'dark' : 'neutral'
}

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
const frameRef = ref<HTMLIFrameElement | null>(null)
const isGithubTheme = computed(() => isGithub(props.theme ?? 'light'))
const isHtml = computed(() => props.contentType === 'html')

// renderHtml now injects data-line-start/data-line-end via the markdown-it plugin
const renderedHtml = computed(() => renderHtml(props.content))

// ── HTML preview (sandboxed iframe) ─────────────────────────────────────────
// Full HTML documents render faithfully inside an opaque-origin sandbox
// (allow-scripts only, NO allow-same-origin) so the reviewed page's scripts &
// styles can never touch the review app or its storage. A tiny bridge script is
// injected to relay text selections back to the parent for commenting.
const BRIDGE_SCRIPT = `
<script>(function(){
  function send(msg){ try { parent.postMessage(Object.assign({__mdreview:true},msg),'*'); } catch(e){} }
  function motion(){ try { return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'; } catch(e){ return 'auto'; } }
  function findAnchor(id){
    var el = document.getElementById(id);
    if(!el){ var n = document.getElementsByName(id); el = n && n[0]; }
    return el || null;
  }
  document.addEventListener('mouseup', function(){
    var sel = window.getSelection();
    var text = sel && sel.toString().trim();
    if(!text || !sel.rangeCount){ send({type:'selection-clear'}); return; }
    var r = sel.getRangeAt(0).getBoundingClientRect();
    send({type:'selection', text:text, rect:{top:r.top,right:r.right,bottom:r.bottom,left:r.left}});
  });
  document.addEventListener('mousedown', function(){ send({type:'selection-clear'}); });
  // In-page anchor links (a TOC, href="#section"). The frame is sandboxed
  // without allow-same-origin, so its origin is opaque and native fragment
  // navigation of the blob: document is blocked by the browser. Intercept the
  // click and scroll manually. External http(s) links are left untouched.
  document.addEventListener('click', function(ev){
    if(ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if(!a) return;
    var href = a.getAttribute('href') || '';
    if(href.charAt(0) !== '#') return;
    ev.preventDefault();
    var id = href.slice(1);
    try { id = decodeURIComponent(id); } catch(e){}
    if(!id){ window.scrollTo({top:0,behavior:motion()}); send({type:'anchor-changed', id:''}); return; }
    var el = findAnchor(id);
    if(el){ el.scrollIntoView({behavior:motion(),block:'start'}); send({type:'anchor-changed', id:id}); }
  }, true);
  window.addEventListener('message', function(e){
    var d = e.data || {};
    // Theme forwarding: stamp data-theme so theme-aware documents (e.g. claude.ai
    // artifacts) follow the app's dark/light toggle. Harmless no-op otherwise.
    if(d.__mdreview_theme === 'dark' || d.__mdreview_theme === 'light'){
      document.documentElement.setAttribute('data-theme', d.__mdreview_theme);
      return;
    }
    // Parent -> frame: the URL fragment names an anchor in this document.
    if(d.__mdreview && d.type==='anchor' && typeof d.id === 'string'){
      var target = findAnchor(d.id);
      if(target) target.scrollIntoView({behavior: d.smooth ? motion() : 'auto', block:'start'});
      return;
    }
    if(d.__mdreview && d.type==='scroll' && d.text){
      var el = document.body;
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var needle = String(d.text).replace(/\\s+/g,' ').trim().toLowerCase();
      if(!needle) return;
      var node;
      while((node = walker.nextNode())){
        if(node.nodeValue.replace(/\\s+/g,' ').toLowerCase().indexOf(needle) !== -1){
          var p = node.parentElement; if(p){ p.scrollIntoView({behavior:'smooth',block:'center'}); }
          break;
        }
      }
    }
  });
})();<\/script>`

// Full document HTML with the bridge injected just before </body> (fallback:
// append) so the bridge runs after the document's own DOM is parsed.
const frameDoc = computed(() => {
  if (!isHtml.value) return ''
  const html = props.content || '<!doctype html><html><body></body></html>'
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${BRIDGE_SCRIPT}</body>`)
  return html + BRIDGE_SCRIPT
})

// We load the document from a Blob object URL (iframe.src) rather than srcdoc.
// srcdoc documents have no URL of their own and inherit the parent's base URL,
// so an in-page anchor like href="#section" resolves to the app's own URL and
// navigates the whole frame there (booting the app recursively in the sandbox).
// A blob: URL gives the document its own base URL, so fragment links become
// native same-document scrolls and :target CSS works, with no extra JS.
const frameUrl = ref('')
let objectUrl: string | null = null

function revokeObjectUrl() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
}

watch(
  frameDoc,
  (doc) => {
    revokeObjectUrl()
    if (!doc) {
      frameUrl.value = ''
      return
    }
    objectUrl = URL.createObjectURL(new Blob([doc], { type: 'text/html' }))
    frameUrl.value = objectUrl
  },
  { immediate: true }
)

// ── Theme forwarding into the preview ───────────────────────────────────────
function currentThemeName(): 'dark' | 'light' {
  return isDark(props.theme ?? 'light') ? 'dark' : 'light'
}

function postThemeToFrame() {
  const win = frameRef.value?.contentWindow
  if (win) win.postMessage({ __mdreview_theme: currentThemeName() }, '*')
}

// Fired each time the iframe finishes loading a document (initial mount and
// every content change). The bridge's message listener is registered by then.
function onFrameLoad() {
  postThemeToFrame()
  postAnchorToFrame(false)
}

// ── Anchors / URL fragment (spec #4 rules 12–15) ─────────────────────────────
const router = useRouter()

/** Parent -> frame: scroll the HTML doc to the URL's fragment. */
function postAnchorToFrame(smooth: boolean) {
  const win = frameRef.value?.contentWindow
  const id = router.current.value.fragment
  if (win && id) win.postMessage({ __mdreview: true, type: 'anchor', id, smooth }, '*')
}

// Frame -> parent anchor changes replace the fragment (no history entries for
// HTML docs). A document that floods them is coalesced to ≤ 2 updates/s
// (browsers throttle — Safari throws — past ~100 history calls per 30 s).
const ANCHOR_UPDATE_MS = 500
let anchorTimer: ReturnType<typeof setTimeout> | null = null
let pendingAnchor: { id: string; key: string } | null = null
let lastAnchorAt = 0

function flushAnchor() {
  anchorTimer = null
  const pending = pendingAnchor
  pendingAnchor = null
  // The doc may have changed meanwhile: never apply a fragment to the next route.
  if (!pending || pending.key !== router.current.value.key) return
  lastAnchorAt = Date.now()
  router.setFragment(pending.id, 'replace', 'frame')
}

function queueFrameAnchor(id: string) {
  pendingAnchor = { id, key: router.current.value.key }
  const wait = ANCHOR_UPDATE_MS - (Date.now() - lastAnchorAt)
  if (wait <= 0) flushAnchor()
  else anchorTimer ??= setTimeout(flushAnchor, wait)
}

const findAnchor = findAnchorIn

function scrollReaderTo(el: HTMLElement) {
  const container = containerRef.value
  if (el === container) {
    container.scrollTo({ top: 0 })
    window.scrollTo({ top: 0 })
    return
  }
  scrollToAnchorElement(el)
}

function onPreviewClick(e: MouseEvent) {
  const container = containerRef.value
  if (container) router.handleLinkClick(e, container, scrollReaderTo)
}

// Rule 14: after the first render, put the fragment's target at the top of the
// reading area; if mermaid/images shift the layout and the reader has not
// scrolled meanwhile, re-align once (within 3 s).
let mermaidRun: Promise<unknown> = Promise.resolve()
let realignCleanup: (() => void) | null = null

function alignToFragment(opts: { initial: boolean }) {
  if (isHtml.value) { postAnchorToFrame(!opts.initial); return }
  const container = containerRef.value
  if (!container) return
  const id = router.current.value.fragment
  if (!id) {
    if (!opts.initial) scrollReaderTo(container)
    return
  }
  const el = findAnchor(container, id)
  if (!el) return
  scrollToAnchorElement(el, { smooth: !opts.initial })
  if (opts.initial) scheduleRealign(id)
}

function scheduleRealign(id: string) {
  realignCleanup?.()
  let interacted = false
  const mark = () => { interacted = true }
  const events = ['wheel', 'touchmove', 'keydown', 'mousedown'] as const
  for (const ev of events) window.addEventListener(ev, mark, { passive: true, capture: true })
  const cleanup = () => {
    for (const ev of events) window.removeEventListener(ev, mark, { capture: true })
    if (realignCleanup === cleanup) realignCleanup = null
  }
  realignCleanup = cleanup
  const container = containerRef.value
  const images = container
    ? Array.from(container.querySelectorAll('img')).filter((img) => !img.complete).map((img) =>
        new Promise((done) => { img.addEventListener('load', done, { once: true }); img.addEventListener('error', done, { once: true }) }))
    : []
  const settled = Promise.all([mermaidRun.catch(() => {}), ...images])
  const timeout = new Promise((done) => setTimeout(done, 3000))
  Promise.race([settled, timeout]).then(() => {
    const stillCurrent = realignCleanup === cleanup
    cleanup()
    if (!stillCurrent || interacted || router.current.value.fragment !== id) return
    const c = containerRef.value
    const el = c && findAnchor(c, id)
    if (el) scrollToAnchorElement(el, { smooth: false })
  })
}

// Back/Forward or a manual fragment edit on the same doc: scroll, never reload.
watch(() => router.current.value, (loc, prev) => {
  if (!prev || loc.key !== prev.key || loc.source === 'frame') return
  if (loc.fragment === prev.fragment && loc.source !== 'pop') return
  alignToFragment({ initial: false })
})

function onFrameMessage(e: MessageEvent) {
  const frame = frameRef.value
  if (!frame || e.source !== frame.contentWindow) return
  const data: any = e.data
  if (!data || data.__mdreview !== true) return

  if (data.type === 'anchor-changed') {
    const id = data.id
    if (typeof id === 'string' && id.length <= 256) queueFrameAnchor(id)
    return
  }
  if (data.type === 'selection-clear') {
    emit('selection-clear')
    return
  }
  if (data.type === 'selection' && data.text) {
    const range = findLineRange(props.content, data.text)
    if (!range) {
      emit('selection-clear')
      return
    }
    // Selection rect is relative to the iframe viewport — translate to the
    // parent viewport by adding the iframe's on-screen offset.
    const box = frame.getBoundingClientRect()
    emit('selection', {
      startLine: range.startLine,
      endLine: range.endLine,
      selectedText: data.text,
      coords: {
        x: box.left + (data.rect?.right ?? 0),
        y: box.top + (data.rect?.top ?? 0),
      },
    })
  }
}

function applyCommentHighlights() {
  const container = containerRef.value
  if (!container) return

  const annotated = container.querySelectorAll<HTMLElement>('[data-line-start]')

  for (const el of annotated) {
    el.classList.remove('comment-highlight')

    // Only highlight leaf annotated elements — skip parents (e.g. <table>, <ul>)
    // whose children carry their own line ranges for more precise highlighting
    if (el.querySelector('[data-line-start]')) continue

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

async function renderMermaid() {
  const container = containerRef.value
  if (!container) return
  const nodes = container.querySelectorAll<HTMLElement>('.mermaid')
  if (!nodes.length) return
  const mermaid = await loadMermaid()
  // Re-check: the document may have changed while the library was loading.
  if (!containerRef.value || !containerRef.value.querySelector('.mermaid')) return
  mermaid.initialize({ startOnLoad: false, theme: mermaidTheme() })
  // Reset so mermaid re-processes them
  for (const node of nodes) {
    node.removeAttribute('data-processed')
    // Restore raw source when re-rendering (mermaid replaces content with SVG)
    if (node.dataset.source) node.innerHTML = node.dataset.source
  }
  // Store raw source for future re-renders (e.g. theme change)
  for (const node of nodes) {
    if (!node.dataset.source) node.dataset.source = node.innerHTML
  }
  await mermaid.run({ nodes: Array.from(nodes) })
}

function runMermaid() {
  mermaidRun = renderMermaid()
  return mermaidRun
}

watch(
  () => props.theme,
  () => {
    // renderMermaid re-initialises with the current theme (only when diagrams exist).
    nextTick(() => runMermaid())
    // Forward the new theme into the HTML preview (no-op when not HTML).
    postThemeToFrame()
  }
)

watch(
  () => renderedHtml.value,
  async () => {
    await nextTick()
    applyCommentHighlights()
    runMermaid()
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
  window.addEventListener('message', onFrameMessage)
  nextTick(() => {
    applyCommentHighlights()
    runMermaid()
    alignToFragment({ initial: true })
  })
})

onUnmounted(() => {
  window.removeEventListener('message', onFrameMessage)
  revokeObjectUrl()
  realignCleanup?.()
  if (anchorTimer) clearTimeout(anchorTimer)
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

function applySelectionHighlight(range: Range) {
  clearSelectionHighlight()
  if (typeof Highlight !== 'undefined' && CSS.highlights) {
    CSS.highlights.set('preview-selection', new Highlight(range))
  }
}

function clearSelectionHighlight() {
  if (typeof Highlight !== 'undefined' && CSS.highlights) {
    CSS.highlights.delete('preview-selection')
  }
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

  // Persist the visual highlight so it survives focus moving to the popover textarea
  applySelectionHighlight(range.cloneRange())

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
  clearSelectionHighlight()
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed) {
    emit('selection-clear')
  }
}

function scrollToLine(line: number) {
  // HTML preview lives in a sandboxed iframe — we can't reach into its DOM, so
  // ask the injected bridge to scroll to the text of the target source line.
  if (isHtml.value) {
    const frame = frameRef.value
    const srcLine = (props.content.split('\n')[line] || '').trim()
    if (frame?.contentWindow && srcLine) {
      frame.contentWindow.postMessage({ __mdreview: true, type: 'scroll', text: srcLine }, '*')
    }
    return
  }

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

defineExpose({ scrollToLine, clearSelectionHighlight })
</script>

<template>
  <iframe
    v-if="isHtml"
    ref="frameRef"
    class="html-frame"
    title="HTML preview"
    sandbox="allow-scripts allow-popups allow-forms"
    :src="frameUrl"
    @load="onFrameLoad"
  />
  <div
    v-else
    ref="containerRef"
    :class="['preview-pane', { 'markdown-body': isGithubTheme, 'github-mode': isGithubTheme }]"
    @mouseup="onMouseUp"
    @mousedown="onMouseDown"
    @click="onPreviewClick"
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

.html-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
  display: block;
}

.preview-pane:not(.github-mode) :deep(h1) {
  font-family: var(--font-heading);
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 24px 0 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.preview-pane:not(.github-mode) :deep(h2) {
  font-family: var(--font-heading);
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 20px 0 10px;
}

.preview-pane:not(.github-mode) :deep(h3) {
  font-family: var(--font-heading);
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 16px 0 8px;
}

.preview-pane:not(.github-mode) :deep(p) {
  color: var(--text-secondary);
  margin: 0 0 12px;
}

.preview-pane:not(.github-mode) :deep(ul),
.preview-pane:not(.github-mode) :deep(ol) {
  color: var(--text-secondary);
  padding-left: 24px;
  margin: 0 0 12px;
}

.preview-pane:not(.github-mode) :deep(li) {
  margin: 4px 0;
}

.preview-pane:not(.github-mode) :deep(code) {
  font-family: var(--font-mono);
  background: var(--bg-code, var(--bg-page));
  padding: 2px 5px;
  border-radius: 3px;
  font-size: 13px;
}

.preview-pane:not(.github-mode) :deep(pre) {
  background: var(--bg-code, var(--bg-page));
  border: 1px solid var(--border);
  padding: 12px;
  border-radius: 6px;
  margin: 0 0 12px;
  overflow-x: auto;
}

.preview-pane:not(.github-mode) :deep(pre code) {
  background: none;
  padding: 0;
}

.preview-pane:not(.github-mode) :deep(strong) {
  color: var(--text-primary);
}

.preview-pane:not(.github-mode) :deep(blockquote) {
  border-left: 3px solid var(--border);
  padding-left: 16px;
  color: var(--text-muted);
  margin: 0 0 12px;
}

.preview-pane:not(.github-mode) :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 24px 0;
}

.preview-pane:not(.github-mode) :deep(a) {
  color: var(--accent);
  text-decoration: none;
}

.preview-pane:not(.github-mode) :deep(a:hover) {
  text-decoration: underline;
}

.preview-pane:not(.github-mode) :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0 0 12px;
  font-size: 14px;
}

.preview-pane:not(.github-mode) :deep(th),
.preview-pane:not(.github-mode) :deep(td) {
  border: 1px solid var(--border);
  padding: 8px 12px;
  text-align: left;
}

.preview-pane:not(.github-mode) :deep(th) {
  background: var(--bg-page);
  font-weight: 600;
  color: var(--text-primary);
}

.preview-pane:not(.github-mode) :deep(tbody tr:nth-child(even)) {
  background: var(--bg-page);
}

.preview-pane:not(.github-mode) :deep(tbody tr:hover) {
  background: var(--comment-bg);
}

.preview-pane :deep(.comment-highlight) {
  background: var(--comment-bg);
  border-left: 2px solid var(--accent);
  padding-left: 8px;
  margin-left: -10px;
}

/* YAML frontmatter table */
.preview-pane :deep(.frontmatter) {
  font-size: 13px;
  margin-bottom: 20px;
  opacity: 0.85;
}

.preview-pane :deep(.frontmatter td:first-child) {
  font-weight: 600;
  white-space: nowrap;
  color: var(--text-primary);
}

/* Mermaid diagrams */
.preview-pane :deep(.mermaid) {
  text-align: center;
  margin: 12px 0;
}

.preview-pane :deep(.mermaid svg) {
  max-width: 100%;
}

/* highlight.js token colours — mapped to theme CSS custom properties */
.preview-pane:not(.github-mode) :deep(.hljs-keyword),
.preview-pane:not(.github-mode) :deep(.hljs-selector-tag),
.preview-pane:not(.github-mode) :deep(.hljs-tag) {
  color: var(--accent);
  font-weight: 500;
}

.preview-pane:not(.github-mode) :deep(.hljs-string),
.preview-pane:not(.github-mode) :deep(.hljs-attr),
.preview-pane:not(.github-mode) :deep(.hljs-selector-attr) {
  color: var(--text-secondary);
}

.preview-pane:not(.github-mode) :deep(.hljs-comment),
.preview-pane:not(.github-mode) :deep(.hljs-quote) {
  color: var(--text-muted);
  font-style: italic;
}

.preview-pane:not(.github-mode) :deep(.hljs-number),
.preview-pane:not(.github-mode) :deep(.hljs-literal) {
  color: var(--accent);
  opacity: 0.85;
}

.preview-pane:not(.github-mode) :deep(.hljs-function),
.preview-pane:not(.github-mode) :deep(.hljs-title),
.preview-pane:not(.github-mode) :deep(.hljs-title\.function_) {
  color: var(--text-primary);
  font-weight: 600;
}

.preview-pane:not(.github-mode) :deep(.hljs-built_in),
.preview-pane:not(.github-mode) :deep(.hljs-class) {
  color: var(--text-primary);
  opacity: 0.9;
}

.preview-pane:not(.github-mode) :deep(.hljs-type),
.preview-pane:not(.github-mode) :deep(.hljs-selector-class) {
  color: var(--text-secondary);
  font-weight: 500;
}

.preview-pane:not(.github-mode) :deep(.hljs-variable),
.preview-pane:not(.github-mode) :deep(.hljs-template-variable) {
  color: var(--text-secondary);
}

.preview-pane:not(.github-mode) :deep(.hljs-meta),
.preview-pane:not(.github-mode) :deep(.hljs-meta-keyword) {
  color: var(--text-muted);
}

.preview-pane:not(.github-mode) :deep(.hljs-punctuation),
.preview-pane:not(.github-mode) :deep(.hljs-operator) {
  color: var(--text-muted);
}

/* h4 / h5 / h6 */
.preview-pane:not(.github-mode) :deep(h4) {
  font-family: var(--font-heading);
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 14px 0 6px;
}

.preview-pane:not(.github-mode) :deep(h5) {
  font-family: var(--font-heading);
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 12px 0 6px;
}

.preview-pane:not(.github-mode) :deep(h6) {
  font-family: var(--font-heading);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin: 10px 0 6px;
}

/* Images */
.preview-pane:not(.github-mode) :deep(img) {
  max-width: 100%;
  border-radius: 6px;
  display: block;
  margin: 12px auto;
}

/* Task list checkboxes */
.preview-pane:not(.github-mode) :deep(.contains-task-list) {
  list-style: none;
  padding-left: 4px;
}

.preview-pane:not(.github-mode) :deep(.task-list-item) {
  list-style: none;
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.preview-pane:not(.github-mode) :deep(.task-list-item input[type='checkbox']) {
  appearance: auto;
  margin: 0;
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  accent-color: var(--accent);
  cursor: default;
}

.preview-pane:not(.github-mode) :deep(.task-list-item input[type='checkbox']:checked + span),
.preview-pane:not(.github-mode) :deep(.task-list-item input[type='checkbox']:checked ~ *) {
  color: var(--text-muted);
  text-decoration: line-through;
  text-decoration-color: var(--text-muted);
}
</style>

<style>
::highlight(preview-selection) {
  background-color: color-mix(in srgb, var(--accent) 25%, transparent);
}
</style>

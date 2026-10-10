<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import type { Comment, ThemeMode, ContentType } from '@/types'
import { useMarkdown } from '@/composables/useMarkdown'
import { isGithub, isDark, isLocus, themeStyle } from '@/composables/useTheme'
import { findLineRange } from '@/composables/useHtmlSource'
import '@/styles/preview.css'
import { useRouter, scrollToAnchorElement, findAnchorIn } from '@/composables/useRouter'

const props = withDefaults(defineProps<{
  content: string
  comments: Comment[]
  theme?: ThemeMode
  contentType?: ContentType
  /**
   * Selections raise the comment flow (#2: review mode only). When false a
   * selection is plain browser selection: no events, no persisted highlight.
   */
  commenting?: boolean
}>(), { theme: undefined, contentType: undefined, commenting: true })

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

// Locus diagrams (#1 rule 12): mermaid's `base` theme fed brand colours, the
// six series colours for pie slices / cScale / xy plots.
const LOCUS_SERIES = ['#B066FF', '#3264FF', '#14B4EF', '#00D273', '#FF9F00', '#FF6429']

function locusThemeVariables(dark: boolean): Record<string, unknown> {
  const series: Record<string, string> = {}
  LOCUS_SERIES.forEach((c, i) => {
    series[`pie${i + 1}`] = c
    series[`cScale${i}`] = c
  })
  const tone = dark
    ? {
        background: '#280A38', primaryColor: '#533B60', mainBkg: '#533B60',
        primaryTextColor: '#FFFFFF', titleColor: '#FFFFFF', textColor: '#FFFFFF', nodeTextColor: '#FFFFFF',
        lineColor: '#E6E1DA', clusterBkg: '#280A38', clusterBorder: '#533B60', edgeLabelBackground: '#280A38',
      }
    : {
        background: '#FFFFFF', primaryColor: '#F3F0EB', mainBkg: '#F3F0EB',
        primaryTextColor: '#280A38', titleColor: '#280A38', textColor: '#533B60', nodeTextColor: '#280A38',
        lineColor: '#533B60', clusterBkg: '#FFFFFF', clusterBorder: '#E6E1DA', edgeLabelBackground: '#FFFFFF',
      }
  return {
    darkMode: dark,
    fontFamily: 'Montserrat, Arial, sans-serif',
    primaryBorderColor: '#B066FF',
    nodeBorder: '#B066FF',
    ...tone,
    ...series,
    // Full-strength slices separated by the page colour (no black outlines).
    pieOpacity: '1',
    pieStrokeColor: tone.background,
    pieOuterStrokeColor: tone.background,
    pieTitleTextColor: tone.primaryTextColor,
    pieLegendTextColor: tone.textColor,
    // Slice labels in deep purple read on every series colour (bold in CSS).
    pieSectionTextColor: '#280A38',
    // Sequence-diagram notes as cream / purple-grey cards with a brand edge.
    noteBkgColor: dark ? '#533B60' : '#F3F0EB',
    noteBorderColor: '#B066FF',
    noteTextColor: tone.primaryTextColor,
    // xy charts default to a white canvas with black axes: follow the page.
    xyChart: {
      plotColorPalette: LOCUS_SERIES.join(', '),
      backgroundColor: tone.background,
      titleColor: tone.primaryTextColor,
      xAxisLabelColor: tone.textColor, xAxisTitleColor: tone.textColor,
      xAxisTickColor: tone.lineColor, xAxisLineColor: tone.lineColor,
      yAxisLabelColor: tone.textColor, yAxisTitleColor: tone.textColor,
      yAxisTickColor: tone.lineColor, yAxisLineColor: tone.lineColor,
    },
  }
}

function mermaidConfig(): { theme: 'dark' | 'neutral' | 'base'; themeVariables?: Record<string, unknown> } {
  const t = props.theme ?? 'light'
  if (isLocus(t)) return { theme: 'base', themeVariables: locusThemeVariables(isDark(t)) }
  return { theme: isDark(t) ? 'dark' : 'neutral' }
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
    // __mdreview_style (#1) names the app's style; stamped as a signal only.
    if(d.__mdreview_theme === 'dark' || d.__mdreview_theme === 'light'){
      document.documentElement.setAttribute('data-theme', d.__mdreview_theme);
      if(d.__mdreview_style === 'default' || d.__mdreview_style === 'github' || d.__mdreview_style === 'locus'){
        document.documentElement.setAttribute('data-theme-style', d.__mdreview_style);
      }
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
  if (win) win.postMessage({ __mdreview_theme: currentThemeName(), __mdreview_style: themeStyle(props.theme ?? 'light') }, '*')
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
    if (!props.commenting) return
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

let mermaidSeq = 0

async function renderMermaid() {
  const container = containerRef.value
  if (!container) return
  const nodes = container.querySelectorAll<HTMLElement>('.mermaid')
  if (!nodes.length) return
  const mermaid = await loadMermaid()
  // Re-check: the document may have changed while the library was loading.
  if (!containerRef.value || !containerRef.value.querySelector('.mermaid')) return
  const config = mermaidConfig()
  const key = JSON.stringify(config)
  mermaid.initialize({ startOnLoad: false, ...config })
  for (const node of nodes) {
    // The first render keeps the raw source for later ones (e.g. theme change).
    node.dataset.source ??= node.textContent ?? ''
    // Already drawn with this source and theme: nothing to do.
    if (node.dataset.renderedKey === key) continue
    try {
      const { svg, bindFunctions } = await mermaid.render(`mermaid-${++mermaidSeq}`, node.dataset.source)
      if (!node.isConnected) continue
      // Swap in one assignment: a diagram is never shown empty or half-built,
      // and a re-render replaces the old SVG instead of stacking on it.
      node.innerHTML = svg
      bindFunctions?.(node)
      node.dataset.renderedKey = key
      node.setAttribute('data-processed', 'true')
    } catch (e) {
      if (!node.isConnected) continue
      const msg = document.createElement('pre')
      msg.className = 'mermaid-error'
      msg.textContent = `Diagram error: ${e instanceof Error ? e.message : String(e)}`
      node.replaceChildren(msg)
      delete node.dataset.renderedKey
    }
  }
}

// Renders run one at a time (a theme flip mid-render must not interleave two
// runs on the same nodes); calls made while one is queued coalesce into it, and
// each run reads the theme current when it starts.
let mermaidQueued = false
function runMermaid() {
  if (mermaidQueued) return mermaidRun
  mermaidQueued = true
  mermaidRun = mermaidRun.catch(() => {}).then(() => {
    mermaidQueued = false
    return renderMermaid()
  })
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
  if (!props.commenting) return
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
.html-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
  display: block;
}
</style>

<style>
::highlight(preview-selection) {
  background-color: color-mix(in srgb, var(--accent) 25%, transparent);
}

html.locus-theme ::highlight(preview-selection) {
  background-color: var(--selection-bg);
}
</style>

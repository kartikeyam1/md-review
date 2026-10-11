<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted, inject } from 'vue'
import type { Comment, ThemeMode, ContentType } from '@/types'
import { useMarkdown } from '@/composables/useMarkdown'
import { isGithub, isDark, themeStyle } from '@/composables/useTheme'
import { findLineRange } from '@/composables/useHtmlSource'
import '@/styles/preview.css'
import { useRouter, scrollToAnchorElement, findAnchorIn, encodeFilePath } from '@/composables/useRouter'
import { DOC_STATE } from '@/composables/useDocState'
import { copyText } from '@/composables/useCopyLink'
import { toast } from '@/composables/useToast'
import { runEnhancers } from '@/preview/enhancers'
import { buildAnchors, lineToOffset, offsetToLine, type Anchor } from '@/composables/useScrollSync'
import { mermaidConfigFor, mermaidJob, fixAuthorFillContrast, type MermaidThemeConfig } from '@/preview/mermaidTheme'

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
  /**
   * #7 rule 6: an HTML doc reloads its iframe at most once per this many ms of
   * edits (trailing). 0 = on every change (read view).
   */
  reloadDelay?: number
  /**
   * #28: show agent-only sections (agent view, split view's preview). False =
   * the human view: they leave no DOM, and targeting one asks for the agent
   * view (`reveal-agent`, rule 12).
   */
  agentView?: boolean
  /** Show a leading front-matter block as its Field/Value table (off on a viewer's publish-mode reading page). */
  frontMatter?: boolean
  /**
   * Rendered outside a doc (#27's template picker preview): links never
   * navigate the app (an in-page `#anchor` scrolls inside the preview), no
   * enhancers (section links, reactions), no URL-fragment alignment, and the
   * HTML frame's anchor messages are ignored.
   */
  standalone?: boolean
}>(), { theme: undefined, contentType: undefined, commenting: true, reloadDelay: 0, agentView: false, frontMatter: true, standalone: false })

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

// Mermaid theme per app theme (#1 rule 12, #5 rule 13): shared with the #19 export.
function mermaidConfig(): MermaidThemeConfig {
  return mermaidConfigFor(props.theme ?? 'light')
}

const emit = defineEmits<{
  selection: [payload: {
    startLine: number
    endLine: number
    selectedText: string
    coords: { x: number; y: number }
  }]
  'selection-clear': []
  /** #28 rule 12: a fragment or scroll target is inside a hidden agent section. */
  'reveal-agent': []
}>()

const { renderWithHeadings } = useMarkdown()
const containerRef = ref<HTMLElement | null>(null)
const frameRef = ref<HTMLIFrameElement | null>(null)
const isGithubTheme = computed(() => isGithub(props.theme ?? 'light'))
const isHtml = computed(() => props.contentType === 'html')

// renderHtml now injects data-line-start/data-line-end via the markdown-it plugin
const rendered = computed(() => renderWithHeadings(props.content, { agentView: props.agentView ? 'agent' : 'human', frontMatter: props.frontMatter }))
const renderedHtml = computed(() => rendered.value.html)

// ── Preview enhancers (00 §4.5): run after every render ─────────────────────
const docState = inject(DOC_STATE, null)
let enhancerCleanup: (() => void) | null = null

/** #3 rule 17: the section's link — <origin><base>d/<slug||id>#<id>, or this page's URL for a local doc. */
function sectionLink(id: string): string {
  const frag = `#${encodeURIComponent(id)}`
  const shared = docState?.docLink.value
  const r = docState?.route.value
  // #26: on a file route the section is in that file — /d/<doc>/<file>#<id>
  if (shared) return (r?.kind === 'file' ? `${shared}/${encodeFilePath(r.file)}` : shared) + frag
  const u = new URL(window.location.href)
  u.searchParams.delete('edit')
  u.searchParams.delete('view')
  u.hash = ''
  return u.href + frag
}

async function copySectionLink(id: string) {
  // The address bar shows the link either way (replaceState: no Back step);
  // the reader is already at the heading, so no scroll ('frame' = handled here).
  router.setFragment(id, 'replace', 'frame')
  if (await copyText(sectionLink(id))) toast.info('Link copied')
  else toast.error('Couldn\'t copy — the link is in the address bar')
}

function enhance() {
  enhancerCleanup?.()
  enhancerCleanup = null
  const container = containerRef.value
  if (container && !props.standalone) enhancerCleanup = runEnhancers(container, { headings: rendered.value.headings, docState, router, toast, copyText, copySectionLink })
}

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
  // Split view's synced scrolling (#7 rule 9): proportional, both ways. A
  // scroll the parent asked for is not reported back (no feedback loop), and
  // reports go out at most once per frame.
  function maxY(){ var el = document.scrollingElement || document.documentElement; return Math.max(0, el.scrollHeight - innerHeight); }
  var echoY = -1, scrollQueued = false;
  window.addEventListener('scroll', function(){
    if(scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(function(){
      scrollQueued = false;
      var y = window.scrollY, ours = echoY >= 0 && Math.abs(y - echoY) < 2;
      echoY = -1;
      if(ours) return;
      var m = maxY();
      send({type:'scroll-ratio', ratio: m > 0 ? Math.min(1, Math.max(0, y / m)) : 0});
    });
  }, {passive:true});
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
    if(d.__mdreview && d.type==='scroll-ratio' && typeof d.ratio === 'number' && isFinite(d.ratio)){
      var top = Math.round(Math.min(1, Math.max(0, d.ratio)) * maxY());
      if(Math.abs(window.scrollY - top) < 1) return;
      try { window.scrollTo({top: top, behavior: 'instant'}); } catch(err){ window.scrollTo(0, top); }
      echoY = window.scrollY;
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

function loadFrameDoc(doc: string) {
  revokeObjectUrl()
  if (!doc) {
    frameUrl.value = ''
    return
  }
  objectUrl = URL.createObjectURL(new Blob([doc], { type: 'text/html' }))
  frameUrl.value = objectUrl
}

// ── Scroll ratio (#7 rule 9) ────────────────────────────────────────────────
/** The HTML document's last known scroll ratio (reported by the bridge or set by us). */
let frameRatio = 0
/** Which document the frame shows: another doc starts at its top (or its #fragment), never at the last one's ratio. */
const docIdentity = () => `${docState?.screenKey.value ?? ''}|${docState?.pasteId.value ?? ''}`
let frameDocIdentity = docIdentity()

// #7 rule 6: while typing in split view the iframe reloads at most once per
// `reloadDelay` ms (trailing) instead of on every keystroke. Another document
// loads at once.
let frameReloadTimer: ReturnType<typeof setTimeout> | null = null

watch(
  frameDoc,
  (doc) => {
    if (frameReloadTimer) { clearTimeout(frameReloadTimer); frameReloadTimer = null }
    const identity = docIdentity()
    const sameDoc = identity === frameDocIdentity
    frameDocIdentity = identity
    if (!sameDoc) frameRatio = 0
    if (sameDoc && props.reloadDelay > 0 && frameUrl.value && doc) {
      frameReloadTimer = setTimeout(() => { frameReloadTimer = null; loadFrameDoc(frameDoc.value) }, props.reloadDelay)
      return
    }
    loadFrameDoc(doc)
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
  // #7 rule 7: a reload starts at the top — put the document back where it was.
  if (frameRatio > 0) postRatioToFrame(frameRatio)
}

function postRatioToFrame(ratio: number) {
  frameRef.value?.contentWindow?.postMessage({ __mdreview: true, type: 'scroll-ratio', ratio }, '*')
}

// ── Anchors / URL fragment (spec #4 rules 12–15) ─────────────────────────────
const router = useRouter()

/** Parent -> frame: scroll the HTML doc to the URL's fragment. */
function postAnchorToFrame(smooth: boolean) {
  if (props.standalone) return
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
  if (!container) return
  if (props.standalone) { standaloneLinkClick(e, container); return }
  router.handleLinkClick(e, container, scrollReaderTo)
}

/** Standalone: a link never leaves the preview; an in-page `#anchor` scrolls to its target inside it. */
function standaloneLinkClick(e: MouseEvent, container: HTMLElement) {
  const a = (e.target as Element | null)?.closest?.('a[href]')
  if (!a || !container.contains(a)) return
  e.preventDefault()
  const href = a.getAttribute('href') || ''
  if (!href.startsWith('#')) return
  let id = href.slice(1)
  try { id = decodeURIComponent(id) } catch { /* keep it raw */ }
  findAnchor(container, id)?.scrollIntoView({ block: 'nearest' })
}

// Rule 14: after the first render, put the fragment's target at the top of the
// reading area; if mermaid/images shift the layout and the reader has not
// scrolled meanwhile, re-align once (within 3 s).
let mermaidRun: Promise<unknown> = Promise.resolve()
let realignCleanup: (() => void) | null = null

function alignToFragment(opts: { initial: boolean }) {
  if (props.standalone) return
  if (isHtml.value) { postAnchorToFrame(!opts.initial); return }
  const container = containerRef.value
  if (!container) return
  const id = router.current.value.fragment
  if (!id) {
    if (!opts.initial) scrollReaderTo(container)
    return
  }
  const el = findAnchor(container, id)
  if (!el) {
    // #28 rule 12: the heading is inside a hidden agent section — show the agent view, then align.
    if (!props.agentView && rendered.value.hiddenIds.includes(id)) requestReveal({ fragment: id })
    return
  }
  scrollToAnchorElement(el, { smooth: !opts.initial })
  // A later jump (TOC click, in-doc link) re-aligns too while diagrams/images above can still move it.
  if (opts.initial || layoutPending(container)) scheduleRealign(id)
}

/** Diagrams not drawn yet or images still loading: the layout above an anchor may still shift. */
function layoutPending(container: HTMLElement): boolean {
  return [...container.querySelectorAll<HTMLElement>('.mermaid')].some((m) => !m.dataset.renderedKey && !m.querySelector('.mermaid-error'))
    || [...container.querySelectorAll('img')].some((img) => !img.complete)
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
  // The page's load event too: the browser's own fragment scroll can land on an
  // app element with the same id (a heading named `app`) after ours.
  const loaded = document.readyState === 'complete' ? null : new Promise((done) => window.addEventListener('load', done, { once: true }))
  const settled = Promise.all([mermaidRun.catch(() => {}), ...images, loaded])
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
  // After a history/fragment navigation the browser does its own fragment scroll
  // once our handler has run — to the first element with that id in the whole
  // page (`#app` is the app root). Align on the next frame so ours wins.
  if (loc.source === 'pop') requestAnimationFrame(() => alignToFragment({ initial: false }))
  else alignToFragment({ initial: false })
})

function onFrameMessage(e: MessageEvent) {
  const frame = frameRef.value
  if (!frame || e.source !== frame.contentWindow) return
  const data: any = e.data
  if (!data || data.__mdreview !== true) return

  if (data.type === 'anchor-changed') {
    if (props.standalone) return
    const id = data.id
    if (typeof id === 'string' && id.length <= 256) queueFrameAnchor(id)
    return
  }
  if (data.type === 'selection-clear') {
    emit('selection-clear')
    return
  }
  if (data.type === 'scroll-ratio') {
    const r = Number(data.ratio)
    if (!Number.isFinite(r)) return
    frameRatio = Math.min(1, Math.max(0, r))
    // The iframe scrolled (by the reader): surface it as a scroll event on the
    // frame element, where split view's scroll sync listens (#7).
    frame.dispatchEvent(new Event('scroll'))
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

// #5 rule 13: printing a dark-themed doc swaps every diagram for a light
// rendering on `beforeprint` and back on `afterprint`. Both renderings are kept
// per node, and the light one is prepared in idle time after a dark render, so
// the swap is synchronous (the browser snapshots right after beforeprint).
type MermaidTarget = 'screen' | 'print'
const svgCache = new WeakMap<HTMLElement, Partial<Record<MermaidTarget, { key: string; svg: string; bind?: (el: Element) => void }>>>()
let printing = false

function printMermaidConfig(): MermaidThemeConfig {
  return mermaidConfigFor(props.theme ?? 'light', true)
}

function printNeedsLightDiagrams(): boolean {
  return isDark(props.theme ?? 'light')
}

async function renderMermaid(target: MermaidTarget) {
  const container = containerRef.value
  if (!container) return
  const nodes = container.querySelectorAll<HTMLElement>('.mermaid')
  if (!nodes.length) return
  const mermaid = await loadMermaid()
  // Re-check: the document may have changed while the library was loading.
  if (!containerRef.value || !containerRef.value.querySelector('.mermaid')) return
  const config = target === 'print' ? printMermaidConfig() : mermaidConfig()
  const key = JSON.stringify(config)
  mermaid.initialize({ startOnLoad: false, ...config })
  for (const node of nodes) {
    // The first render keeps the raw source for later ones (e.g. theme change).
    node.dataset.source ??= node.textContent ?? ''
    const cache = svgCache.get(node) ?? {}
    svgCache.set(node, cache)
    if (target === 'print') {
      // Light copy for print; shown now only while printing.
      if (cache.print?.key !== key) {
        try {
          const { svg } = await mermaid.render(`mermaid-${++mermaidSeq}`, node.dataset.source)
          cache.print = { key, svg }
        } catch { continue }
      }
      if (printing && node.isConnected) { node.innerHTML = cache.print.svg; fixAuthorFillContrast(node); node.dataset.printShown = '1' }
      continue
    }
    // Printing ended without an afterprint (some PDF paths): put the screen drawing back.
    if (!printing && node.dataset.printShown && cache.screen) {
      node.innerHTML = cache.screen.svg
      fixAuthorFillContrast(node)
      cache.screen.bind?.(node)
      delete node.dataset.printShown
    }
    // Already drawn with this source and theme: nothing to do.
    if (node.dataset.renderedKey === key) continue
    try {
      const { svg, bindFunctions } = await mermaid.render(`mermaid-${++mermaidSeq}`, node.dataset.source)
      if (!node.isConnected) continue
      // Swap in one assignment: a diagram is never shown empty or half-built,
      // and a re-render replaces the old SVG instead of stacking on it.
      node.innerHTML = svg
      fixAuthorFillContrast(node)
      bindFunctions?.(node)
      node.dataset.renderedKey = key
      node.setAttribute('data-processed', 'true')
      cache.screen = { key, svg, bind: bindFunctions }
    } catch (e) {
      if (!node.isConnected) continue
      const msg = document.createElement('pre')
      msg.className = 'mermaid-error'
      msg.textContent = `Diagram error: ${e instanceof Error ? e.message : String(e)}`
      node.replaceChildren(msg)
      delete node.dataset.renderedKey
      delete cache.screen
    }
  }
  if (target === 'screen' && printNeedsLightDiagrams()) schedulePrintPrepare()
}

// Renders run one at a time (a theme flip mid-render must not interleave two
// runs on the same nodes); calls made while one is queued coalesce into it, and
// each run reads the theme current when it starts.
const mermaidQueued: Record<MermaidTarget, boolean> = { screen: false, print: false }
function runMermaid(target: MermaidTarget = 'screen') {
  if (mermaidQueued[target]) return mermaidRun
  mermaidQueued[target] = true
  mermaidRun = mermaidJob(() => {
    mermaidQueued[target] = false
    return renderMermaid(target)
  })
  return mermaidRun
}

let prepareHandle: number | null = null
function schedulePrintPrepare() {
  if (prepareHandle !== null) return
  const run = () => { prepareHandle = null; runMermaid('print') }
  prepareHandle = typeof requestIdleCallback === 'function'
    ? requestIdleCallback(run, { timeout: 2000 }) as unknown as number
    : window.setTimeout(run, 500)
}

function onBeforePrint() {
  if (!printNeedsLightDiagrams()) return
  printing = true
  const container = containerRef.value
  for (const node of container?.querySelectorAll<HTMLElement>('.mermaid') ?? []) {
    const light = svgCache.get(node)?.print
    if (light) { node.innerHTML = light.svg; node.dataset.printShown = '1' }
  }
  // Anything not prepared yet is drawn now (in time for a PDF export, best effort for a quick Ctrl+P).
  runMermaid('print')
}

function onAfterPrint() {
  if (!printing) return
  printing = false
  const container = containerRef.value
  for (const node of container?.querySelectorAll<HTMLElement>('.mermaid') ?? []) {
    const screen = svgCache.get(node)?.screen
    if (screen) { node.innerHTML = screen.svg; screen.bind?.(node) }
    delete node.dataset.printShown
  }
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

// ── #28 rule 12: reveal a target inside a hidden agent section ──────────────
// The parent switches to the agent view (replaceState, fragment kept); once the
// sections render, the pending target is aligned / scrolled to.
let pendingReveal: { fragment?: string; line?: number } | null = null
function requestReveal(target: { fragment?: string; line?: number }) {
  pendingReveal = target
  emit('reveal-agent')
}
function flushReveal() {
  const target = pendingReveal
  if (!target || !props.agentView) return
  pendingReveal = null
  if (target.fragment !== undefined) {
    if (router.current.value.fragment === target.fragment) alignToFragment({ initial: true })
  } else if (target.line !== undefined) scrollToLine(target.line)
}

// Bumped after every render (invalidates the scroll-sync anchors, #7).
let renderSeq = 0

watch(
  () => renderedHtml.value,
  async () => {
    await nextTick()
    renderSeq++
    enhance()
    applyCommentHighlights()
    runMermaid()
    flushReveal()
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
  window.addEventListener('beforeprint', onBeforePrint)
  window.addEventListener('afterprint', onAfterPrint)
  nextTick(() => {
    enhance()
    applyCommentHighlights()
    runMermaid()
    alignToFragment({ initial: true })
  })
})

onUnmounted(() => {
  window.removeEventListener('message', onFrameMessage)
  window.removeEventListener('beforeprint', onBeforePrint)
  window.removeEventListener('afterprint', onAfterPrint)
  if (prepareHandle !== null) {
    if (typeof cancelIdleCallback === 'function') cancelIdleCallback(prepareHandle)
    else clearTimeout(prepareHandle)
  }
  revokeObjectUrl()
  realignCleanup?.()
  enhancerCleanup?.()
  if (anchorTimer) clearTimeout(anchorTimer)
  if (frameReloadTimer) clearTimeout(frameReloadTimer)
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

/**
 * The range narrowed to the text it actually selects. A triple-click selects a
 * paragraph up to offset 0 of the next block; without this the comment would
 * anchor on (and highlight) that next block too.
 */
function textExtent(range: Range): Range {
  const root = range.commonAncestorContainer
  const walker = document.createTreeWalker(root.nodeType === Node.TEXT_NODE ? root.parentNode! : root, NodeFilter.SHOW_TEXT)
  let first: { node: Text; start: number } | null = null
  let last: { node: Text; end: number } | null = null
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!range.intersectsNode(n)) continue
    const start = n === range.startContainer ? range.startOffset : 0
    const end = n === range.endContainer ? range.endOffset : n.length
    if (!n.data.slice(start, end).trim()) continue
    first ??= { node: n, start }
    last = { node: n, end }
  }
  if (!first || !last) return range
  const out = document.createRange()
  out.setStart(first.node, first.start)
  out.setEnd(last.node, last.end)
  return out
}

/** Controls enhancers add to the rendered doc (#17 fold toggles) are not text: no comment flow. */
const isPreviewControl = (e: MouseEvent) => !!(e.target as Element | null)?.closest?.('[data-preview-control]')

function onMouseUp(e: MouseEvent) {
  if (!props.commenting || isPreviewControl(e)) return
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

  const range = textExtent(selection.getRangeAt(0))
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

function onMouseDown(e: MouseEvent) {
  if (isPreviewControl(e)) return
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
  // #28 rule 12: a comment (or other target) inside a hidden agent section.
  if (!props.agentView && rendered.value.hiddenRanges.some((r) => line >= r.start && line <= r.end)) {
    requestReveal({ line })
    return
  }

  const annotated = container.querySelectorAll<HTMLElement>('[data-line-start]')
  for (const el of annotated) {
    const start = parseInt(el.getAttribute('data-line-start')!, 10)
    const end = parseInt(el.getAttribute('data-line-end')!, 10)
    if (line >= start && line < end) {
      // Enhancers that hide content (#17 folds, closed <details>) reveal the target first.
      el.dispatchEvent(new CustomEvent('preview-reveal', { bubbles: true }))
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
  }
}

// ── Scroll API for split view's synced scrolling (#7 rules 8, 9) ─────────────

/** The element that scrolls the markdown preview (null for an HTML doc: it scrolls inside the iframe). */
function scrollElement(): HTMLElement | null {
  return isHtml.value ? null : containerRef.value
}

// The line ↔ offset anchors, rebuilt when the render or the layout changed.
let anchorCache: { key: string; anchors: Anchor[] } | null = null

function anchors(): Anchor[] {
  const c = containerRef.value
  if (!c) return []
  const key = `${renderedHtml.value.length}:${c.scrollHeight}:${c.clientWidth}:${renderSeq}`
  if (anchorCache?.key === key) return anchorCache.anchors
  const base = c.getBoundingClientRect().top - c.scrollTop
  const blocks = [...c.querySelectorAll<HTMLElement>('[data-line-start]')].map((el) => {
    const r = el.getBoundingClientRect()
    return { start: Number(el.dataset.lineStart), end: Number(el.dataset.lineEnd), top: r.top - base, bottom: r.bottom - base, hidden: r.height === 0 && r.width === 0 }
  }).filter((b) => !b.hidden)
  anchorCache = { key, anchors: buildAnchors(blocks) }
  return anchorCache.anchors
}

/** The scrollTop that puts source line `line` (fractional) at the preview's top edge. */
function offsetForLine(line: number): number {
  return lineToOffset(anchors(), line)
}

/** The source line (fractional) at scroll offset `offset`. */
function lineAtOffset(offset: number): number {
  return offsetToLine(anchors(), offset)
}

/** HTML doc: the iframe's scroll ratio, last reported or set. */
function getRatio(): number {
  return frameRatio
}

/** HTML doc: scroll the iframe to `ratio` (the bridge does not report it back). */
function setRatio(ratio: number) {
  frameRatio = Math.min(1, Math.max(0, ratio))
  postRatioToFrame(frameRatio)
}

defineExpose({ scrollToLine, clearSelectionHighlight, scrollElement, offsetForLine, lineAtOffset, getRatio, setRatio })
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
    data-testid="preview-pane"
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

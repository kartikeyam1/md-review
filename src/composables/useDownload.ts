import type { ThemeMode } from '@/types'
import { isDark, isGithub, isLocus, themeStyle } from '@/composables/useTheme'
import { PASTE_API } from '@/composables/pasteApi'
import { useMarkdown } from '@/composables/useMarkdown'
import { loadFenceLanguages } from '@/markdown/highlight'
import { mermaidConfigFor, mermaidJob } from '@/preview/mermaidTheme'

// Downloads (#19): filenames, the blob + <a download> save, and the
// self-contained HTML export. Loaded on demand by downloadActions.ts, off the
// #6 entry chunk; the inlined CSS loads only when an HTML export runs.

// ── Filenames (rule 4) ───────────────────────────────────────────────────────
const MAX_STEM = 200
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[/\\:*?"<>|\u0000-\u001f\u007f]/g

/** The doc's filename made safe for a download: forbidden/control chars → "-", trimmed, blank → "document". */
export function sanitizeBase(name: string): string {
  // Trailing dots go too ("dot." → "dot"): never an empty extension, and Windows drops them anyway.
  const s = String(name ?? '').replace(FORBIDDEN, '-').trim().replace(/[.\s]+$/, '')
  return s || 'document'
}

/** The last extension (".md"), never a leading dot (".env" has none). */
function splitExt(name: string): [stem: string, ext: string] {
  const i = name.lastIndexOf('.')
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, '']
}

/** At most 200 characters (code points: an emoji is never cut in half). */
function cap(stem: string): string {
  const chars = Array.from(stem)
  return chars.length > MAX_STEM ? chars.slice(0, MAX_STEM).join('') : stem
}

export function mdFilename(name: string): string {
  const base = sanitizeBase(name)
  const [stem, ext] = splitExt(base)
  if (/^\.(md|markdown)$/i.test(ext)) return cap(stem) + ext
  if (/^\.txt$/i.test(ext)) return `${cap(stem)}.md`
  return `${cap(base)}.md`
}

export function htmlExportFilename(name: string): string {
  return `${cap(splitExt(sanitizeBase(name))[0])}.html`
}

export function htmlSourceFilename(name: string): string {
  const base = sanitizeBase(name)
  const [stem, ext] = splitExt(base)
  if (/^\.html?$/i.test(ext)) return cap(stem) + ext
  return `${cap(base)}.html`
}

// ── Saving (rule 10) ─────────────────────────────────────────────────────────
/** Exactly one download through an <a download> click; the object URL is revoked afterwards. */
export function saveBlob(content: BlobPart, type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  try {
    a.click()
  } finally {
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

// ── Self-contained HTML export (rule 7) ──────────────────────────────────────
/** The <html> and <main> classes the app uses for `theme` (useTheme.applyTheme, PreviewPane). */
export function exportThemeClasses(theme: ThemeMode): { htmlClass: string; themeStyle: string; mainClass: string } {
  const html: string[] = []
  if (isDark(theme)) html.push('dark')
  if (isGithub(theme)) html.push('github-theme')
  if (isLocus(theme)) html.push('locus-theme')
  return {
    htmlClass: html.join(' '),
    themeStyle: themeStyle(theme),
    mainClass: isGithub(theme) ? 'preview-pane markdown-body github-mode' : 'preview-pane',
  }
}

/** App chrome the export never carries (#14 toolbars, #17 fold controls, #3 anchors, #24 reactions). */
const STRIP = [
  '[data-export-strip]',
  '.heading-fold-toggle', '.heading-fold-ellipsis',
  '.heading-anchor',
  '.section-reactions', '.section-reaction-chip', '.section-reaction-trigger',
  'script',
].join(', ')
/** App bookkeeping attributes (render ranges, test ids, fold/zoom/mermaid state). */
const DROP_ATTRS = [
  'data-line-start', 'data-line-end', 'data-testid', 'data-fold-hidden', 'data-folded',
  'data-source', 'data-rendered-key', 'data-processed', 'data-print-shown', 'hidden',
]

function codeOf(source: string): HTMLElement {
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.textContent = source
  pre.appendChild(code)
  return pre
}

/**
 * Turn a copy of the rendered preview into export markup (rule 7b, 7d–7f), in
 * place: chrome removed, folds expanded, code blocks unwrapped, zoom/comment
 * state dropped, no scripts or inline handlers; drawn diagrams keep their SVG
 * and undrawn/failed ones become <pre><code> of their source. <details> stay.
 */
export function cleanExportDom(root: HTMLElement): void {
  root.querySelectorAll(STRIP).forEach((el) => el.remove())
  root.querySelectorAll('.code-block').forEach((el) => el.replaceWith(...el.childNodes))
  root.querySelectorAll<HTMLElement>('.mermaid').forEach((node) => {
    const drawn = !!node.querySelector(':scope > svg') && !node.querySelector('.mermaid-error')
    if (!drawn) node.replaceWith(codeOf((node.dataset.source ?? node.textContent ?? '').trim()))
  })
  for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    if (el.hasAttribute('data-zoomable')) {
      for (const a of ['data-zoomable', 'tabindex', 'role', 'aria-label']) el.removeAttribute(a)
    }
    for (const a of DROP_ATTRS) el.removeAttribute(a)
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name)) el.removeAttribute(a.name)
      else if ((a.name === 'href' || a.name === 'src' || a.name === 'xlink:href') && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name)
    }
    // Task-list boxes are a static record in the file, not controls.
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.setAttribute('disabled', '')
    if (el.classList.contains('comment-highlight')) {
      el.classList.remove('comment-highlight')
      if (!el.classList.length) el.removeAttribute('class')
    }
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;')

export function assembleHtmlDocument(o: { title: string; htmlClass: string; themeStyle: string; mainClass: string; css: string; body: string }): string {
  const css = o.css.replace(/<\/(style)/gi, '<\\/$1')
  const cls = o.htmlClass ? ` class="${escAttr(o.htmlClass)}"` : ''
  return '<!doctype html>\n'
    + `<html lang="en"${cls} data-theme-style="${escAttr(o.themeStyle)}">\n`
    + '<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + `<title>${esc(o.title)}</title>\n`
    + `<style>${css}</style>\n</head>\n`
    + `<body><main class="${escAttr(o.mainClass)}">${o.body}</main></body>\n</html>\n`
}

/** The page around the doc: the reading surface fills the page, the doc scrolls the page, no app header. */
const EXPORT_CSS = `
body { margin: 0; background: var(--bg-surface); color: var(--text-primary); }
:root .preview-pane { height: auto; min-height: 100vh; overflow: visible; box-sizing: border-box; }
.preview-pane [id] { scroll-margin-top: 12px; }
`

async function githubCss(theme: ThemeMode): Promise<string> {
  if (!isGithub(theme)) return ''
  const m = isDark(theme)
    ? await import('github-markdown-css/github-markdown-dark.css?inline')
    : await import('github-markdown-css/github-markdown-light.css?inline')
  return m.default
}

/** Selectors of app chrome that never reaches an export (rule 7e; code blocks are unwrapped): their rules are dropped. */
const CHROME_SELECTOR = /code-block|code-copy|code-toolbar|code-lang-label|heading-fold|heading-anchor|section-reaction|data-zoomable|zoom-trigger|comment-highlight/

/** Index just past the block that opens at `open` (the "{"), skipping quoted strings. */
function blockEnd(text: string, open: number): number {
  let depth = 0
  let quote = ''
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i + 1
  }
  return text.length
}

/** A selector list split at top-level commas (not inside :is(), :not(), attribute values). */
function splitSelectors(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) { out.push(list.slice(start, i).trim()); start = i + 1 }
  }
  out.push(list.slice(start).trim())
  return out.filter(Boolean)
}

/** The CSS without the rules (or the selectors of a list) that style app chrome; everything else verbatim. */
export function stripChromeCss(css: string): string {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let out = ''
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open < 0) { out += text.slice(i); break }
    let prelude = text.slice(i, open)
    const semi = prelude.lastIndexOf(';')
    if (semi >= 0) { out += prelude.slice(0, semi + 1); prelude = prelude.slice(semi + 1) }
    const end = blockEnd(text, open)
    const body = text.slice(open + 1, end - 1)
    const head = prelude.trim()
    if (/^@(media|supports|layer|container)\b/i.test(head)) {
      const inner = stripChromeCss(body)
      if (inner.trim()) out += `\n${head} {${inner}\n}`
    } else if (head.startsWith('@')) {
      out += `\n${head} {${body}}`
    } else {
      const kept = splitSelectors(head).filter((sel) => !CHROME_SELECTOR.test(sel))
      if (kept.length) out += `\n${kept.join(',\n')} {${body}}`
    }
    i = end
  }
  return out
}

/**
 * All CSS the current theme needs (rule 7c), inline — never a <link> or @import:
 * the app's theme tokens and base styles, github-markdown-css for GitHub
 * themes, the preview sheet (typography, hljs, tables, task lists, callouts,
 * RAG badges, <details>), the page frame, then the print sheet (rule 7h).
 */
export async function exportCss(theme: ThemeMode): Promise<string> {
  const [app, gh, preview, print] = await Promise.all([
    import('@/style.css?inline'),
    githubCss(theme),
    import('@/styles/preview.css?inline'),
    import('@/styles/print.css?inline'),
  ])
  return stripChromeCss([app.default, gh, preview.default, EXPORT_CSS, print.default].join('\n')).replace(/@import[^;]*;/g, '')
}

const DIAGRAM_WAIT_MS = 10_000

/** The key PreviewPane stamps on a diagram drawn for `theme` (data-rendered-key). */
export const diagramKey = (theme: ThemeMode) => JSON.stringify(mermaidConfigFor(theme))

/**
 * Wait for the preview's mermaid renders (rule 7d / 8): every diagram failed, or
 * drawn — for the current theme when `key` is given (just after a theme switch
 * the old drawing is still in place until its re-render lands) — up to 10 s.
 */
export async function diagramsSettled(root: ParentNode, ms = DIAGRAM_WAIT_MS, key?: string): Promise<void> {
  const pending = () => [...root.querySelectorAll<HTMLElement>('.mermaid')].some((m) => {
    if (m.querySelector('.mermaid-error')) return false
    if (!m.querySelector(':scope > svg')) return true
    return key !== undefined && m.dataset.renderedKey !== undefined && m.dataset.renderedKey !== key
  })
  const end = Date.now() + ms
  while (pending() && Date.now() < end) await new Promise((r) => setTimeout(r, 100))
}

/** No preview on screen (edit view): render the markdown and its diagrams off screen. */
async function renderOffscreen(markdown: string, theme: ThemeMode): Promise<{ el: HTMLElement; done: () => void }> {
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;visibility:hidden;pointer-events:none'
  const el = document.createElement('div')
  el.className = exportThemeClasses(theme).mainClass
  el.innerHTML = useMarkdown().renderWithHeadings(markdown).html
  host.appendChild(el)
  document.body.appendChild(host)
  const done = () => host.remove()
  const nodes = [...el.querySelectorAll<HTMLElement>('.mermaid')]
  try {
    if (nodes.length) {
      const mermaid = (await import('mermaid')).default
      await mermaidJob(async () => {
        mermaid.initialize({ startOnLoad: false, ...mermaidConfigFor(theme) })
        let seq = 0
        for (const node of nodes) {
          const source = node.textContent ?? ''
          node.dataset.source = source
          try {
            const { svg } = await mermaid.render(`mdr-export-${Date.now().toString(36)}-${++seq}`, source)
            node.innerHTML = svg
          } catch {
            node.replaceChildren(Object.assign(document.createElement('pre'), { className: 'mermaid-error' }))
          }
        }
      })
    }
  } catch (e) {
    done()
    throw e
  }
  return { el, done }
}

const MAX_INLINE_BYTES = 15 * 1024 * 1024
const IMAGE_TIMEOUT_MS = 10_000

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

/**
 * Rule 7g: backend (attachment) and relative images become data: URIs while the
 * total stays ≤ 15 MB; external images and failed fetches keep an absolute URL.
 */
export async function inlineImages(root: HTMLElement, opts: { apiBase?: string; maxBytes?: number } = {}): Promise<void> {
  const maxBytes = opts.maxBytes ?? MAX_INLINE_BYTES
  let apiOrigin = ''
  try { apiOrigin = new URL(opts.apiBase ?? PASTE_API, location.href).origin } catch { /* no backend */ }
  let total = 0
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? ''
    if (!src || /^data:/i.test(src)) continue
    let abs: URL
    try { abs = new URL(src, document.baseURI) } catch { continue }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue
    img.setAttribute('src', abs.href)
    img.removeAttribute('srcset')
    const relative = !/^[a-z][a-z\d+.-]*:|^\/\//i.test(src)
    if (!relative && abs.origin !== apiOrigin) continue
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), IMAGE_TIMEOUT_MS)
    try {
      const res = await fetch(abs.href, { signal: ctl.signal, credentials: 'omit' })
      if (!res.ok) continue
      // Past the cap by its declared size: never download it.
      const declared = Number(res.headers.get('content-length'))
      if (declared && total + declared > maxBytes) { ctl.abort(); continue }
      const blob = await res.blob()
      if (!blob.type.startsWith('image/') || total + blob.size > maxBytes) continue
      img.setAttribute('src', await readDataUrl(blob))
      total += blob.size
    } catch {
      /* keep the absolute URL */
    } finally {
      clearTimeout(timer)
    }
  }
}

/** The self-contained HTML file for the doc on screen (rule 7). `live` = the on-screen preview, if any. */
export async function buildHtmlExport(o: { live: HTMLElement | null; markdown: string; theme: ThemeMode; title: string }): Promise<string> {
  // Lazy highlight.js languages still on their way: wait, so the export has colours.
  // A macrotask later the live preview has re-rendered with them (highlightRevision).
  await loadFenceLanguages(o.markdown)
  if (o.live) await new Promise((r) => setTimeout(r))
  const off = o.live ? null : await renderOffscreen(o.markdown, o.theme)
  try {
    const source = o.live ?? off!.el
    await diagramsSettled(source, DIAGRAM_WAIT_MS, o.live ? diagramKey(o.theme) : undefined)
    // Copied into an inert document: its images do not start loading (inlineImages fetches what it needs).
    const copy = document.implementation.createHTMLDocument('').importNode(source, true) as HTMLElement
    cleanExportDom(copy)
    await inlineImages(copy)
    const css = await exportCss(o.theme)
    return assembleHtmlDocument({ title: o.title, ...exportThemeClasses(o.theme), css, body: copy.innerHTML })
  } finally {
    off?.done()
  }
}

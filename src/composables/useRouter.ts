import { shallowRef, readonly, type Ref } from 'vue'
import type { ContentType } from '@/types'

// ── Path-based routing (spec #4) ─────────────────────────────────────────────
// A small History-API router. Everything is relative to the app base
// (import.meta.env.BASE_URL: `/md-review/` on GitHub Pages, `/` in dev), and
// the fragment is only ever a heading/anchor id — never routing state.
//
//   ''                  landing (upload / restored local draft)
//   library             the library (DashboardView until #26)
//   d/<ID>              a shared doc            (d/<ID>/ is rewritten to d/<ID>)
//   d/<ID>@<HASH>       a pinned revision (read-only)
//   d/<ID>/<FILE…>      a file inside a multi-file session
//   anything else       not-found
//
// The pure helpers below are exported for unit tests; `useRouter()` returns
// the app-wide singleton that App, PreviewPane and later DocView share.

export const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/
export const REV_RE = /^[0-9a-f]{32}$/
const LEGACY_SHARED_RE = /^#shared=([a-zA-Z0-9][a-zA-Z0-9-]*)$/

export type Route =
  | { kind: 'landing' }
  | { kind: 'library' }
  | { kind: 'doc'; id: string }
  | { kind: 'pinned'; id: string; rev: string }
  | { kind: 'file'; id: string; file: string }
  | { kind: 'not-found' }

export type RouteKind = Route['kind']

/** `/md-review` | `md-review/` | `/` → `/md-review/` | `/`. */
export function normalizeBase(base: string): string {
  const trimmed = (base || '/').replace(/^\/+|\/+$/g, '')
  return trimmed ? `/${trimmed}/` : '/'
}

/** The part of `pathname` after the base ('' for the base itself), or null when outside it. */
export function stripBase(pathname: string, base: string): string | null {
  const b = normalizeBase(base)
  if (pathname === b || pathname === b.slice(0, -1)) return ''
  if (!pathname.startsWith(b)) return null
  return pathname.slice(b.length)
}

export interface ParsedPath {
  route: Route
  /** Set when the path should be rewritten (replaceState) to its canonical form. */
  canonical?: string
}

/** Parse the path after the base (still percent-encoded, as in `location.pathname`). */
export function parseRoute(rest: string | null): ParsedPath {
  if (rest === null) return { route: { kind: 'not-found' } }
  if (rest === '' || rest === 'index.html') {
    return rest === '' ? { route: { kind: 'landing' } } : { route: { kind: 'landing' }, canonical: '' }
  }
  if (rest === 'library') return { route: { kind: 'library' } }
  if (/^library\/+$/.test(rest)) return { route: { kind: 'library' }, canonical: 'library' }
  if (!rest.startsWith('d/')) return { route: { kind: 'not-found' } }

  const s = rest.slice(2)
  const slash = s.indexOf('/')
  const head = slash === -1 ? s : s.slice(0, slash)
  if (slash === -1) {
    const at = head.indexOf('@')
    if (at !== -1) {
      const id = head.slice(0, at)
      const rev = head.slice(at + 1)
      return ID_RE.test(id) && REV_RE.test(rev)
        ? { route: { kind: 'pinned', id, rev } }
        : { route: { kind: 'not-found' } }
    }
    return ID_RE.test(head) ? { route: { kind: 'doc', id: head } } : { route: { kind: 'not-found' } }
  }
  if (!ID_RE.test(head)) return { route: { kind: 'not-found' } }
  const tail = s.slice(slash + 1)
  if (/^\/*$/.test(tail)) return { route: { kind: 'doc', id: head }, canonical: `d/${head}` }
  let file: string
  try {
    file = tail.split('/').map((seg) => decodeURIComponent(seg)).join('/')
  } catch {
    return { route: { kind: 'not-found' } }
  }
  return { route: { kind: 'file', id: head, file } }
}

/** Percent-encode a session file name per segment (keeps the `/` separators). */
export function encodeFilePath(file: string): string {
  return file.split('/').map(encodeURIComponent).join('/')
}

/** The path (after the base) for a route. */
export function routeRest(route: Route): string {
  switch (route.kind) {
    case 'landing': case 'not-found': return ''
    case 'library': return 'library'
    case 'doc': return `d/${route.id}`
    case 'pinned': return `d/${route.id}@${route.rev}`
    case 'file': return `d/${route.id}/${encodeFilePath(route.file)}`
  }
}

/** Identity of a route's content: two URLs with the same key show the same thing. */
export function routeKey(route: Route): string {
  switch (route.kind) {
    case 'doc': return `doc:${route.id}`
    case 'pinned': return `pinned:${route.id}@${route.rev}`
    case 'file': return `file:${route.id}/${route.file}`
    default: return route.kind
  }
}

/** The doc id a route names (doc, pinned and file routes), else null. */
export function routeDocId(route: Route): string | null {
  return route.kind === 'doc' || route.kind === 'pinned' || route.kind === 'file' ? route.id : null
}

/** `#a%20b` → `a b`. Invalid percent-encoding is returned as typed (never throws). */
export function decodeFragment(hash: string): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  try { return decodeURIComponent(raw) } catch { return raw }
}

export function encodeFragment(id: string): string {
  return id ? `#${encodeURIComponent(id)}` : ''
}

/**
 * Legacy hash URLs (rule 4). Only on the landing route. Returns the new
 * path+query (no fragment) to `replaceState` to, or null when nothing applies.
 * `#github=` is not a redirect: it stays on the landing route (App loads it).
 */
export function legacyRedirect(url: URL, base: string): string | null {
  const parsed = parseRoute(stripBase(url.pathname, base))
  if (parsed.route.kind !== 'landing') return null
  const b = normalizeBase(base)
  const params = new URLSearchParams(url.search)
  params.delete('filePath')
  const shared = url.hash.match(LEGACY_SHARED_RE)
  if (shared) {
    const qs = params.toString()
    return `${b}d/${shared[1]}${qs ? `?${qs}` : ''}`
  }
  if (url.hash === '#dashboard') {
    params.delete('mode')
    params.append('mode', 'review')
    return `${b}library?${params.toString()}`
  }
  return null
}

/** FE-built share link (00 §6): `<origin><BASE_URL>d/<slug||id>`. */
export function docShareUrl(key: string, base: string = import.meta.env.BASE_URL, origin: string = window.location.origin): string {
  return `${origin}${normalizeBase(base)}d/${key}`
}

// ── ?view= resolution (00 §1.3, owned here) ──────────────────────────────────

export type ViewName = 'read' | 'edit' | 'split' | 'slides' | 'agent'
const KNOWN_VIEWS: ViewName[] = ['read', 'edit', 'split', 'slides', 'agent']
/** Views whose item has shipped. Later items add theirs (#7 split, #28 agent, #29 slides). */
export const SHIPPED_VIEWS = new Set<ViewName>(['read', 'edit', 'split'])

export interface ViewContext {
  capability: 'viewer' | 'editor'
  /** doc | pinned | file | embed (landing counts as doc: a local doc). */
  routeKind: 'doc' | 'pinned' | 'file' | 'embed'
  contentType: ContentType
  shipped?: Set<ViewName>
}

/** `view` is what renders; `rewrite` means replaceState the URL to `view=read`. */
export function resolveView(requested: string | null, ctx: ViewContext): { view: ViewName; rewrite: boolean } {
  if (ctx.routeKind === 'embed') return { view: 'read', rewrite: false }
  if (requested === null || requested === 'read') return { view: 'read', rewrite: false }
  const v = requested as ViewName
  if (!KNOWN_VIEWS.includes(v)) return { view: 'read', rewrite: true }
  let allowed: boolean
  if (v === 'edit' || v === 'split') {
    allowed = ctx.capability === 'editor' && ctx.routeKind === 'doc'
  } else {
    allowed = ctx.contentType === 'markdown' && ctx.routeKind !== 'file'
  }
  if (!allowed) return { view: 'read', rewrite: true }
  if (!(ctx.shipped ?? SHIPPED_VIEWS).has(v)) return { view: 'read', rewrite: false }
  return { view: v, rewrite: false }
}

// ── Edit-token hook (rule 6; #23 fills it in) ────────────────────────────────

type EditTokenHandler = (slugOrId: string, token: string) => void
let editTokenHandler: EditTokenHandler = () => { /* no-op until #23 */ }

export function setEditTokenHandler(fn: EditTokenHandler) { editTokenHandler = fn }
export function onEditToken(slugOrId: string, token: string) { editTokenHandler(slugOrId, token) }

// ── Link classification (rule 12) ────────────────────────────────────────────

export type LinkAction =
  | { kind: 'anchor'; id: string }      // in-doc #id ('' = top)
  | { kind: 'app'; path: string }       // SPA navigation to path+search+hash
  | { kind: 'default' }                 // leave it to the browser

/** Decide what a click on `<a href>` inside a rendered doc does. */
export function classifyLink(rawHref: string, resolved: string, origin: string, base: string): LinkAction {
  if (rawHref.startsWith('#')) return { kind: 'anchor', id: decodeFragment(rawHref) }
  let u: URL
  try { u = new URL(resolved) } catch { return { kind: 'default' } }
  if (u.origin !== origin || !/^https?:$/.test(u.protocol)) return { kind: 'default' }
  const parsed = parseRoute(stripBase(u.pathname, base))
  const k = parsed.route.kind
  if (k === 'doc' || k === 'pinned' || k === 'file' || k === 'library') {
    return { kind: 'app', path: u.pathname + u.search + u.hash }
  }
  return { kind: 'default' }
}

// ── The router ───────────────────────────────────────────────────────────────

export type NavSource = 'init' | 'push' | 'replace' | 'pop' | 'frame'

export interface RouterLocation {
  route: Route
  key: string
  /** Decoded anchor id ('' when the URL has no fragment). */
  fragment: string
  search: string
  href: string
  source: NavSource
  /** Increments on every location change (lets watchers re-run for equal values). */
  seq: number
}

export interface Router {
  base: string
  current: Readonly<Ref<RouterLocation>>
  /** pushState to `path` (absolute path, may carry search/hash). Strips `edit=`. */
  push(path: string): void
  /** replaceState to `path`. Strips `edit=`. */
  replace(path: string, opts?: { source?: NavSource }): void
  /** pushState to a route, keeping nothing of the current query. */
  pushRoute(route: Route, query?: string): void
  replaceRoute(route: Route, query?: string): void
  /** Same path + query, new fragment. push for markdown anchors, replace for HTML docs. False when unchanged. */
  setFragment(id: string, mode: 'push' | 'replace', source?: NavSource): boolean
  /** Set (or with null remove) one query param, replaceState. */
  setQueryParam(name: string, value: string | null): void
  query(name: string): string | null
  /** Apply rule 6 / rule 4 / canonical rewrites. Runs once, before the first render. */
  bootstrap(): { redirected: boolean }
  /** Handle a click inside a rendered doc. Returns true when handled. */
  handleLinkClick(e: MouseEvent, container: HTMLElement, scrollTo: (el: HTMLElement) => void): boolean
  destroy(): void
}

export function createRouter(win: Window = window, baseUrl: string = import.meta.env.BASE_URL): Router {
  const base = normalizeBase(baseUrl)
  let seq = 0

  function read(source: NavSource): RouterLocation {
    const loc = win.location
    const parsed = parseRoute(stripBase(loc.pathname, base))
    return {
      route: parsed.route,
      key: routeKey(parsed.route),
      fragment: decodeFragment(loc.hash),
      search: loc.search,
      href: loc.href,
      source,
      seq: ++seq,
    }
  }

  const current = shallowRef<RouterLocation>(read('init'))

  function update(source: NavSource) {
    current.value = read(source)
  }

  /**
   * History API calls can throw (Safari caps them at ~100 per 30 s and throws
   * a SecurityError). A refused update leaves the URL — and `current` — as is.
   */
  function writeHistory(kind: 'push' | 'replace', url: string): boolean {
    try {
      if (kind === 'push') win.history.pushState(null, '', url)
      else win.history.replaceState(null, '', url)
      return true
    } catch {
      return false
    }
  }

  /** Strip `edit=` (rule 6) from a same-origin path, handing the token to the hook. */
  function sanitize(path: string): string {
    const u = new URL(path, win.location.href)
    const token = u.searchParams.get('edit')
    if (token === null) return u.pathname + u.search + u.hash
    u.searchParams.delete('edit')
    const id = routeDocId(parseRoute(stripBase(u.pathname, base)).route)
    if (token && id) onEditToken(id, token)
    return u.pathname + u.search + u.hash
  }

  function push(path: string) {
    const target = sanitize(path)
    const now = win.location.pathname + win.location.search + win.location.hash
    if (target === now) return
    if (writeHistory('push', target)) update('push')
  }

  function replace(path: string, opts: { source?: NavSource } = {}) {
    if (writeHistory('replace', sanitize(path))) update(opts.source ?? 'replace')
  }

  const withQuery = (q?: string) => (q ? (q.startsWith('?') ? q : `?${q}`) : '')

  function pushRoute(route: Route, query?: string) { push(base + routeRest(route) + withQuery(query)) }
  function replaceRoute(route: Route, query?: string) { replace(base + routeRest(route) + withQuery(query)) }

  function setFragment(id: string, mode: 'push' | 'replace', source?: NavSource): boolean {
    const l = win.location
    const target = l.pathname + l.search + encodeFragment(id)
    if (target === l.pathname + l.search + l.hash) return false
    if (mode === 'push') push(target)
    else replace(target, { source })
    return true
  }

  function setQueryParam(name: string, value: string | null) {
    const l = win.location
    const params = new URLSearchParams(l.search)
    if (value === null) params.delete(name)
    else params.set(name, value)
    const qs = params.toString()
    const target = l.pathname + (qs ? `?${qs}` : '') + l.hash
    if (target !== l.pathname + l.search + l.hash) replace(target)
  }

  function query(name: string) {
    return new URLSearchParams(win.location.search).get(name)
  }

  function bootstrap(): { redirected: boolean } {
    const url = new URL(win.location.href)
    // Rule 6: the edit token leaves the address bar before anything renders.
    if (url.searchParams.has('edit')) replace(url.pathname + url.search + url.hash)
    // Rule 4: legacy hash URLs (landing route only).
    const legacy = legacyRedirect(new URL(win.location.href), base)
    if (legacy) { replace(legacy); return { redirected: true } }
    // Canonical forms: <base>index.html → <base>, d/<ID>/ → d/<ID>.
    const parsed = parseRoute(stripBase(win.location.pathname, base))
    if (parsed.canonical !== undefined) replace(base + parsed.canonical + win.location.search + win.location.hash)
    return { redirected: false }
  }

  function handleLinkClick(e: MouseEvent, container: HTMLElement, scrollTo: (el: HTMLElement) => void): boolean {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false
    const target = e.target as Element | null
    const a = target?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a || !container.contains(a)) return false
    if (a.hasAttribute('download') || (a.target && a.target !== '_self')) return false
    const action = classifyLink(a.getAttribute('href') ?? '', a.href, win.location.origin, base)
    if (action.kind === 'default') return false
    e.preventDefault()
    if (action.kind === 'app') { push(action.path); return true }
    if (!action.id) {
      // href="#": back to the top, fragment removed.
      if (!setFragment('', 'push')) scrollTo(container)
      return true
    }
    const el = findAnchorIn(container, action.id)
    if (!el) return true // unknown id: nothing happens
    // A changed fragment is scrolled to by whoever watches `current` (one
    // scroll); clicking the current fragment again just re-scrolls.
    if (!setFragment(action.id, 'push', 'push')) scrollTo(el)
    return true
  }

  // Back/Forward and fragment edits in the address bar (which fire popstate,
  // and hashchange). A legacy fragment pasted while on the landing route
  // (`#shared=`, `#dashboard`) redirects here too, as on load (rule 4); the
  // legacyRedirect() check is landing-only, so heading fragments on doc
  // routes are never touched.
  const onPop = () => {
    if (win.location.href === current.value.href) return // popstate + hashchange for one edit
    const legacy = legacyRedirect(new URL(win.location.href), base)
    if (legacy) { replace(legacy); return }
    update('pop')
  }
  win.addEventListener('popstate', onPop)
  win.addEventListener('hashchange', onPop)

  return {
    base,
    current: readonly(current) as Readonly<Ref<RouterLocation>>,
    push, replace, pushRoute, replaceRoute, setFragment, setQueryParam, query,
    bootstrap, handleLinkClick,
    destroy: () => { win.removeEventListener('popstate', onPop); win.removeEventListener('hashchange', onPop) },
  }
}

let singleton: Router | null = null

/** The app-wide router. */
export function useRouter(): Router {
  singleton ??= createRouter()
  return singleton
}

// ── Scrolling to anchors ─────────────────────────────────────────────────────

/**
 * The element with `id` inside the rendered doc. Looked up in the container,
 * never document-wide: a heading `## App` must not resolve to the app's #app.
 */
export function findAnchorIn(container: Element, id: string): HTMLElement | null {
  if (!id) return null
  try {
    const sel = typeof CSS !== 'undefined' && CSS.escape ? `#${CSS.escape(id)}` : null
    if (sel) return container.querySelector<HTMLElement>(sel)
  } catch { /* fall through */ }
  for (const el of container.querySelectorAll<HTMLElement>('[id]')) if (el.id === id) return el
  return null
}

function nearestScroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p
  }
  return null
}

export function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/**
 * Bring `el` to the top of the reading area: the top of its scroll pane, or —
 * when the document itself scrolls (#5) — just below the sticky header.
 */
export function scrollToAnchorElement(el: HTMLElement, opts: { smooth?: boolean } = {}) {
  const behavior: ScrollBehavior = opts.smooth === false || prefersReducedMotion() ? 'instant' as ScrollBehavior : 'smooth'
  const scroller = nearestScroller(el)
  if (scroller) {
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    scroller.scrollTo({ top, behavior })
    return
  }
  // Document scroll: the target's scroll-margin-top (sticky header + 12px, #3
  // rule 19) keeps it below the header — the same offset native navigation uses.
  el.scrollIntoView({ block: 'start', behavior })
}

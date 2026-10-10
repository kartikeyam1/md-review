import { markRaw, shallowRef, type Component, type ShallowRef } from 'vue'

// #6: the editor (EditorPane + every CodeMirror package) is its own chunk,
// fetched only when someone is about to edit. This module is the one place
// that imports it — dynamically — so nothing in the entry graph pulls
// CodeMirror in. Shared by every editor slot (edit view, #7 split view) and
// by the view toggle's intent prefetch, so the chunk is requested once.

/** The loaded EditorPane component, or null until the chunk arrives. */
export const editorComponent: ShallowRef<Component | null> = shallowRef(null)

let inflight: Promise<Component> | null = null
/** The module URL the last failed import named, used to cache-bust the retry. */
let failedUrl: string | null = null
/** The last load failed and nobody has explicitly asked again yet. */
let lastLoadFailed = false
let attempt = 0

/** The first URL-looking token in an import error message (Chrome/Vite name the module that failed; Safari doesn't). */
export function urlFromImportError(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  const m = msg.match(/(https?:\/\/[^\s'"<>]+|\/[^\s'"<>]+\.(?:m?js|vue|css)(?:\?[^\s'"<>]*)?)/)
  return m ? m[1] : null
}

/** `url` with a fresh `retry` query param (other params kept). */
export function cacheBust(url: string, n: number): string {
  const [path, query = ''] = url.split('?')
  const params = query.split('&').filter((p) => p && !p.startsWith('retry='))
  params.push(`retry=${n}`)
  return `${path}?${params.join('&')}`
}

/**
 * The EditorPane component out of an imported module. Through the normal
 * import it is `default`; a production chunk imported by URL (the retry path)
 * exports it under a minified name, so find it by the SFC's `__name`.
 */
export function pickEditorComponent(mod: Record<string, unknown> | null | undefined): Component | null {
  if (!mod) return null
  const isEditor = (v: unknown) => !!v && typeof v === 'object' && (v as { __name?: unknown }).__name === 'EditorPane'
  if (mod.default && typeof mod.default === 'object') return mod.default as Component
  for (const v of Object.values(mod)) {
    if (isEditor(v)) return v as Component
    // A chunk that also hosts shared code re-exports the module namespace ({ default }) under a minified name.
    const inner = v && typeof v === 'object' ? (v as { default?: unknown }).default : undefined
    if (isEditor(inner)) return inner as Component
  }
  return null
}

async function importEditor(): Promise<Component> {
  // Only the EditorPane module itself can be re-imported by URL.
  const retryUrl = failedUrl && /EditorPane[^/]*\.(m?js|vue)(\?|$)/.test(failedUrl) ? cacheBust(failedUrl, ++attempt) : null
  const mod = retryUrl
    ? await import(/* @vite-ignore */ retryUrl)
    : await import('@/components/EditorPane.vue')
  const comp = pickEditorComponent(mod)
  if (!comp) throw new Error('The editor module has no EditorPane component')
  return comp
}

/**
 * Load the editor chunk (idempotent while in flight or once loaded). After a
 * failure the next call re-imports through a cache-busted URL, because a
 * browser keeps a failed module fetch in its module map for the page's life.
 */
export function loadEditor(): Promise<Component> {
  if (editorComponent.value) return Promise.resolve(editorComponent.value)
  if (inflight) return inflight
  const p = (async () => {
    try {
      const comp = await importEditor()
      editorComponent.value = markRaw(comp as object) as Component
      lastLoadFailed = false
      return comp
    } catch (err) {
      failedUrl = urlFromImportError(err) ?? failedUrl
      lastLoadFailed = true
      throw err
    } finally {
      inflight = null
    }
  })()
  inflight = p
  return p
}

/**
 * Intent prefetch (pointer enters / focus lands on the Edit toggle). Never
 * throws. After a failure it does nothing: only an explicit action (opening
 * the editor, Retry) tries again, so hovering never fires silent retries.
 */
export function prefetchEditor(): void {
  if (lastLoadFailed) return
  loadEditor().catch(() => { /* surfaced when the editor slot actually mounts */ })
}

/** The entry module src of an HTML document (the hashed `index-*.js` in a build). */
export function entryScriptSrc(html: string): string | null {
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    if (!/\btype\s*=\s*["']?module/i.test(m[0])) continue
    const src = m[0].match(/\ssrc\s*=\s*["']?([^"'\s>]+)/i)?.[1]
    if (src) return src
  }
  return null
}

/**
 * Does this failure look like a stale deployment (a redeploy replaced the
 * hashed files)? When the error names the module, ask the server about it
 * (404/410 = gone). Otherwise (Safari names nothing) compare the entry script
 * of a fresh index.html with the one this page runs. A network error
 * (offline) is never a stale deployment.
 */
export async function looksLikeStaleDeploy(err: unknown): Promise<boolean> {
  const url = urlFromImportError(err)
  try {
    if (url) {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' })
      return res.status === 404 || res.status === 410
    }
    const running = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src')
    if (!running) return false
    const res = await fetch(import.meta.env.BASE_URL || '/', { cache: 'no-store' })
    if (!res.ok) return false
    const latest = entryScriptSrc(await res.text())
    return !!latest && latest !== running
  } catch {
    return false
  }
}

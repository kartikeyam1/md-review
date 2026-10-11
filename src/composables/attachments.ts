import type { ContentType } from '@/types'
import { editHeaders } from '@/composables/useEditToken'
import { PASTE_API } from '@/composables/pasteApi'

// ── Image attachments (spec #10) ─────────────────────────────────────────────
// Pure helpers, the upload call, and the host bridge the editor's paste/drop
// handler (src/editor/imagePaste.ts, lazy chunk) talks to. No CodeMirror
// import: DocView (app shell) registers the host from here (00 §4.7).

/** Rule 4: per-image size cap (10 MiB) and images per paste/drop. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_IMAGES = 10
/** Rule 11: an upload that has not answered by then fails. */
export const UPLOAD_TIMEOUT_MS = 60_000
/** Rule 5: uploads in flight at once. */
export const UPLOAD_CONCURRENCY = 3

type FileLike = { name: string; type: string }

const TYPE_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
}
const NAME_EXT: Record<string, string> = { png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif', webp: 'webp', svg: 'svg' }
/** Image extensions a file with no type is recognised by (accepted or not). */
const IMAGE_NAME_RE = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic|heif|avif|ico)$/i

const extOf = (name: string) => /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''

/** An image by its type (`image/*`), or by its extension when the type is empty (rule 2). */
export function isImageFile(file: FileLike): boolean {
  if (file.type) return file.type.startsWith('image/')
  return IMAGE_NAME_RE.test(file.name)
}

/** The stored extension for an accepted image, else null (rule 3). The declared type wins over the name. */
export function imageExtension(file: FileLike): string | null {
  if (file.type) return TYPE_EXT[file.type.toLowerCase()] ?? null
  return NAME_EXT[extOf(file.name)] ?? null
}

/** Rule 7: the file name minus extension, without `[`, `]`, `\`, whitespace collapsed; empty → `image`. */
export function altFromName(name: string): string {
  const base = name.replace(/\.[^./\\\s]*$/, '')
  const alt = base.replace(/[[\]\\]/g, '').replace(/\s+/g, ' ').trim()
  return alt || 'image'
}

const pad = (n: number) => String(n).padStart(2, '0')

function randomHex6(): string {
  const bytes = new Uint8Array(3)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Rule 5: `assets/<YYYYMMDD>-<HHMMSS>-<6 hex>.<ext>`, local time. */
export function assetName(ext: string, date: Date = new Date(), hex: string = randomHex6()): string {
  const d = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const t = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `assets/${d}-${t}-${hex}.${ext}`
}

/** Rule 6: the absolute URL every reader of the doc can load. */
export function attachmentUrl(api: string, docId: string, name: string, origin: string): string {
  return new URL(`/paste/${encodeURIComponent(docId)}/files/${name}`, api || origin).href
}

/** Rule 8: shown while the image uploads. */
export function placeholderText(alt: string): string {
  return `![Uploading ${alt}…]()`
}

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Rule 10: the final markup for the doc's content type. */
export function imageMarkup(alt: string, url: string, contentType: ContentType | undefined): string {
  return contentType === 'html' ? `<img src="${escAttr(url)}" alt="${escAttr(alt)}">` : `![${alt}](${url})`
}

// ── Upload ──────────────────────────────────────────────────────────────────

let active = 0
const waiting: Array<() => void> = []

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= UPLOAD_CONCURRENCY) await new Promise<void>((r) => waiting.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiting.shift()?.()
  }
}

function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result ?? '')
      resolve(s.slice(s.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'))
    reader.readAsDataURL(file)
  })
}

export class UploadError extends Error {}

/**
 * Upload one image to the doc's attachment store (rule 5) and return its
 * absolute URL. `key` is the doc id or slug the edit token is held under;
 * `docId` the canonical id the request and URL use. Throws an UploadError
 * whose message is what the toast shows after "Couldn't upload <alt>: ".
 */
export async function uploadImage(file: Blob, opts: { docId: string; key: string; name: string; signal?: AbortSignal }): Promise<string> {
  return slot(async () => {
    if (opts.signal?.aborted) throw new UploadError('cancelled')
    const content = await toBase64(file)
    const ctrl = new AbortController()
    const onAbort = () => ctrl.abort()
    opts.signal?.addEventListener('abort', onAbort)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, UPLOAD_TIMEOUT_MS)
    try {
      let res: Response
      try {
        res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(opts.docId)}/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...editHeaders(opts.key) },
          body: JSON.stringify({ name: opts.name, content, encoding: 'base64' }),
          signal: ctrl.signal,
        })
      } catch {
        throw new UploadError(timedOut ? 'the upload timed out' : opts.signal?.aborted ? 'cancelled' : 'network error')
      }
      if (!res.ok) {
        let msg = ''
        try { msg = String((await res.json())?.error ?? '') } catch { /* not JSON */ }
        throw new UploadError(msg || `server error (${res.status})`)
      }
      return attachmentUrl(PASTE_API, opts.docId, opts.name, window.location.origin)
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  })
}

// ── Host bridge ─────────────────────────────────────────────────────────────
// DocView owns the doc and the share flow; the editor extension asks it.

export interface AttachmentHost {
  /** The shared doc's key (id or slug) and canonical id; null for a never-shared doc. */
  doc(): { key: string; id: string } | null
  contentType(): ContentType | undefined
  /**
   * Rule 14: ask to share the doc first. Resolves with the new doc once it is
   * shared, or null (cancelled, or the share failed — the host shows the toast).
   */
  requestShare(): Promise<{ key: string; id: string } | null>
}

let host: AttachmentHost | null = null

/** DocView registers itself; returns the unregister function. */
export function setAttachmentHost(h: AttachmentHost): () => void {
  host = h
  return () => { if (host === h) host = null }
}

export function attachmentHost(): AttachmentHost | null {
  return host
}

// ── Pending placeholders never persist (rule 13) ─────────────────────────────
// While a paste uploads, its placeholders are ordinary text in the doc. Every
// write that leaves the page (autosave, keepalive, the local draft) sends the
// doc as it was before the paste instead: the editor registers each pending
// paste here, and the persistence layer calls `stripPendingPlaceholders`.

interface PendingPaste { text: string; placeholders: string[]; replaced: string }
const pendingPastes = new Map<number, PendingPaste>()

export function registerPendingPaste(id: number, paste: PendingPaste) {
  pendingPastes.set(id, paste)
}

export function unregisterPendingPaste(id: number) {
  pendingPastes.delete(id)
}

export const hasPendingPastes = () => pendingPastes.size > 0

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * `text` without the placeholders of pastes still uploading: a paste found
 * whole goes back to what it replaced; otherwise each of its placeholders is
 * removed with the blank line joining it to the next.
 */
export function stripPendingPlaceholders(text: string): string {
  if (!pendingPastes.size || !text.includes('![Uploading ')) return text
  let out = text
  for (const p of pendingPastes.values()) {
    const at = out.indexOf(p.text)
    if (at >= 0) { out = out.slice(0, at) + p.replaced + out.slice(at + p.text.length); continue }
    for (const ph of p.placeholders) out = out.replace(new RegExp(`${escRe(ph)}(\\n\\n)?`), '')
  }
  return out
}

/** A placeholder left in a doc by an upload that is no longer running (rule 13 clean-up). */
export const STALE_PLACEHOLDER_RE = /!\[Uploading [^\]\n]*…\]\(\)(\n\n(?=!\[Uploading ))?/g

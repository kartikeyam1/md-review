import { ref, shallowRef, computed, watch, type ShallowRef } from 'vue'
import type { DocState } from '@/composables/docState'
import type { LastPayload } from '@/composables/useSessionFiles'
import type { SharedPayload } from '@/composables/useShare'
import { PASTE_API } from '@/composables/pasteApi'
import { encodeFilePath, normalizeBase } from '@/composables/useRouter'
import { editHeaders, checkWriteStatus } from '@/composables/useEditToken'
import { toast } from '@/composables/useToast'

// ── Multi-file sessions in the doc view (#26 rules 19–27) ────────────────────
// A shared doc may carry files (MCP add_file, REST POST /paste/:id/files). The
// doc view shows the document files as tabs (FileTabs), everything else in an
// attachments menu, a breadcrumb (DocBreadcrumb), and the file routes
// /d/:x/:file read-only (FileView). The doc itself stays attached on its file
// routes — same capability, same poll — so the file list follows the doc's
// normal poll (rule 27) and editors keep add/remove (00 §1.2).
//
// This module is a lazy chunk (kept out of the entry, #6 AC-06.8); the entry
// holds only the shim in useSessionFiles.ts. The pure helpers below are
// exported for unit tests.

export interface SessionFile { name: string; size: number; type: string }
export interface DocCollection { id: string; name: string }

const DOCUMENT_FILE = /\.(md|markdown|html|htm|txt)$/i
const MARKDOWN_FILE = /\.(md|markdown)$/i
const HTML_FILE = /\.html?$/i
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i

/** Code/text extensions shown as a highlighted code block → highlight.js language. */
const CODE_LANGS: Record<string, string> = {
  txt: 'text', text: 'text', log: 'text',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', jsonl: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', lua: 'lua', r: 'r', pl: 'perl',
  sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', css: 'css', scss: 'scss', less: 'less',
  xml: 'xml', vue: 'xml', svelte: 'xml', diff: 'diff', patch: 'diff',
}

const extOf = (name: string) => {
  const base = name.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** Rule 19: `.md .markdown .html .htm .txt` are document files (tabs); the rest are attachments. */
export function isDocumentFile(name: string): boolean {
  return DOCUMENT_FILE.test(name)
}

/** Case-insensitive name order, code point order as the tie-break (deterministic). */
export function compareNames(a: string, b: string): number {
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  if (la !== lb) return la < lb ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

export function splitSessionFiles(files: readonly SessionFile[] | null | undefined): { documents: SessionFile[]; attachments: SessionFile[] } {
  const documents: SessionFile[] = []
  const attachments: SessionFile[] = []
  for (const f of files ?? []) {
    if (!f || typeof f.name !== 'string' || !f.name) continue
    ;(isDocumentFile(f.name) ? documents : attachments).push(f)
  }
  documents.sort((a, b) => compareNames(a.name, b.name))
  attachments.sort((a, b) => compareNames(a.name, b.name))
  return { documents, attachments }
}

/** Rule 20: the primary tab's label. */
export function primaryTabLabel(filename: string | null | undefined): string {
  return filename && filename.trim() ? filename : 'Document'
}

export type FileKind = 'markdown' | 'html' | 'code' | 'image' | 'download'

/** Rule 22: how a file renders on its route (extension first, then the served content type). */
export function fileKind(name: string, mime = ''): FileKind {
  if (MARKDOWN_FILE.test(name)) return 'markdown'
  if (HTML_FILE.test(name)) return 'html'
  if (IMAGE_FILE.test(name)) return 'image'
  if (extOf(name) in CODE_LANGS) return 'code'
  if (mime.startsWith('image/')) return 'image'
  return 'download'
}

export function codeLanguage(name: string): string {
  return CODE_LANGS[extOf(name)] ?? 'text'
}

/** A fenced code block that no backtick run inside `text` can close early. */
export function codeFence(text: string, lang: string): string {
  let longest = 0
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return `${fence}${lang}\n${body}\n${fence}`
}

/** Rule 20: images and code/text attachments open at their file route; others download. */
export function attachmentOpensInApp(name: string, mime = ''): boolean {
  const k = fileKind(name, mime)
  return k !== 'download'
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Rule 25: text files upload as utf-8, everything else as base64. */
export function uploadsAsText(file: { name: string; type: string }): boolean {
  if (file.type.startsWith('image/')) return false
  if (isDocumentFile(file.name) || fileKind(file.name) === 'code') return true
  return file.type.startsWith('text/') || /^application\/(json|xml|x-yaml|yaml|javascript)/.test(file.type)
}

/** Rule 21: `/d/<key>/<each segment URI-encoded>` under the app base. */
export function fileRoutePath(base: string, docKey: string, file: string): string {
  return `${normalizeBase(base)}d/${docKey}/${encodeFilePath(file)}`
}

export interface Crumb {
  kind: 'library' | 'collection' | 'doc' | 'file'
  label: string
  /** Full text when `label` is shortened (phone). */
  title: string
  href: string | null
  current: boolean
}

/** Rule 24: `Library › <Collection> › <Doc title> › <file>`. */
export function breadcrumbSegments(o: { base: string; docKey: string; docTitle: string; collection: DocCollection | null; file: string | null }): Crumb[] {
  const base = normalizeBase(o.base)
  const out: Crumb[] = [{ kind: 'library', label: 'Library', title: 'Library', href: `${base}library`, current: false }]
  if (o.collection) {
    const qs = new URLSearchParams({ collection: o.collection.id }).toString()
    out.push({ kind: 'collection', label: o.collection.name, title: o.collection.name, href: `${base}library?${qs}`, current: false })
  }
  out.push({ kind: 'doc', label: o.docTitle, title: o.docTitle, href: o.file ? `${base}d/${o.docKey}` : null, current: !o.file })
  if (o.file) out.push({ kind: 'file', label: o.file, title: o.file, href: null, current: true })
  return out
}

/** Phone: the collection collapses to `…` (still a link, full name in title); the doc title ellipsizes in CSS. */
export function phoneBreadcrumb(segments: Crumb[]): Crumb[] {
  if (segments.length < 4) return segments
  return segments.map((s) => (s.kind === 'collection' ? { ...s, label: '…' } : s))
}

// ── The store ─────────────────────────────────────────────────────────────────

export type FileContent =
  | { status: 'loading'; id: string; path: string }
  | { status: 'not-found'; id: string; path: string }
  | { status: 'error'; id: string; path: string }
  | { status: 'ready'; id: string; path: string; kind: 'markdown' | 'html' | 'code'; text: string; lang: string }
  | { status: 'ready'; id: string; path: string; kind: 'image'; url: string }
  | { status: 'ready'; id: string; path: string; kind: 'download'; url: string; size: number | null }

export interface Upload { id: number; name: string }

/** Read a picked file as utf-8 text or bare base64. */
function readFile(file: File, asText: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result ?? '')
      resolve(asText ? s : s.slice(s.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'))
    if (asText) reader.readAsText(file)
    else reader.readAsDataURL(file)
  })
}

/** An in-app confirmation the strip shows (ConfirmDialog, testids `file-confirm-*`); `answer` settles it. */
export interface FileConfirm { title: string; text: string; okLabel: string; answer: (ok: boolean) => void }

async function errorText(res: Response): Promise<string> {
  try { return String((await res.json())?.error ?? '') } catch { return '' }
}

/**
 * The store. `lastPayload` is the entry shim's record of the attached doc's
 * latest server payload (its first GET and each changed poll), kept while
 * this chunk was still loading.
 */
export function createSessionFiles(doc: DocState, lastPayload: ShallowRef<LastPayload | null>) {
  const { router } = doc
  /** The attached doc's files (from its GET / polls, or a list refresh). */
  const files = shallowRef<SessionFile[]>([])
  const collection = shallowRef<DocCollection | null>(null)
  const content = shallowRef<FileContent | null>(null)
  const uploads = ref<Upload[]>([])
  const confirmation = shallowRef<FileConfirm | null>(null)
  let listSeq = 0
  let librarySeq = 0
  /** content_hash of the attached doc's last payload; undefined until its first one. */
  let lastHash: string | null | undefined
  let contentSeq = 0
  let uploadSeq = 0
  let objectUrl: string | null = null

  /** The key the route names the attached doc by (slug or id) — tab URLs keep it. */
  const docKey = computed(() => {
    const r = doc.route.value
    return r.kind === 'doc' || r.kind === 'file' ? r.id : doc.pasteId.value
  })
  /** The route shows the attached shared doc (or one of its files): tabs apply. */
  const active = computed(() => {
    const r = doc.route.value
    return !!doc.pasteId.value && !doc.embed.value && doc.onScreen.value
      && (r.kind === 'doc' || r.kind === 'file') && r.id === doc.pasteId.value
  })
  const split = computed(() => splitSessionFiles(files.value))
  const documents = computed(() => split.value.documents)
  const attachments = computed(() => split.value.attachments)
  /** The file the route opens (null on the primary doc). */
  const currentFile = computed(() => (doc.route.value.kind === 'file' ? doc.route.value.file : null))
  /** Capability is the doc's on its file routes too (00 §1.2): editors add and remove. */
  const canManage = computed(() => doc.capability.value === 'editor')
  /** Rule 20: viewers see the strip when there is something in it; editors always (it holds file-add-btn). */
  const stripShown = computed(() => active.value && (canManage.value || documents.value.length > 0 || attachments.value.length > 0))
  /** Rule 24: the breadcrumb shows when the doc is in a collection or has file tabs. */
  const breadcrumbShown = computed(() => active.value && (!!collection.value || documents.value.length > 0))

  function setFiles(list: unknown) {
    files.value = Array.isArray(list) ? (list as SessionFile[]).filter((f) => f && typeof f.name === 'string') : []
    // A file another client removed while it is open: say so instead of showing a stale copy.
    const c = content.value
    if (c && c.status === 'ready' && c.id === doc.pasteId.value && !files.value.some((f) => f.name === c.path)) {
      setContent({ status: 'not-found', id: c.id, path: c.path })
    }
  }

  /** `?fields=library`: the doc's collection (#26 contract). Absent on older servers → unfiled. */
  async function fetchLibrary(key: string) {
    const seq = ++librarySeq
    try {
      const res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(key)}?fields=library`, { cache: 'no-store' })
      if (seq !== librarySeq || doc.pasteId.value !== key) return
      if (!res.ok) return
      const data = await res.json() as { collection?: DocCollection | null }
      if (seq !== librarySeq || doc.pasteId.value !== key) return
      const c = data.collection
      collection.value = c && typeof c.id === 'string' && typeof c.name === 'string' ? { id: c.id, name: c.name } : null
    } catch { /* keep what we have */ }
  }

  /** GET /paste/:id/files — after this browser added or removed files. */
  async function refreshFiles() {
    const key = doc.pasteId.value
    if (!key) return
    const seq = ++listSeq
    try {
      const res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(key)}/files`, { cache: 'no-store' })
      if (seq !== listSeq || doc.pasteId.value !== key || !res.ok) return
      const list = await res.json()
      if (seq !== listSeq || doc.pasteId.value !== key) return
      setFiles(list)
    } catch { /* the next poll brings it */ }
  }

  // Every server payload for the attached doc — its first GET and each changed
  // poll — carries the file list (`files`, omitted when empty). Rule 27.
  function onPayload(p: LastPayload | null) {
    const key = doc.pasteId.value
    if (!p || !key || p.key !== key) return
    ++listSeq // a list refresh in flight is older than this payload
    setFiles((p.data as SharedPayload & { files?: SessionFile[] }).files)
    // The collection: on the doc's first payload, then only on payloads whose
    // content did not change (a collection move bumps the version alone), so a
    // remote editor typing does not double the poll traffic.
    const hash = p.data.content_hash ?? null
    const first = lastHash === undefined
    if (first || hash === lastHash) fetchLibrary(key)
    lastHash = hash
  }

  // Another doc (or none): nothing of the previous one's carries over. Sync:
  // the new doc's first payload arrives in the same tick as its pasteId.
  watch(() => doc.pasteId.value, () => {
    ++listSeq; ++librarySeq
    lastHash = undefined
    confirmation.value?.answer(false)
    files.value = []
    collection.value = null
    uploads.value = []
  }, { flush: 'sync' })
  // Registered after the reset watcher: a payload in the same tick as its pasteId wins.
  watch(lastPayload, onPayload, { flush: 'sync', immediate: true })

  function setContent(next: FileContent | null) {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null }
    if (next?.status === 'ready' && (next.kind === 'image' || next.kind === 'download')) objectUrl = next.url
    content.value = next
  }

  /** Fetch one file for its route (one request; rule 23: a 404 is final). */
  async function openFile(id: string, path: string) {
    const seq = ++contentSeq
    setContent({ status: 'loading', id, path })
    const res = await doc.share.loadSessionFile(id, path)
    if (seq !== contentSeq) return
    if (!res.blob) {
      setContent({ status: res.status === 404 || res.status === 410 ? 'not-found' : 'error', id, path })
      return
    }
    const kind = fileKind(path, res.type)
    if (kind === 'image') {
      setContent({ status: 'ready', id, path, kind, url: URL.createObjectURL(res.blob) })
    } else if (kind === 'download') {
      // A blob URL: `<a download>` is ignored across origins (the API is another origin, 00 §9)
      setContent({ status: 'ready', id, path, kind, url: URL.createObjectURL(res.blob), size: res.blob.size })
    } else {
      const text = await res.blob.text()
      if (seq !== contentSeq) return
      setContent({ status: 'ready', id, path, kind, text, lang: codeLanguage(path) })
    }
  }

  function closeFile() {
    ++contentSeq
    setContent(null)
  }

  function filePath(name: string): string {
    return fileRoutePath(router.base, docKey.value ?? '', name)
  }
  function docPath(): string {
    return `${router.base}d/${docKey.value ?? ''}`
  }

  /** Select a tab: the primary doc (null) or a file. Pushes (rule 21). */
  function select(name: string | null) {
    router.push(name === null ? docPath() : filePath(name))
  }

  /** Ask in-app (rule 25 confirms); a newer question cancels an open one. */
  function ask(title: string, text: string, okLabel: string): Promise<boolean> {
    confirmation.value?.answer(false)
    return new Promise((resolve) => {
      const req: FileConfirm = {
        title, text, okLabel,
        answer: (ok) => { if (confirmation.value === req) confirmation.value = null; resolve(ok) },
      }
      confirmation.value = req
    })
  }

  /** Rule 25: add picked files (utf-8 for text, base64 otherwise), asking before replacing one. */
  async function addFiles(picked: File[]) {
    const key = doc.pasteId.value
    if (!key || !canManage.value) return
    let changed = false
    for (const file of picked) {
      if (files.value.some((f) => f.name === file.name)
        && !(await ask(`Replace “${file.name}”?`, `“${file.name}” is already part of this document. Replace it with the file you picked?`, 'Replace'))) continue
      if (doc.pasteId.value !== key) return
      const upload = { id: ++uploadSeq, name: file.name }
      uploads.value = [...uploads.value, upload]
      try {
        const asText = uploadsAsText(file)
        const body = await readFile(file, asText)
        const res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(key)}/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...editHeaders(key) },
          body: JSON.stringify(asText ? { name: file.name, content: body } : { name: file.name, content: body, encoding: 'base64' }),
        })
        checkWriteStatus(key, res.status)
        if (!res.ok) {
          const msg = await errorText(res)
          toast.error(`Couldn't add ${file.name}: ${msg || `server error (${res.status})`}`)
        } else {
          changed = true
        }
      } catch (e) {
        toast.error(`Couldn't add ${file.name}: ${e instanceof Error && e.message ? e.message : 'network error'}`)
      } finally {
        uploads.value = uploads.value.filter((u) => u.id !== upload.id)
      }
      if (doc.pasteId.value !== key) return
    }
    if (changed) await refreshFiles()
  }

  /** Rule 25: remove a file (confirmed); removing the open file goes back to the primary doc. */
  async function removeFile(name: string) {
    const key = doc.pasteId.value
    if (!key || !canManage.value) return
    if (!(await ask(`Remove “${name}”?`, 'It is removed from this document for everyone. This cannot be undone.', 'Remove'))) return
    if (doc.pasteId.value !== key) return
    let res: Response
    try {
      res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(key)}/files/${encodeFilePath(name)}`, {
        method: 'DELETE',
        headers: editHeaders(key),
      })
    } catch {
      toast.error(`Couldn't remove ${name}: network error`)
      return
    }
    checkWriteStatus(key, res.status)
    if (!res.ok && res.status !== 404) {
      const msg = await errorText(res)
      toast.error(`Couldn't remove ${name}: ${msg || `server error (${res.status})`}`)
      return
    }
    if (doc.pasteId.value !== key) return
    files.value = files.value.filter((f) => f.name !== name)
    if (currentFile.value === name) router.replace(docPath())
    refreshFiles()
  }

  /**
   * Download an attachment the app does not render. Fetched first and saved
   * from a blob URL: `<a download>` on the cross-origin API URL would be
   * ignored and navigate the app tab away.
   */
  async function download(name: string) {
    const key = doc.pasteId.value
    if (!key) return
    const res = await doc.share.loadSessionFile(key, name)
    if (!res.blob) {
      toast.error(`Couldn't download ${name}: ${res.status ? `server error (${res.status})` : 'network error'}`)
      return
    }
    const url = URL.createObjectURL(res.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name.split('/').pop() || name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  return {
    files, documents, attachments, collection, content, uploads, confirmation,
    docKey, active, currentFile, canManage, stripShown, breadcrumbShown,
    openFile, closeFile, refreshFiles, select, filePath, docPath, addFiles, removeFile, download,
  }
}

export type SessionFiles = ReturnType<typeof createSessionFiles>

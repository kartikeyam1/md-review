import { watch, provide, inject, type InjectionKey } from 'vue'
import { loadLocalCopy } from '@/composables/localCopy'
import type { ContentType, DocMode } from '@/types'
import { payloadMode } from '@/composables/docMeta'
import { toast } from '@/composables/useToast'
import { detectContentType } from '@/composables/useContentType'
import { resolveView, routeKey, type RouterLocation } from '@/composables/useRouter'
import type { DocState, DocViewName } from '@/composables/useDocState'

// ── Doc loaders (spec #4 routes, #2 shell split) ─────────────────────────────
// What happens when a route is entered: load the shared doc / pinned revision
// / session file / local draft into the doc state, guard leaving a doc with
// unsaved edits, and the document-level actions that change what is on screen
// (open a file, New, Share).

const MARKDOWN_FILE = /\.(md|markdown|txt)$/i
const HTML_FILE = /\.html?$/i
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i
const LEAVE_FLUSH_MS = 1500

/** Resolves to `fallback` when `p` takes longer than `ms` (a stalled save). */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, () => { clearTimeout(t); resolve(fallback) })
  })
}

const pathOf = (href: string) => { const u = new URL(href); return u.pathname + u.search + u.hash }

export function useDocLoader(doc: DocState, opts: { legacyRedirected: boolean }) {
  const { router, sync } = doc
  const {
    takeRestoredDraft, restoredInfo, loadLocalDraft, forgetLocalDraft, clearPersisted, restored,
  } = doc.persistence
  const { loadShareDetailed, fetchGithub, getShareUrls, getRevision, loadSessionFile, sessionFileUrl, createShare, getComments, getApproval } = doc.share

  function detachFromShare() {
    doc.pasteId.value = null
    doc.access.value = null
    doc.localCopy.value = null
    doc.approvalInfo.value = null
    doc.docMeta.value = { sessionName: null, slug: null, sharedAt: null, latest: null }
  }

  /** Put on screen something that is not a live shared doc (pinned revision, file). */
  function showReadOnlyContent(content: string, name: string, type: ContentType) {
    detachFromShare()
    doc.pinnedInfo.value = null
    doc.setFileView(null)
    doc.clearComments()
    doc.dismissAll()
    doc.notice.value = null
    doc.markdown.value = content
    doc.filename.value = name
    doc.contentType.value = type
    doc.appMode.value = 'doc'
  }

  let navToken = 0
  const isStale = (token: number) => token !== navToken

  async function loadSharedDoc(shareId: string, token: number) {
    const key = routeKey({ kind: 'doc', id: shareId })
    // Already attached to this session (Back/Forward, library and back) — do
    // not reload over local edits.
    if (doc.pasteId.value === shareId && doc.screenKey.value === key) { applyViewParam(); return }
    if (doc.pasteId.value) detachFromShare()

    const { data, status } = await loadShareDetailed(shareId)
    if (isStale(token)) return // navigated away meanwhile

    if (!data) {
      const draft = takeRestoredDraft(shareId)
      if (status === 404 || status === 410) {
        if (!draft || doc.embed.value) {
          // Rule 10: no local copy — a definitive "not found", never the upload screen.
          doc.docMissing.value = 'missing'
          return
        }
        // Session gone, but this browser has a copy: keep it as a plain local document.
        handleFileLoaded(draft.markdown, draft.filename, undefined, { shared: true })
        doc.mode.value = draft.mode
        doc.screenKey.value = 'landing'
        router.replace(router.base)
        doc.notice.value = status === 410
          ? 'This shared session has expired. Showing your local copy.'
          : 'This shared session no longer exists. Showing your local copy.'
        return
      }
      // Server unreachable (offline is not "not found"). If the persisted copy
      // belongs to this session, stay attached so polling/autosave resume when
      // it comes back.
      if (draft) {
        handleFileLoaded(draft.markdown, draft.filename, undefined, { shared: true })
        doc.mode.value = draft.mode
        doc.pasteId.value = shareId
        doc.screenKey.value = key
        if (draft.baseMarkdown !== null) {
          sync.setBaseline({ markdown: draft.baseMarkdown, filename: draft.filename })
        } else {
          sync.expectDraft()
        }
      }
      // After handleFileLoaded, which clears notices.
      doc.notice.value = draft
        ? 'Cannot reach the review server. Showing your local copy; it will sync when the server is back.'
        : 'Cannot reach the review server. This document will load when the server is back — try again shortly.'
      return
    }

    handleFileLoaded(data.markdown, data.filename, data.contentType, { shared: true })
    if (data.comments?.length) {
      doc.loadComments(data.comments)
    }
    doc.pasteId.value = shareId
    doc.screenKey.value = key
    // Mode and header meta from the payload (absent/invalid mode → review).
    doc.applyServerMeta(data, Date.now(), { initial: true })
    sync.setBaseline({
      markdown: data.markdown,
      filename: data.filename,
      contentHash: data.content_hash ?? null,
      etag: data.etag ?? null,
    })
    // #23: edits set aside when this doc turned view-only (kept across reloads).
    doc.localCopy.value = loadLocalCopy(data.id || shareId)
    // A reload with unsaved edits: put them back on top of the fresh server copy —
    // unless this browser cannot edit the doc: then they become the local copy and
    // the screen shows the server version (#23).
    const draft = takeRestoredDraft(shareId)
    if (draft && !draft.clean && draft.markdown !== data.markdown && !doc.embed.value && doc.capability.value !== 'editor') {
      doc.setLocalCopy(draft.markdown, draft.filename || data.filename)
    } else if (draft && !draft.clean && draft.markdown !== data.markdown && !doc.embed.value) {
      sync.restoreDraft(draft.markdown, draft.baseMarkdown)
      doc.notice.value = sync.conflict.value
        ? 'Restored your unsaved edits, but the server copy changed in the meantime — choose a version below.'
        : 'Restored your unsaved edits from this browser.'
    }
    applyViewParam()
    doc.refreshApproval()
  }

  /** Rule 7: a pinned revision, read-only. Never GET /paste/<ID>. */
  async function loadPinned(id: string, rev: string, token: number) {
    const key = routeKey({ kind: 'pinned', id, rev })
    if (doc.screenKey.value === key) { applyViewParam(); return }
    const { data, status } = await getRevision(id, rev)
    if (isStale(token)) return
    if (!data) {
      if (status === 404) doc.docMissing.value = 'missing'
      else if (status === 410) doc.docMissing.value = 'revision-gone'
      else doc.notice.value = 'Cannot reach the review server. Try again when it is back.'
      return
    }
    showReadOnlyContent(data.markdown, id, detectContentType('', data.markdown))
    doc.fileView.value = null
    doc.pinnedInfo.value = { id, at: data.at }
    doc.pinnedCurrent.value = null
    // #2/#4 ruling: the doc's mode comes on the revision response; a review
    // doc's comments and approval come from their own endpoints (never GET /paste/<id>).
    doc.mode.value = payloadMode(data.mode)
    doc.docMeta.value = {
      sessionName: data.sessionName ?? null, slug: null, sharedAt: null, filename: data.filename ?? null,
      latest: data.at ? { at: data.at, by: data.by ?? null } : null,
    }
    doc.screenKey.value = key
    applyViewParam()
    if (doc.mode.value === 'review') {
      const [comments, approval] = await Promise.all([getComments(id), getApproval(id)])
      if (isStale(token) || doc.screenKey.value !== key) return
      if (comments) doc.loadComments(comments)
      doc.approvalInfo.value = approval
    }
  }

  /** Rule 8: one file of a multi-file session, read-only. */
  async function loadFile(id: string, file: string, token: number) {
    const key = routeKey({ kind: 'file', id, file })
    if (doc.screenKey.value === key) { applyViewParam(); return }
    const res = await loadSessionFile(id, file)
    if (isStale(token)) return
    if (!res.blob) {
      if (res.status === 404 || res.status === 410) doc.docMissing.value = 'missing'
      else doc.notice.value = 'Cannot reach the review server. Try again when it is back.'
      return
    }
    const name = file.split('/').pop() || file
    doc.pinnedInfo.value = null
    if (MARKDOWN_FILE.test(file) || HTML_FILE.test(file)) {
      const text = await res.blob.text()
      if (isStale(token)) return
      showReadOnlyContent(text, name, HTML_FILE.test(file) ? 'html' : 'markdown')
      doc.setFileView(null)
    } else {
      showReadOnlyContent('', name, 'markdown')
      doc.setFileView(IMAGE_FILE.test(file) || res.type.startsWith('image/')
        ? { kind: 'image', url: URL.createObjectURL(res.blob), name }
        : { kind: 'download', url: sessionFileUrl(id, file), name })
    }
    // A session file carries no comments of its own: a plain reading page.
    doc.mode.value = 'publish'
    doc.screenKey.value = key
    applyViewParam()
  }

  /**
   * Legacy `#github=<url>` on the landing route (rule 4): open the file as a
   * local doc, then drop the fragment. On failure show the error, URL → base.
   */
  async function loadFromGithubHash() {
    const match = window.location.hash.match(/^#github=(.+)$/)
    if (!match) return

    let githubUrl: string
    try { githubUrl = decodeURIComponent(match[1]) } catch { githubUrl = match[1] }
    const data = await fetchGithub(githubUrl)
    if (data) {
      handleFileLoaded(data.content, data.filename)
      const l = window.location
      router.replace(l.pathname + l.search)
    } else {
      doc.notice.value = doc.share.shareError.value || 'Could not load the file from GitHub.'
      router.replace(router.base)
    }
  }

  /** Load file from ?filePath= URL param (dev server only). */
  async function loadFromFilePath() {
    const filePath = doc.filePathParam.value
    if (!filePath) return

    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`)
      if (!res.ok) return
      const { content, filename: name } = await res.json()
      // The dev fixture harness opens in review mode (00 §1.4).
      handleFileLoaded(content, name, undefined, { mode: 'review' })
    } catch {
      // API not available (production build) — ignore
    }
  }

  /**
   * Rule 5 / 00 §1.3: resolve ?view= against what is on screen. Disallowed or
   * unknown values render read and are rewritten to view=read (replaceState).
   * (UI view toggles do not write ?view= yet — see DECISIONS #4.)
   */
  function applyViewParam() {
    const { view, rewrite } = resolveView(router.query('view'), {
      capability: doc.capability.value,
      routeKind: doc.routeKind.value,
      contentType: doc.contentType.value,
    })
    doc.paneMode.value = view === 'edit' ? 'edit' : 'preview'
    if (rewrite) router.setQueryParam('view', 'read')
  }

  /** A UI view change (view toggle): replaceState to ?view=<view> (00 §1.3). */
  function setView(view: DocViewName) {
    if (view === 'edit' && doc.capability.value !== 'editor') return
    doc.paneMode.value = view === 'edit' ? 'edit' : 'preview'
    router.setQueryParam('view', view)
  }

  /** Empty landing state (New, or navigating back to the landing route). */
  function resetToEmpty() {
    doc.clearComments()
    doc.dismissAll()
    doc.notice.value = null
    doc.markdown.value = ''
    doc.filename.value = ''
    doc.contentType.value = 'markdown'
    doc.mode.value = 'publish'
    detachFromShare()
    doc.pinnedInfo.value = null
    doc.setFileView(null)
    doc.appMode.value = 'upload'
    doc.screenKey.value = 'landing'
  }

  /** The user chose to leave a shared doc with unsaved edits: drop them for good. */
  function discardAttached() {
    detachFromShare()
    doc.screenKey.value = null
    // The persisted draft holds exactly those edits; keep the local draft slot.
    clearPersisted({ keepLocal: true })
  }

  /**
   * Rule 13: any navigation away from the attached shared doc while it has
   * unsaved changes — a link, Back/Forward, the library, New — flushes autosave
   * (briefly), and if that cannot finish, asks. The doc stays on screen while
   * deciding. Cancel puts the doc's URL back; accepting discards the edits so
   * later navigation does not ask again.
   */
  async function guardLeave(to: RouterLocation, from: RouterLocation, token: number): Promise<boolean> {
    const attached = doc.pasteId.value
    if (!attached || !sync.isShared.value) return true
    const attachedKey = routeKey({ kind: 'doc', id: attached })
    if (to.key === attachedKey) return true
    const unsaved = () => sync.isDirty.value || !!sync.conflict.value || sync.saveState.value === 'saving'
    if (!unsaved()) return true
    const showing = from.key === attachedKey && doc.screenKey.value === attachedKey
    if (showing) doc.held.value = from
    try {
      if (!sync.conflict.value) await withTimeout(doc.flushAutosave(), LEAVE_FLUSH_MS, false)
      if (isStale(token)) return false
      if (!unsaved()) return true
      if (window.confirm('Your changes to this shared document could not be saved yet. Leave anyway and discard them?')) {
        discardAttached()
        return true
      }
      router.push(showing ? pathOf(from.href) : `${router.base}d/${attached}`)
      return false
    } finally {
      if (doc.held.value === from) doc.held.value = null
    }
  }

  /** Put the never-shared local draft on screen (landing route), if there is one. */
  async function enterLanding(token: number) {
    if (doc.screenKey.value === 'landing') return
    if (doc.pasteId.value) detachFromShare()
    const local = await loadLocalDraft()
    if (isStale(token) || doc.screenKey.value === 'landing') return
    if (!local) { resetToEmpty(); return }
    doc.clearComments()
    doc.dismissAll()
    doc.notice.value = null
    doc.pinnedInfo.value = null
    doc.setFileView(null)
    doc.markdown.value = local.markdown
    doc.filename.value = local.filename
    doc.contentType.value = local.contentType ?? 'markdown'
    doc.mode.value = local.mode
    doc.loadComments(local.comments)
    doc.appMode.value = 'doc'
    doc.screenKey.value = 'landing'
    applyViewParam()
  }

  async function applyRoute(to: RouterLocation, from: RouterLocation | null) {
    const token = ++navToken
    if (from && !(await guardLeave(to, from, token))) return
    if (isStale(token)) return
    doc.docMissing.value = null
    const r = to.route
    switch (r.kind) {
      case 'landing':
        return enterLanding(token)
      case 'library':
      case 'not-found':
        return
      case 'doc':
        return loadSharedDoc(r.id, token)
      case 'pinned':
        return loadPinned(r.id, r.rev, token)
      case 'file':
        return loadFile(r.id, r.file, token)
    }
  }

  // Every route change (push, replace, Back/Forward). Same key = same content:
  // a fragment or query change, handled by PreviewPane / applyViewParam.
  watch(() => router.current.value, (to, from) => {
    if (!doc.booted.value) return
    if (to.key === from.key) {
      // A `#github=` pasted while already on the landing route (rule 4).
      if (to.route.kind === 'landing' && to.source === 'pop' && /^#github=/.test(new URL(to.href).hash)) loadFromGithubHash()
      return
    }
    applyRoute(to, from)
  })

  /**
   * Put a document on screen. Anything that is not the shared session itself
   * (file picker, drop, paste, GitHub, ?filePath=) detaches from the current
   * share first — otherwise the old session's polling would keep writing over
   * the new document, and Save would push the new document into the old session.
   */
  function handleFileLoaded(content: string, name: string, type?: ContentType, opts: { shared?: boolean; mode?: DocMode } = {}) {
    if (!opts.shared) {
      if (!doc.confirmDiscardIfDirty()) return
      detachFromShare()
      // A local doc lives on the landing route.
      doc.screenKey.value = 'landing'
      if (doc.route.value.kind !== 'landing') router.replace(router.base)
    }
    // Whatever was on screen before (a pinned banner, a file's image) goes.
    doc.pinnedInfo.value = null
    doc.setFileView(null)
    doc.clearComments()
    doc.dismissAll()
    doc.notice.value = null
    doc.markdown.value = content
    doc.filename.value = name
    doc.contentType.value = type ?? detectContentType(name, content)
    // A local doc (picker, drop, paste, #github=) is a reading page (00 §1.4);
    // a shared doc's mode is set by its loader.
    if (!opts.shared) doc.mode.value = opts.mode ?? 'publish'
    doc.appMode.value = 'doc'
  }

  function handleNewDoc() {
    if (!doc.confirmDiscardIfDirty()) return
    // New from a shared doc keeps the (unrelated) local draft in storage.
    clearPersisted({ keepLocal: doc.screenKey.value !== 'landing' })
    resetToEmpty()
    doc.filePathParam.value = null
    // Rule 11: New → landing (pushState); already there → just drop query/fragment.
    if (doc.route.value.kind === 'landing') router.replace(router.base)
    else router.push(router.base)
  }

  function handleOpenFile() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.txt,.html,.htm'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        handleFileLoaded(reader.result as string, file.name)
      }
      reader.readAsText(file)
    }
    input.click()
  }

  async function handleShare() {
    // Already shared: make sure the server has the latest text, then just show the links.
    if (doc.pasteId.value) {
      if (sync.isDirty.value) await doc.flushAutosave()
      doc.shareResult.value = getShareUrls(doc.pasteId.value)
      doc.showShareModal.value = true
      return
    }
    const created = await createShare(doc.markdown.value, doc.filename.value, doc.comments.value, undefined, doc.contentType.value, doc.reviewerName.value || undefined, doc.mode.value)
    if (created) {
      // Rule 11: the URL becomes d/<slug||id> (replaceState), preferring the slug.
      const key = created.slug || created.id
      doc.pasteId.value = key
      doc.screenKey.value = routeKey({ kind: 'doc', id: key })
      doc.docMeta.value = { sessionName: null, slug: created.slug, sharedAt: new Date().toISOString(), latest: null }
      // The POST carried the local mode: that is what the server now holds.
      doc.setModeBaseline(doc.mode.value)
      router.replace(`${router.base}d/${key}`)
      // It is a shared doc now, no longer the never-shared local draft.
      forgetLocalDraft()
      sync.setBaseline({ markdown: doc.markdown.value, filename: doc.filename.value })
      doc.shareResult.value = getShareUrls(key)
      doc.showShareModal.value = true
      doc.refreshApproval()
    } else {
      toast.error(doc.share.shareError.value || 'Failed to create share link.')
    }
  }

  /** First load: restore the previous draft, then apply the URL's route. */
  async function boot() {
    // Put the previous draft back first: loadSharedDoc() reconciles it against
    // the server copy and the upload screen must not flash over a restored doc.
    await restored
    const info = restoredInfo()
    if (info) doc.screenKey.value = info.pasteId ? routeKey({ kind: 'doc', id: info.pasteId }) : 'landing'
    const hasGithub = /^#github=/.test(window.location.hash)
    if (doc.route.value.kind === 'landing') {
      doc.filePathParam.value = router.query('filePath')
      // Rule 9: only unsaved edits to a shared doc hijack the landing route.
      if (!opts.legacyRedirected && !doc.filePathParam.value && !hasGithub && info?.pasteId && info.dirty) {
        router.replace(`${router.base}d/${info.pasteId}${window.location.search}`)
      }
    }
    doc.booted.value = true
    if (doc.route.value.kind === 'landing') {
      loadFromFilePath()
      loadFromGithubHash()
      if (!doc.filePathParam.value && !hasGithub) {
        // A restored shared draft is not shown here; the local draft (if any) is.
        if (doc.screenKey.value === 'landing') applyViewParam()
        else enterLanding(++navToken)
      }
    } else {
      applyRoute(router.current.value, null)
    }
  }

  const loader = {
    boot, applyViewParam, setView, loadFromFilePath,
    handleFileLoaded, handleNewDoc, handleOpenFile, handleShare,
  }
  provide(DOC_LOADER, loader)
  return loader
}

export type DocLoader = ReturnType<typeof useDocLoader>

const DOC_LOADER: InjectionKey<DocLoader> = Symbol('md-review-doc-loader')

/** Components under App: the document-level actions (open, New, Share, refresh). */
export function useDocActions(): DocLoader {
  const loader = inject(DOC_LOADER)
  if (!loader) throw new Error('useDocActions() called outside of a useDocLoader() tree')
  return loader
}

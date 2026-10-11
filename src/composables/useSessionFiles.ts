import { shallowRef, provide, inject, type InjectionKey, type ShallowRef } from 'vue'
import type { DocState } from '@/composables/docState'
import type { SharedPayload } from '@/composables/useShare'
import type { SessionFiles } from '@/composables/sessionFiles'

// ── Multi-file sessions: the entry-chunk shim (#26) ──────────────────────────
// The store and its helpers (sessionFiles.ts) and the components that use them
// (FileTabs, DocBreadcrumb, FileView) are lazy chunks, kept out of the entry
// (#6 AC-06.8). This shim, created by useDocLoader, records the attached doc's
// latest server payload from boot on — so nothing is missed while the chunk
// loads — and queues file opens until the store exists.

/** The attached doc's latest server payload (`key` = the pasteId it belongs to). */
export interface LastPayload { key: string; data: SharedPayload }

/** A file route's screen key belongs to its doc: `file:x/…` → `doc:x` (other keys unchanged). */
export function docKeyOfScreen(screenKey: string | null, docId: string): string | null {
  if (screenKey && screenKey.startsWith(`file:${docId}/`)) return `doc:${docId}`
  return screenKey
}

const SESSION_FILES: InjectionKey<ShallowRef<SessionFiles | null>> = Symbol('md-review-session-files')

export function provideSessionFiles(doc: DocState) {
  const lastPayload = shallowRef<LastPayload | null>(null)
  const store = shallowRef<SessionFiles | null>(null)
  // A failed chunk import (offline, a stale chunk after a deploy) is retried on
  // the next payload or file open instead of leaving file routes blank for good.
  let ready: Promise<SessionFiles | null> | null = null
  const load = () => (ready ??= import('@/composables/sessionFiles').then(
    (m) => (store.value ??= m.createSessionFiles(doc, lastPayload)),
    () => { ready = null; return null },
  ))
  doc.onServerPayload((data) => {
    const key = doc.pasteId.value
    if (key) lastPayload.value = { key, data }
    if (!store.value) load()
  })
  load()
  provide(SESSION_FILES, store)
  return {
    store,
    /** Fetch one file for its route (once the store has loaded). */
    openFile: (id: string, path: string) => {
      load().then((s) => {
        if (s) s.openFile(id, path)
        else doc.notice.value = "Couldn't load this file. Check your connection and try again."
      })
    },
    closeFile: () => { store.value?.closeFile() },
  }
}

/** The store, null until its chunk has loaded (DocView renders the file UI only then). */
export function useSessionFilesStore(): ShallowRef<SessionFiles | null> {
  const s = inject(SESSION_FILES)
  if (!s) throw new Error('useSessionFiles() called outside of a useDocLoader() tree')
  return s
}

/** Lazy components (mounted only once the store exists): the store itself. */
export function useSessionFiles(): SessionFiles {
  const s = useSessionFilesStore().value
  if (!s) throw new Error('useSessionFiles() used before the session-files chunk loaded')
  return s
}

import { ref, type Ref } from 'vue'
import type { DocMode } from '@/types'
import type { SharedPayload, useShare } from '@/composables/useShare'
import { payloadMode } from '@/composables/docMeta'
import { toast } from '@/composables/useToast'

// ── Doc mode + server meta (#2 rules 3, 8, 11) ───────────────────────────────
// Keeps the per-doc mode and the reader-header meta in step with the server.
// Mode writes are serialised: one PUT in flight, the latest choice wins; a
// failure rolls back (with an error toast) only when nothing newer is pending.
// Polls never undo a local change: a payload requested while a write was in
// flight, or before the last write settled, keeps its hands off `mode`.

export interface DocMeta {
  sessionName: string | null
  slug: string | null
  sharedAt: string | null
  /** Display name for a doc whose meta has no sessionName (pinned revisions). */
  filename?: string | null
  latest: { at: string; by: string | null } | null
  /** ISO expiry of a shared doc; null = never (#23 expiry picker). */
  expiresAt?: string | null
}

export const EMPTY_DOC_META: DocMeta = { sessionName: null, slug: null, sharedAt: null, latest: null }

export function useDocModeSync(opts: {
  mode: Ref<DocMode>
  pasteId: Ref<string | null>
  canChange: () => boolean
  share: ReturnType<typeof useShare>
}) {
  const { mode, pasteId, share } = opts
  const docMeta = ref<DocMeta>({ ...EMPTY_DOC_META })
  /** The mode the server is known to hold for the attached doc. */
  let confirmed: DocMode = mode.value
  let writing = false
  let settledAt = 0

  /** The server's mode for the attached doc is `m` (a load, a create, a poll). */
  function setModeBaseline(m: DocMode) {
    confirmed = m
    mode.value = m
  }

  /** A server payload for the attached doc; `requestedAt` is when its request started. */
  function applyServerMeta(data: SharedPayload, requestedAt: number, o: { initial?: boolean } = {}) {
    docMeta.value = {
      sessionName: data.sessionName ?? null,
      slug: data.slug ?? null,
      sharedAt: data.sharedAt ?? null,
      latest: data.latest_revision ? { at: data.latest_revision.at, by: data.latest_revision.by ?? null } : null,
      expiresAt: data.expires_at ?? null,
    }
    if (o.initial || (!writing && requestedAt >= settledAt)) setModeBaseline(payloadMode(data.mode))
  }

  /** Write `mode` until the server holds the latest choice (or a write fails with nothing newer pending). */
  async function pump(id: string) {
    if (writing) return
    writing = true
    try {
      while (pasteId.value === id && mode.value !== confirmed) {
        const want = mode.value
        const ok = await share.putMeta(id, { mode: want })
        if (pasteId.value !== id) return
        if (ok) { confirmed = want; continue }
        if (mode.value === want) {
          mode.value = confirmed
          toast.error("Couldn't change the document mode. Check your connection and try again.")
        }
        // else: a newer choice is pending — the loop writes that one.
      }
    } finally {
      writing = false
      settledAt = Date.now()
    }
  }

  /**
   * Editor switches the doc mode (rule 11). The UI follows at once; a shared
   * doc writes it in the background; a local doc keeps it in its draft.
   */
  function setDocMode(next: DocMode) {
    if (!opts.canChange() || mode.value === next) return
    mode.value = next
    const id = pasteId.value
    if (id) pump(id)
  }

  return { docMeta, applyServerMeta, setDocMode, setModeBaseline }
}

import { ref, computed, watch, type Ref, type ComputedRef } from 'vue'
import type { RevisionEntry } from '@/composables/useShare'
import type { Route } from '@/composables/useRouter'
import { useRevisions, summarizeSince, type SinceSummary } from '@/composables/useRevisions'

// ── Revision tracking (part of the doc state, 00 §4.1) ───────────────────────
// History for the doc on screen: the revision list, "changes since you last
// looked" (the changes banner), and the History modal's from/now/live hashes —
// for the attached doc, or for a pinned revision (no live sync there).

export function useRevisionTracking(opts: {
  pasteId: Ref<string | null>
  /** content_hash of the server copy the attached doc mirrors, and how it was learned. */
  serverHash: Ref<string | null>
  serverHashOrigin: Ref<'load' | 'save' | 'remote' | null>
  pinnedInfo: Ref<{ id: string } | null>
  route: ComputedRef<Route>
}) {
  const { pasteId, pinnedInfo, route } = opts
  const sync = { serverHash: opts.serverHash, serverHashOrigin: opts.serverHashOrigin }

  // ── Revision history / "what changed since I last looked" ─────────────────
  // The browser remembers the last content hash the reader ACKNOWLEDGED (wrote,
  // dismissed, or opened the diff for). Any other hash arriving on screen —
  // on open, on return, or live via polling — raises the changes banner, which
  // keeps pointing at the acknowledged hash until the reader acts on it.
  const revisionsApi = useRevisions()
  const revisionList = ref<RevisionEntry[]>([])
  const showHistory = ref(false)
  const historyFrom = ref<string | null>(null)
  const seenHash = ref<string | null>(null)
  let seenLoadedFor: string | null = null
  const pendingSince = ref<string | null>(null)
  const changeSummary = ref<SinceSummary | null>(null)

  function resetRevisionState() {
    revisionList.value = []
    showHistory.value = false
    historyFrom.value = null
    seenHash.value = null
    seenLoadedFor = null
    pendingSince.value = null
    changeSummary.value = null
  }

  async function refreshRevisions() {
    const id = pasteId.value
    if (!id) return
    const list = await revisionsApi.fetchList(id)
    if (!list || pasteId.value !== id) return
    revisionList.value = list.revisions
    updateSummary()
  }

  function updateSummary() {
    const current = sync.serverHash.value
    if (!pendingSince.value || !current) { changeSummary.value = null; return }
    const summary = summarizeSince(revisionList.value, pendingSince.value, current)
    if (!summary) pendingSince.value = null
    changeSummary.value = summary
  }

  /** The reader has looked at (or written) `hash`: remember it, drop the banner. */
  function acknowledge(hash: string | null) {
    const id = pasteId.value
    if (!id || !hash) return
    seenHash.value = hash
    pendingSince.value = null
    changeSummary.value = null
    revisionsApi.setSeen(id, hash)
  }

  function raiseBanner(since: string | null) {
    if (!since || since === sync.serverHash.value) return
    if (!pendingSince.value) pendingSince.value = since
    refreshRevisions()
  }

  async function initSeen(id: string) {
    const rec = await revisionsApi.getSeen(id)
    if (pasteId.value !== id) return
    seenLoadedFor = id
    seenHash.value = rec?.hash ?? null
    const current = sync.serverHash.value
    if (!current) return // reconciled by the serverHash watcher once known
    if (!seenHash.value) acknowledge(current) // first visit: nothing to compare against
    else if (seenHash.value !== current) raiseBanner(seenHash.value)
    refreshRevisions()
  }

  watch(pasteId, (id) => {
    resetRevisionState()
    if (id) initSeen(id)
  })

  watch(sync.serverHash, (hash, prev) => {
    const id = pasteId.value
    if (!id || !hash) return
    const origin = sync.serverHashOrigin.value
    if (origin === 'save') { acknowledge(hash); refreshRevisions(); return }
    if (seenLoadedFor !== id) return // initSeen will reconcile against this hash
    if (origin === 'remote') raiseBanner(prev ?? seenHash.value)
    else if (seenHash.value && seenHash.value !== hash) raiseBanner(seenHash.value)
    else if (!seenHash.value) acknowledge(hash)
    refreshRevisions()
  })

  /** Pinned revision on screen: its doc's current hash (history has no live sync there). */
  const pinnedCurrent = ref<string | null>(null)
  /** The doc whose history the modal shows: the attached doc, or the pinned revision's. */
  const historyId = computed(() => pasteId.value ?? pinnedInfo.value?.id ?? null)
  /** The "now" side of the history diff: the live doc, or the pinned revision on screen. */
  const historyCurrent = computed(() => {
    if (pasteId.value) return sync.serverHash.value
    const r = route.value
    return r.kind === 'pinned' ? r.rev : null
  })
  /** The doc's live content hash (what 'current' fetches). */
  const historyLive = computed(() => (pasteId.value ? sync.serverHash.value : pinnedCurrent.value))

  async function openHistory() {
    historyFrom.value = pendingSince.value
    const id = historyId.value
    if (!pasteId.value && id) {
      // No live sync on a pinned revision: fetch the list (and the doc's
      // current hash) before the modal opens on it.
      const list = await revisionsApi.fetchList(id)
      if (!list || historyId.value !== id) return
      revisionList.value = list.revisions
      pinnedCurrent.value = list.current
    } else if (pasteId.value) {
      // Live doc: the list is kept by polling; refresh it as the modal opens.
      refreshRevisions()
    }
    showHistory.value = true
  }

  return {
    revisionsApi, revisionList, showHistory, historyFrom, changeSummary,
    acknowledge, openHistory, historyId, historyCurrent, historyLive, pinnedCurrent,
  }
}

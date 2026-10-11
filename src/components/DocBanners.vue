<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { useDocState } from '@/composables/useDocState'
import { toast } from '@/composables/useToast'
import ApprovalBanner from '@/components/ApprovalBanner.vue'
import SummaryPanel from '@/components/SummaryPanel.vue'
import ChangesBanner from '@/components/ChangesBanner.vue'
import LocalCopyBanner from '@/components/LocalCopyBanner.vue'
import { focusActive } from '@/composables/useFocusMode'
// #28: lazy, off the #6 entry chunk — only agent views load it.
const AgentViewBanner = defineAsyncComponent(() => import('@/components/AgentViewBanner.vue'))

// The below-header stack (00 §2.4), top → bottom. doc-meta-row (1) lives in
// DocHeader. Later items add one line each in their slot:
//   #28 agent-view-banner after the pinned banner; #26 doc-breadcrumb + file-tabs last.
const doc = useDocState()
const {
  router, route, onScreen, pinnedInfo, notice, sync, reviewUI, pasteId, approvalInfo, unresolvedMustFixCount,
  reviewerName, setReviewerName, filename, comments, changeSummary, openHistory, acknowledge,
  view, contentType, fileView,
} = doc
const persistError = doc.persistence.persistError
/** #13 rule 3/4: focus mode hides the notice, approval, summary and changes banners — never the conflict or persist-error bars. */
const focusOn = focusActive()

/** The doc approvals go to: the attached doc, or a pinned revision's doc (status only there). */
const approvalTarget = computed(() => pasteId.value ?? pinnedInfo.value?.id ?? null)
const isPinned = computed(() => !pasteId.value && !!pinnedInfo.value)

const pinnedWhen = computed(() => {
  const at = pinnedInfo.value?.at
  if (!at) return 'an earlier point'
  const d = new Date(at)
  return isNaN(d.getTime()) ? at : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
})

async function decide(status: 'approved' | 'changes_requested', approvedBy: string) {
  const id = pasteId.value
  if (!id) return
  setReviewerName(approvedBy)
  const result = await doc.share.putApproval(id, status, approvedBy)
  if (result && !result.error) approvalInfo.value = result
  else toast.error(result?.error ? `Couldn't record the decision: ${result.error}` : "Couldn't record the decision. Check your connection and try again.")
}

/** Plain left click on an in-app link → pushState; modified clicks keep the browser default. */
function onAppLinkClick(e: MouseEvent, path: string) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  router.push(path)
}
</script>

<template>
  <!-- 2. pinned revision -->
  <div
    v-if="onScreen && pinnedInfo && route.kind === 'pinned'"
    class="notice-bar pinned-banner"
    role="status"
    data-testid="pinned-revision-banner"
  >
    <span>You're viewing a version from {{ pinnedWhen }}.</span>
    <a
      class="btn btn-ghost btn-sm"
      data-testid="pinned-revision-latest-link"
      :href="`${router.base}d/${pinnedInfo.id}`"
      @click="onAppLinkClick($event, `${router.base}d/${pinnedInfo.id}`)"
    >View the latest version</a>
  </div>

  <!-- 3. agent-view-banner (#28; markdown docs only — never HTML, rule 21) -->
  <AgentViewBanner v-if="onScreen && view === 'agent' && contentType === 'markdown' && !fileView" />

  <!-- 4. conflict, persist error -->
  <div v-if="onScreen && sync.conflict.value" class="conflict-bar" role="alert" data-testid="conflict-bar">
    <span class="conflict-text">
      <strong>Conflict:</strong> this document changed on the server while you had unsaved edits.
      Your edits are kept here until you choose.
    </span>
    <span class="conflict-actions">
      <button class="btn btn-ghost btn-sm" title="Discard your local edits and load the server copy" @click="sync.adoptRemote()">Use server version</button>
      <button class="btn btn-primary btn-sm" title="Overwrite the server copy with your edits" @click="sync.overwriteRemote()">Keep my version</button>
    </span>
  </div>
  <LocalCopyBanner />
  <div v-if="onScreen && persistError" class="notice-bar warn" role="status" data-testid="persist-error">
    <span>{{ persistError }}</span>
  </div>

  <!-- 5. notice -->
  <div v-if="notice" v-show="!focusOn" class="notice-bar" role="status">
    <span>{{ notice }}</span>
    <button class="btn btn-ghost btn-sm" @click="notice = null">Dismiss</button>
  </div>

  <!-- 6. approval + summary (review mode) -->
  <template v-if="onScreen && reviewUI && approvalTarget">
    <ApprovalBanner
      v-if="approvalInfo"
      v-show="!focusOn"
      :approval-status="approvalInfo.approval_status"
      :approved-by="approvalInfo.approved_by"
      :approved-at="approvalInfo.approved_at"
      :unresolved-must-fix-count="unresolvedMustFixCount"
      :paste-id="approvalTarget"
      :default-reviewer="reviewerName"
      :read-only-note="isPinned ? 'Open the latest version to approve or request changes.' : undefined"
      @approve="decide('approved', $event)"
      @request-changes="decide('changes_requested', $event)"
    />
    <SummaryPanel
      v-show="!focusOn"
      :filename="filename"
      :comments="comments"
      :approval-status="approvalInfo?.approval_status"
    />
  </template>

  <!-- 7. changes since you last looked -->
  <ChangesBanner
    v-if="onScreen && pasteId && changeSummary"
    v-show="!focusOn"
    :summary="changeSummary"
    @view="openHistory()"
    @dismiss="acknowledge(sync.serverHash.value)"
  />

  <!-- 8. doc-breadcrumb, file-tabs (#26) -->
</template>

<style scoped>
.notice-bar,
.conflict-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}

.notice-bar {
  background: var(--bg-page);
  color: var(--text-meta);
}

.notice-bar.warn {
  color: #b45309;
  background: rgba(245, 158, 11, 0.08);
}

.conflict-bar {
  background: rgba(220, 38, 38, 0.08);
  color: var(--text-primary);
  border-bottom-color: rgba(220, 38, 38, 0.35);
}

.conflict-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.pinned-banner {
  color: var(--text-primary);
}

/* Phone (#5 rule 9): text wraps, buttons stack below it. */
@media (max-width: 640.98px) {
  .notice-bar,
  .conflict-bar {
    flex-wrap: wrap;
    overflow-wrap: anywhere;
  }
  .conflict-actions {
    flex-basis: 100%;
    flex-wrap: wrap;
  }
}
</style>

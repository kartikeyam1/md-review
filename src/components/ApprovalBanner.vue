<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { ApprovalStatus } from '@/types'
import { useReviewer } from '@/composables/useReviewer'

const props = defineProps<{
  approvalStatus: ApprovalStatus
  approvedBy?: string | null
  approvedAt?: string | null
  unresolvedMustFixCount: number
  pasteId: string | null
  /** Remembered reviewer name to prefill the "Your name" field. */
  defaultReviewer?: string
  /** Status only, no actions (e.g. a pinned revision, #2): this text replaces them. */
  readOnlyNote?: string
}>()

const emit = defineEmits<{
  approve: [approvedBy: string]
  requestChanges: [approvedBy: string]
}>()

// One name per browser: the header's reviewer name. The banner only asks for it while none is
// set, and the name used to approve or request changes here becomes that name (one field, not two).
const reviewerName = ref(props.defaultReviewer ?? '')
watch(() => props.defaultReviewer, (n) => { if (n) reviewerName.value = n })
const { setReviewerName } = useReviewer()
function commitName() { if (!props.defaultReviewer && reviewerName.value.trim()) setReviewerName(reviewerName.value) }

const canApprove = computed(() =>
  props.unresolvedMustFixCount === 0 && reviewerName.value.trim().length > 0
)

const statusLabel = computed(() => {
  switch (props.approvalStatus) {
    case 'approved': return 'Approved'
    case 'changes_requested': return 'Changes Requested'
    default: return 'Pending Review'
  }
})

const statusClass = computed(() => props.approvalStatus)

function handleApprove() {
  if (!canApprove.value) return
  commitName()
  emit('approve', reviewerName.value.trim())
}

function handleRequestChanges() {
  if (!reviewerName.value.trim()) return
  commitName()
  emit('requestChanges', reviewerName.value.trim())
}

/** #5-style relative time for the approval ("3 min ago"), the exact local time on hover. */
function relTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
const exactTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
</script>

<template>
  <div class="approval-banner" :class="statusClass">
    <div class="approval-status">
      <span class="status-badge" :class="statusClass">{{ statusLabel }}</span>
      <span v-if="approvalStatus === 'approved' && approvedBy" class="approved-info">
        by {{ approvedBy }}
        <time v-if="approvedAt" class="approved-time" :datetime="approvedAt" :title="exactTime(approvedAt)">{{ relTime(approvedAt) }}</time>
      </span>
    </div>

    <div v-if="approvalStatus === 'approved' && unresolvedMustFixCount > 0" class="warning">
      ⚠ {{ unresolvedMustFixCount }} new must-fix comment{{ unresolvedMustFixCount > 1 ? 's' : '' }} added since approval
    </div>

    <span v-if="readOnlyNote" class="approval-note">{{ readOnlyNote }}</span>
    <div v-else-if="approvalStatus !== 'approved' || unresolvedMustFixCount > 0" class="approval-actions">
      <input
        v-if="!defaultReviewer"
        v-model="reviewerName"
        type="text"
        placeholder="Your name"
        aria-label="Your name"
        class="reviewer-input"
      />
      <span v-else class="approval-as" data-testid="approval-as">as {{ defaultReviewer }}</span>
      <button
        class="btn approve"
        :disabled="!canApprove"
        :title="unresolvedMustFixCount > 0 ? `${unresolvedMustFixCount} must-fix comment(s) unresolved` : ''"
        @click="handleApprove"
      >
        Approve
      </button>
      <button
        class="btn request-changes"
        :disabled="!reviewerName.trim()"
        @click="handleRequestChanges"
      >
        Request Changes
      </button>
    </div>
  </div>
</template>

<style scoped>
.approval-as {
  font-size: 13px;
  color: var(--text-meta);
}

.approval-note {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-secondary);
}

.approval-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
  flex-wrap: wrap;
}

.approval-status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-badge {
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.status-badge.pending { background: var(--status-warn-bg); color: var(--status-warn-fg); }
.status-badge.approved { background: var(--status-ok-bg); color: var(--status-ok-fg); }
.status-badge.changes_requested { background: var(--status-danger-bg); color: var(--status-danger-fg); }

.approved-info {
  font-size: 13px;
  color: var(--text-meta);
}
.approved-time {
  margin-left: 4px;
  opacity: 0.7;
}

.warning {
  font-size: 13px;
  color: var(--status-warn-text);
  background: var(--status-warn-bg);
  padding: 4px 10px;
  border-radius: 6px;
}

.approval-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

/* Phone (#5 rule 9): text wraps, the buttons get their own row. */
@media (max-width: 640.98px) {
  .approval-banner {
    overflow-wrap: anywhere;
  }
  .approval-actions,
  .approval-note {
    flex-basis: 100%;
    flex-wrap: wrap;
    margin-left: 0;
  }
  .reviewer-input {
    flex: 1 1 140px;
    min-width: 0;
  }
}

.reviewer-input {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  width: 140px;
  background: var(--bg-page);
  color: var(--text-primary);
}

.btn {
  padding: 4px 12px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.btn.approve {
  background: var(--status-ok);
  color: var(--status-ok-on);
}
.btn.approve:hover:not(:disabled) {
  background: var(--status-ok-hover);
}
.btn.request-changes {
  background: var(--cat-must-fix);
  color: var(--cat-must-fix-on);
}
.btn.request-changes:hover:not(:disabled) {
  filter: brightness(0.9);
}
</style>

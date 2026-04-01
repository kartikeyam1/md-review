<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ApprovalStatus } from '@/types'

const props = defineProps<{
  approvalStatus: ApprovalStatus
  approvedBy?: string | null
  approvedAt?: string | null
  unresolvedMustFixCount: number
  pasteId: string | null
}>()

const emit = defineEmits<{
  approve: [approvedBy: string]
  requestChanges: [approvedBy: string]
}>()

const reviewerName = ref('')

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
  if (canApprove.value) emit('approve', reviewerName.value.trim())
}

function handleRequestChanges() {
  if (reviewerName.value.trim()) emit('requestChanges', reviewerName.value.trim())
}
</script>

<template>
  <div class="approval-banner" :class="statusClass">
    <div class="approval-status">
      <span class="status-badge" :class="statusClass">{{ statusLabel }}</span>
      <span v-if="approvalStatus === 'approved' && approvedBy" class="approved-info">
        by {{ approvedBy }}
        <span v-if="approvedAt" class="approved-time">{{ new Date(approvedAt).toLocaleString() }}</span>
      </span>
    </div>

    <div v-if="approvalStatus === 'approved' && unresolvedMustFixCount > 0" class="warning">
      ⚠ {{ unresolvedMustFixCount }} new must-fix comment{{ unresolvedMustFixCount > 1 ? 's' : '' }} added since approval
    </div>

    <div v-if="approvalStatus !== 'approved' || unresolvedMustFixCount > 0" class="approval-actions">
      <input
        v-model="reviewerName"
        type="text"
        placeholder="Your name"
        class="reviewer-input"
      />
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
.status-badge.pending { background: #fef3c7; color: #92400e; }
.status-badge.approved { background: #d1fae5; color: #065f46; }
.status-badge.changes_requested { background: #fee2e2; color: #991b1b; }

.approved-info {
  font-size: 13px;
  color: var(--text-muted);
}
.approved-time {
  margin-left: 4px;
  opacity: 0.7;
}

.warning {
  font-size: 13px;
  color: #b45309;
  background: #fffbeb;
  padding: 4px 10px;
  border-radius: 6px;
}

.approval-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
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
  background: #059669;
  color: white;
}
.btn.approve:hover:not(:disabled) {
  background: #047857;
}
.btn.request-changes {
  background: #dc2626;
  color: white;
}
.btn.request-changes:hover:not(:disabled) {
  background: #b91c1c;
}
</style>

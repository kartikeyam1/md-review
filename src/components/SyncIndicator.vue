<script setup lang="ts">
import { computed } from 'vue'
import { useDocState } from '@/composables/useDocState'

// "Live" / "Offline · N pending" for a shared doc.
const { sync } = useDocState()
const syncStatus = computed(() => sync.syncStatus.value)
const pendingCount = computed(() => sync.pendingCount.value)
</script>

<template>
  <span v-if="syncStatus !== 'local'" class="sync-indicator" :class="syncStatus" :title="syncStatus === 'synced' ? 'Synced with server' : (pendingCount ? `${pendingCount} comment change(s) waiting to sync` : 'Cannot reach the review server — changes are kept locally and retried')">
    <span class="sync-dot"></span>
    <span class="sync-label">{{ syncStatus === 'synced' ? 'Live' : 'Offline' }}</span>
    <span v-if="pendingCount" class="sync-pending">· {{ pendingCount }} pending</span>
  </span>
</template>

<style scoped>
.sync-indicator {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-meta);
  padding: 0 4px;
  white-space: nowrap;
}

.sync-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #22c55e;
}

.sync-indicator.error .sync-dot {
  background: #ef4444;
}

.sync-label {
  font-weight: 500;
}

.sync-pending {
  font-size: 11px;
  color: var(--text-meta);
}
</style>

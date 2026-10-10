<script setup lang="ts">
import { ref, nextTick, onMounted } from 'vue'
import { useDocState } from '@/composables/useDocState'

// The self-declared reviewer name that signs comments, replies and approvals.
// `autoEdit`: opened from the overflow menu — start in the input, emit `done` when it closes.
const props = defineProps<{ autoEdit?: boolean }>()
const emit = defineEmits<{ done: [] }>()
const { reviewerName, setReviewerName } = useDocState()

const editingReviewer = ref(false)
const reviewerInput = ref<HTMLInputElement>()

async function startEditReviewer() {
  editingReviewer.value = true
  await nextTick()
  reviewerInput.value?.focus()
  reviewerInput.value?.select()
}

function commitReviewer() {
  if (!editingReviewer.value) return
  const val = (reviewerInput.value?.value ?? '').trim()
  if (val !== (reviewerName.value ?? '')) setReviewerName(val)
  editingReviewer.value = false
  emit('done')
}

function onReviewerKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') commitReviewer()
  if (e.key === 'Escape') { editingReviewer.value = false; emit('done') }
}

onMounted(() => { if (props.autoEdit) startEditReviewer() })
</script>

<template>
  <input
    v-if="editingReviewer"
    ref="reviewerInput"
    class="filename-edit reviewer-edit"
    :value="reviewerName ?? ''"
    placeholder="Your name"
    maxlength="80"
    data-testid="reviewer-input"
    @blur="commitReviewer"
    @keydown="onReviewerKeydown"
  />
  <button
    v-else
    class="reviewer"
    :class="{ unset: !reviewerName }"
    :title="reviewerName ? 'Comments, replies and approvals are signed with this name. Click to change.' : 'Set your name so your comments are signed'"
    data-testid="reviewer-name"
    @click="startEditReviewer"
  >
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
    {{ reviewerName || 'Set your name' }}
  </button>
</template>

<style scoped>
.filename-edit {
  font-size: 13px;
  font-family: var(--font-body);
  color: var(--text-primary);
  background: var(--bg-page);
  border: 1px solid var(--accent);
  border-radius: 3px;
  padding: 2px 4px;
  outline: none;
  width: 180px;
}

.reviewer {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--text-meta);
  font-size: 12px;
  font-family: var(--font-body);
  cursor: pointer;
  border-radius: 3px;
  padding: 2px 6px;
  white-space: nowrap;
}

.reviewer:hover {
  background: var(--bg-page);
  color: var(--text-primary);
}

.reviewer.unset {
  border: 1px dashed var(--border);
}

.reviewer-edit {
  width: 140px;
}
</style>

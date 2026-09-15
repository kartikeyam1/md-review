import { ref } from 'vue'

const REVIEWER_KEY = 'md-review-reviewer'

// Module-level so every component sees the same name.
const reviewerName = ref<string>(readStored())

function readStored(): string {
  try { return (localStorage.getItem(REVIEWER_KEY) || '').trim() } catch { return '' }
}

/**
 * Who is reviewing in this browser. Agents already sign their comments with an
 * `author`; people did not, so threads with several humans were unreadable.
 * The name is remembered per browser and stamped on comments, replies,
 * resolves and approvals.
 */
export function useReviewer() {
  function setReviewerName(name: string) {
    const trimmed = name.trim().slice(0, 80)
    reviewerName.value = trimmed
    try {
      if (trimmed) localStorage.setItem(REVIEWER_KEY, trimmed)
      else localStorage.removeItem(REVIEWER_KEY)
    } catch { /* storage unavailable — keep in memory */ }
  }

  /** `author` field to attach to a new comment/reply, or nothing when unset. */
  function authorField(): { author?: string } {
    return reviewerName.value ? { author: reviewerName.value } : {}
  }

  return { reviewerName, setReviewerName, authorField }
}

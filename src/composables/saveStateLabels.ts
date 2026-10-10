import type { SaveState } from '@/composables/useSync'

// Save-state wording shared by the header's `save-state` and focus mode's
// `focus-save-state` (#13 rule 5: same labels).
export const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  saved: 'Saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  error: 'Save failed',
  conflict: 'Conflict',
}

export const SAVE_TITLE: Record<SaveState, string> = {
  idle: '',
  saved: 'All changes are on the server',
  dirty: 'Edits not yet saved to the server — they autosave shortly, or press Save (Ctrl/Cmd+S)',
  saving: 'Writing to the server…',
  error: 'The last save failed. Your edits are kept locally — click to retry',
  conflict: 'The server copy changed while you had unsaved edits — choose a version below',
}

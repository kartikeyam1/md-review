<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import { useDocState } from '@/composables/useDocState'
import { tokenFor } from '@/composables/useEditToken'
import { toast } from '@/composables/useToast'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { copyText as writeClipboard } from '@/composables/useCopyLink'
import { EXPIRY_DAYS } from '@shared/expiry.mjs'

// Share dialog (#23 rule 10). Links are FE-built (00 §6): the view link is
// <origin><base>d/<slug||id>; the edit link adds ?edit=<token> and is shown
// only when this browser holds the token. A legacy (link-editable) doc shows
// one link and "Make view-only" (claim). Editors pick how long the doc lives.
// The agent prompt (review mode only) uses the API URLs as before.

const props = defineProps<{
  visible: boolean
  filename: string
  urls: { ui: string; api: string; comments: string; markdown: string } | null
  commentCount: number
  /** The session id (moved here from the header, #2). */
  pasteId?: string | null
}>()

const emit = defineEmits<{
  close: []
}>()

const doc = useDocState()
const { docLink, access, docMeta, reviewUI, capability } = doc

const copied = ref<string | null>(null)
/** The edit token this browser holds for the doc (re-read when the dialog opens and after a claim). */
const token = ref<string | null>(null)
const claiming = ref(false)
const savingExpiry = ref(false)

// 00 §3.4: a modal traps focus (it opens on the first Copy button) and gives it back on close —
// to Share in the bar, or to the overflow menu that held it.
const dialogRef = ref<HTMLElement | null>(null)
useFocusTrap(dialogRef, computed(() => props.visible), {
  initialFocus: () => dialogRef.value?.querySelector<HTMLElement>('[data-testid="share-copy-view"]'),
  returnFocus: () => document.querySelector<HTMLElement>('[data-testid="doc-header"] [data-testid="share-btn"]')
    ?? document.querySelector<HTMLElement>('[data-testid="header-overflow-btn"]'),
})

// Escape closes the dialog.
function onEscape(e: KeyboardEvent) { if (e.key === 'Escape' && !e.defaultPrevented) emit('close') }
watch(() => props.visible, (v) => {
  if (v) document.addEventListener('keydown', onEscape)
  else document.removeEventListener('keydown', onEscape)
}, { immediate: true })
onUnmounted(() => document.removeEventListener('keydown', onEscape))

watch(() => [props.visible, props.pasteId] as const, ([open, id]) => { if (open) token.value = tokenFor(id) }, { immediate: true })

/** Legacy doc: anyone with the link can edit (the server said so, and we hold no token). */
const legacy = computed(() => !token.value && access.value?.protected === false)
const viewUrl = computed(() => docLink.value ?? props.urls?.ui ?? '')
const editUrl = computed(() => (token.value && viewUrl.value ? `${viewUrl.value}?edit=${token.value}` : null))
const editor = computed(() => capability.value === 'editor')

// ── Expiry picker ───────────────────────────────────────────────────────────
const NEVER = 'never'
const EXPIRY_OPTIONS = [
  ...EXPIRY_DAYS.map((d) => ({ value: String(d), label: d === 1 ? '1 day' : `${d} days` })),
  { value: NEVER, label: 'Never' },
]
const expiresAt = computed(() => docMeta.value.expiresAt ?? null)
/** The last value this dialog applied (the server keeps only expires_at). */
const appliedDays = ref<string | null>(null)
watch(() => props.pasteId, () => { appliedDays.value = null })
/**
 * The option to preselect: what was last applied here, else Never for a doc
 * without expiry, else the smallest option covering the time left.
 */
const expiryValue = computed(() => {
  if (appliedDays.value) return appliedDays.value
  if (!expiresAt.value) return NEVER
  const left = (Date.parse(expiresAt.value) - Date.now()) / 86400000
  return String(EXPIRY_DAYS.find((d) => d >= left - 1 / 24) ?? EXPIRY_DAYS[EXPIRY_DAYS.length - 1])
})
const expiryLabel = computed(() => {
  if (!expiresAt.value) return 'Never expires'
  const d = new Date(expiresAt.value)
  return `Expires ${d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`
})

async function onExpiryChange(e: Event) {
  const id = props.pasteId
  if (!id) return
  const value = (e.target as HTMLSelectElement).value
  const previous = expiryValue.value
  appliedDays.value = value
  savingExpiry.value = true
  const res = await doc.share.putMetaDetailed(id, { expiry_days: value === NEVER ? null : Number(value) })
  savingExpiry.value = false
  if (props.pasteId !== id) return
  if (res) {
    docMeta.value = { ...docMeta.value, expiresAt: res.expires_at ?? null }
  } else {
    appliedDays.value = previous
    ;(e.target as HTMLSelectElement).value = previous
    if (capability.value === 'editor') toast.error("Couldn't change the expiry. Check your connection and try again.")
  }
}

// ── Make view-only (claim a legacy doc) ─────────────────────────────────────
async function makeViewOnly() {
  const id = props.pasteId
  if (!id || claiming.value) return
  claiming.value = true
  const t = await doc.share.claimEditToken(id, null, docMeta.value.slug)
  claiming.value = false
  if (props.pasteId !== id) return
  if (t) {
    token.value = t
    access.value = { protected: true, can_edit: true }
  } else {
    toast.error("Couldn't make this document view-only. Try again.")
  }
}

const sharePrompt = computed(() => {
  if (!props.urls) return ''
  const lines = [
    `Review the document "${props.filename}" and address the review comments.`,
    '',
    `Document + comments: ${props.urls.api}`,
    `Comments only:       ${props.urls.comments}`,
    `Markdown only:       ${props.urls.markdown}`,
    '',
    `Fetch the URLs above (JSON) to get the content. The document has ${props.commentCount} review comment${props.commentCount === 1 ? '' : 's'}.`,
  ]
  return lines.join('\n')
})

/** The button says "Copied!" and, like every copy in the app, a toast confirms it. */
async function copyText(text: string, label: string) {
  const ok = await writeClipboard(text)
  if (!ok) { toast.error("Couldn't copy. Select the text and copy it by hand."); return }
  copied.value = label
  toast.info(label === 'prompt' ? 'Prompt copied' : 'Link copied')
  setTimeout(() => { copied.value = null }, 2000)
}
</script>

<template>
  <div v-if="visible" class="modal-overlay" @click.self="emit('close')">
    <div ref="dialogRef" class="modal" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title" data-testid="share-dialog">
      <div class="modal-header">
        <h2 id="share-dialog-title" class="modal-title">Share</h2>
        <button type="button" class="modal-close" aria-label="Close" @click="emit('close')">&times;</button>
      </div>
      <div class="modal-body">
        <div class="url-row">
          <label class="url-label">{{ legacy ? 'Link' : 'View link' }}</label>
          <p v-if="legacy" class="url-hint warn">Anyone with this link can edit</p>
          <p v-else class="url-hint">Read-only: people with this link can read{{ reviewUI ? ' and comment' : '' }}</p>
          <div class="url-value">
            <code id="share-view-url" data-testid="share-view-url">{{ viewUrl }}</code>
            <button class="btn-copy" data-testid="share-copy-view" @click="copyText(viewUrl, 'view')">{{ copied === 'view' ? 'Copied!' : 'Copy' }}</button>
          </div>
          <div v-if="legacy && editor" class="protect-row">
            <button class="btn btn-ghost" data-testid="share-protect-btn" :disabled="claiming" @click="makeViewOnly">{{ claiming ? 'Working…' : 'Make view-only' }}</button>
            <span class="url-hint">Gives you a separate edit link; the link above becomes read-only.</span>
          </div>
        </div>

        <div v-if="editUrl" class="url-row">
          <label class="url-label">Edit link</label>
          <p class="url-hint warn" data-testid="share-edit-warning">Anyone with this link can edit</p>
          <div class="url-value">
            <code id="share-edit-url" data-testid="share-edit-url">{{ editUrl }}</code>
            <button class="btn-copy" data-testid="share-copy-edit" @click="copyText(editUrl, 'edit')">{{ copied === 'edit' ? 'Copied!' : 'Copy' }}</button>
          </div>
        </div>

        <div v-if="editor && pasteId" class="url-row expiry-row">
          <label class="url-label" for="share-expiry-select">Delete after</label>
          <div class="url-value">
            <select id="share-expiry-select" class="expiry-select" data-testid="share-expiry-select" :value="expiryValue" :disabled="savingExpiry" @change="onExpiryChange">
              <option v-for="o in EXPIRY_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span class="expiry-label" data-testid="share-expiry-label">{{ expiryLabel }}</span>
          </div>
        </div>

        <div v-if="pasteId" class="url-row">
          <label class="url-label">Document id</label>
          <div class="url-value">
            <code class="doc-id-value">{{ pasteId }}</code>
          </div>
        </div>

        <template v-if="reviewUI">
          <div class="divider"></div>

          <label class="url-label">Agent prompt</label>
          <pre class="prompt-text">{{ sharePrompt }}</pre>
          <div class="prompt-actions">
            <button class="btn btn-primary" @click="copyText(sharePrompt, 'prompt')">{{ copied === 'prompt' ? 'Copied!' : 'Copy Prompt' }}</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-bg, rgba(26, 22, 18, 0.5));
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 400;
}

.modal {
  background: var(--bg-surface);
  border-radius: 8px;
  width: min(calc(100vw - 32px), 580px);
  max-height: 80vh;
  max-height: 80dvh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px var(--shadow-color, rgba(26, 22, 18, 0.15));
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.modal-title {
  font-family: var(--font-heading);
  font-size: 18px;
  font-weight: 600;
}

.modal-close {
  background: none;
  border: none;
  font-size: 20px;
  color: var(--text-meta);
  padding: 4px 8px;
}

.modal-close:hover {
  color: var(--text-primary);
}

.modal-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.url-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.url-row + .url-row {
  margin-top: 16px;
}

.url-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-meta);
}

.url-hint.warn {
  color: var(--accent-text);
  font-weight: 600;
}

.protect-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.expiry-select {
  font-family: var(--font-body);
  font-size: 13px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text-primary);
}

.expiry-label {
  font-size: 13px;
  color: var(--text-secondary);
}

.url-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-meta);
}

.url-value {
  display: flex;
  align-items: center;
  gap: 8px;
}

.url-value code {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 13px;
  background: var(--bg-page);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.btn-copy {
  flex-shrink: 0;
  padding: 6px 12px;
  font-size: 12px;
  font-family: var(--font-body);
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
}

.btn-copy:hover {
  color: var(--text-primary);
  border-color: var(--text-muted);
}

.divider {
  height: 1px;
  background: var(--border);
  margin: 16px 0;
}

.prompt-text {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  background: var(--bg-page);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 14px;
  white-space: pre-wrap;
  word-wrap: break-word;
  margin-top: 6px;
}

.prompt-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
</style>

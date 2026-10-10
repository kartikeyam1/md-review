import { computed, inject, type InjectionKey, type Ref } from 'vue'
import type { PaneMode, DocMode } from '@/types'
import type { RouterLocation, Route } from '@/composables/useRouter'
import type { DocState } from '@/composables/docState'

// ── Doc axes (spec #2, 00 §1 / §4.1) ─────────────────────────────────────────
// The one place that decides view, mode, capability, routeKind and isShared —
// every piece of UI reads these (via useDocState()), nothing else decides them.
// #23 swaps the capability source (canEdit = access.can_edit); #7/#28/#29 add views.
// Mode (#2): `publish` is a reading page, `review` adds comments + approval;
// it hides review UI for everyone, and only editors may change it.
//
// The rest of the doc state is assembled in docState.ts (createDocState) from
// useRevisionTracking, useAutosave, useCommentSelection and useDocModeSync.

export type RouteKind = 'doc' | 'pinned' | 'file' | 'embed'
export type Capability = 'viewer' | 'editor'
export type DocViewName = 'read' | 'edit' | 'split'

export interface DocAxesInput {
  routeKind: Route['kind']
  embed: boolean
  paneMode: PaneMode
  pasteId: string | null
  mode: DocMode
  /**
   * #23: may this browser edit the shared doc? `access.can_edit` from the
   * latest GET (legacy docs and older servers: true). Ignored for local docs.
   */
  canEdit?: boolean
}

export interface DocAxes {
  /** doc | pinned | file | embed — the landing route's local doc counts as `doc`. */
  routeKind: RouteKind
  capability: Capability
  view: DocViewName
  isShared: boolean
  mode: DocMode
  /** Review UI (comments, approval, summary, prompt generator) is shown. */
  reviewUI: boolean
}

/** The panes a resolved view puts on screen (read, and views not built here, show the preview). */
export function paneModeFor(view: string): PaneMode {
  return view === 'edit' || view === 'split' ? view : 'preview'
}

/** Pure: the axes for one screen state (00 §1). */
export function resolveDocAxes(input: DocAxesInput): DocAxes {
  const routeKind: RouteKind = input.embed ? 'embed'
    : input.routeKind === 'pinned' ? 'pinned'
      : input.routeKind === 'file' ? 'file'
        : 'doc'
  // Pinned revisions, file routes and embeds are read-only (00 §1.2); a shared
  // doc is editable only with edit access (#23 — a protected doc without a valid token is view-only).
  const canEdit = !input.pasteId || input.canEdit !== false
  const capability: Capability = routeKind === 'doc' && canEdit ? 'editor' : 'viewer'
  // Edit and split are editing views (#7): only an editor gets them.
  const view: DocViewName = capability === 'editor' && input.paneMode !== 'preview' ? input.paneMode : 'read'
  return { routeKind, capability, view, isShared: !!input.pasteId, mode: input.mode, reviewUI: input.mode === 'review' }
}

export const isEmbedLocation = (loc: RouterLocation) => new URLSearchParams(loc.search).get('embed') === '1'
export const isReadOnlyLocation = (loc: RouterLocation) =>
  isEmbedLocation(loc) || loc.route.kind === 'pinned' || loc.route.kind === 'file'

/** The axes as computed refs over the doc state's inputs. */
export function useDocAxes(inputs: {
  route: Ref<Route>
  embed: Ref<boolean>
  paneMode: Ref<PaneMode>
  pasteId: Ref<string | null>
  mode: Ref<DocMode>
  canEdit?: Ref<boolean>
}) {
  const axes = computed(() => resolveDocAxes({
    routeKind: inputs.route.value.kind,
    embed: inputs.embed.value,
    paneMode: inputs.paneMode.value,
    pasteId: inputs.pasteId.value,
    mode: inputs.mode.value,
    canEdit: inputs.canEdit?.value ?? true,
  }))
  return {
    routeKind: computed(() => axes.value.routeKind),
    capability: computed(() => axes.value.capability),
    view: computed(() => axes.value.view),
    isShared: computed(() => axes.value.isShared),
    reviewUI: computed(() => axes.value.reviewUI),
  }
}

export const DOC_STATE: InjectionKey<DocState> = Symbol('md-review-doc-state')

/** Any component under App: the doc state (created once by provideDocState in docState.ts). */
export function useDocState(): DocState {
  const state = inject(DOC_STATE)
  if (!state) throw new Error('useDocState() called outside of a provideDocState() tree')
  return state
}

export type { DocState }

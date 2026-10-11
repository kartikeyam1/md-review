<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, watch, watchEffect } from 'vue'
import { provideDocState } from '@/composables/docState'
import { useDocLoader } from '@/composables/useDocLoader'
import { useGlobalShortcuts } from '@/composables/useGlobalShortcuts'
import { shortcutsHelpShortcut } from '@/composables/useShortcutsOverlay'
import { useRouter } from '@/composables/useRouter'
import { installEditTokenHook, docIdOf } from '@/composables/useEditToken'
import DocView from '@/components/DocView.vue'
import RouteNotFound from '@/components/RouteNotFound.vue'
import AppToast from '@/components/AppToast.vue'
import ThemeSwitcher from '@/components/ThemeSwitcher.vue'
import { APP_NAME, formatDocumentTitle } from '@/composables/useDocTitle'
import { useReader } from '@/composables/useReader'
import { PASTE_API } from '@/composables/pasteApi'

// The library is its own chunk: doc readers never download it (#6 entry budget).
const LibraryView = defineAsyncComponent(() => import('@/components/LibraryView.vue'))

// The router shell (00 §4.2): landing / doc routes → DocView, the library,
// not-found. The doc state lives here so it survives a trip to the library.

// ── Routing (spec #4) ─────────────────────────────────────────────────────
// bootstrap() strips ?edit=, applies the legacy #shared=/#dashboard redirects
// and canonical rewrites with replaceState — before the first render.
const router = useRouter()
// #23: the ?edit= token goes to useEditToken (held until the doc's GET confirms it).
installEditTokenHook()
const { redirected: legacyRedirected } = router.bootstrap()

const doc = provideDocState(router)
const loader = useDocLoader(doc, { legacyRedirected })
const { sync, flushAutosave, route, embed } = doc

useGlobalShortcuts([
  // Mod+S saves a shared doc now (00 §3.5).
  { key: 's', mod: true, when: () => doc.appMode.value === 'doc' && doc.capability.value === 'editor', run: () => { if (sync.isShared.value) flushAutosave() } },
  shortcutsHelpShortcut, // `?` opens the shortcuts overlay in edit/split views (#9)
])

const docArea = computed(() => embed.value || (route.value.kind !== 'library' && route.value.kind !== 'not-found'))

// The tab title (#5 rule 18): `<docTitle> · md-review` while a doc is open,
// fixed titles for the library / not-found pages, else the app name.
const pageTitle = computed(() => {
  const kind = route.value.kind
  if (!embed.value && kind === 'library') return `Library · ${APP_NAME}`
  if (kind === 'not-found' || doc.docMissing.value) return `Not found · ${APP_NAME}`
  if (doc.onScreen.value) return formatDocumentTitle(doc.docTitle.value)
  return APP_NAME
})
watchEffect(() => { document.title = pageTitle.value })

function goHome() {
  router.push(router.base)
}

// #26 rule 10: a shared doc opened at /d/:slug goes to the local recently-viewed
// list ({id, slug, title, viewedAt}); a title change while it is open updates it
// (debounced). The list code is lazy (#6 entry budget).
watch(
  () => (doc.onScreen.value && !embed.value && route.value.kind === 'doc' && doc.pasteId.value
    ? { id: docIdOf(doc.pasteId.value), slug: doc.docMeta.value.slug ?? null, title: doc.docTitle.value }
    : null),
  (now, before) => {
    if (now && before && before.id === now.id && before.title === now.title && before.slug === now.slug) return
    import('@/composables/useRecent').then((m) => m.noteRecent(now), () => { /* offline: not recorded */ })
  },
)

// #26 rule 8 / 00 §7: pins are keyed by reader_key. When a name is set for the
// first time, the anonymous id's pins are copied to the name.
const reader = useReader()
watch(reader.readerName, (name, prev) => {
  if (!name || prev) return
  fetch(`${PASTE_API}/library/pins/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...reader.readerHeader.value },
    body: JSON.stringify({ from: reader.readerId }),
  }).catch(() => { /* best effort: the anonymous pins stay on the anonymous key */ })
})

// Leave-page handling (beforeunload / pagehide) lives in useAutosave.
onMounted(() => { loader.boot() })
</script>

<template>
  <DocView v-if="docArea" />
  <div v-else class="app">
    <template v-if="route.kind === 'not-found'">
      <!-- The theme switcher (#1) on pages without a doc header (the library has its own). -->
      <div class="app-bar" data-testid="app-bar">
        <ThemeSwitcher />
      </div>
      <RouteNotFound kind="route" :home="router.base" @home="goHome" />
    </template>
    <LibraryView v-else @new-doc="loader.handleNewDoc" />
  </div>
  <AppToast />
</template>

<style scoped>
.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.app-bar {
  display: flex;
  justify-content: flex-end;
  padding: 10px 16px 0;
}
</style>

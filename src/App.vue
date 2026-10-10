<script setup lang="ts">
import { computed, onMounted, watchEffect } from 'vue'
import { provideDocState } from '@/composables/docState'
import { useDocLoader } from '@/composables/useDocLoader'
import { useGlobalShortcuts } from '@/composables/useGlobalShortcuts'
import { shortcutsHelpShortcut } from '@/composables/useShortcutsOverlay'
import { useRouter } from '@/composables/useRouter'
import { installEditTokenHook } from '@/composables/useEditToken'
import DocView from '@/components/DocView.vue'
import DashboardView from '@/components/DashboardView.vue'
import RouteNotFound from '@/components/RouteNotFound.vue'
import AppToast from '@/components/AppToast.vue'
import ThemeSwitcher from '@/components/ThemeSwitcher.vue'
import { APP_NAME, formatDocumentTitle } from '@/composables/useDocTitle'

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

// Leave-page handling (beforeunload / pagehide) lives in useAutosave.
onMounted(() => { loader.boot() })
</script>

<template>
  <DocView v-if="docArea" />
  <div v-else class="app">
    <!-- The theme switcher (#1) on pages without a doc header. -->
    <div class="app-bar" data-testid="app-bar">
      <ThemeSwitcher />
    </div>
    <RouteNotFound v-if="route.kind === 'not-found'" kind="route" :home="router.base" @home="goHome" />
    <DashboardView v-else @new-doc="loader.handleNewDoc" />
  </div>
  <AppToast />
</template>

<style scoped>
.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.app-bar {
  display: flex;
  justify-content: flex-end;
  padding: 10px 16px 0;
}
</style>

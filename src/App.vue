<script setup lang="ts">
import { computed, onMounted } from 'vue'
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

function goHome() {
  router.push(router.base)
}

// Leave-page handling (beforeunload / pagehide) lives in useAutosave.
onMounted(() => { loader.boot() })
</script>

<template>
  <DocView v-if="docArea" />
  <div v-else class="app">
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
</style>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { provideDocState } from '@/composables/useDocState'
import { useDocLoader } from '@/composables/useDocLoader'
import { useGlobalShortcuts } from '@/composables/useGlobalShortcuts'
import { useRouter } from '@/composables/useRouter'
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
const { redirected: legacyRedirected } = router.bootstrap()

const doc = provideDocState(router)
const loader = useDocLoader(doc, { legacyRedirected })
const { sync, flushAutosave, route, embed } = doc

useGlobalShortcuts([
  // Mod+S saves a shared doc now (00 §3.5).
  { key: 's', mod: true, when: () => doc.appMode.value === 'review', run: () => { if (sync.isShared.value) flushAutosave() } },
])

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!sync.isShared.value) return
  if (sync.isDirty.value || sync.conflict.value || sync.saveState.value === 'saving') {
    e.preventDefault()
    e.returnValue = ''
  }
}

function onPageHide() {
  if (sync.isShared.value && sync.isDirty.value && !sync.conflict.value) flushAutosave({ keepalive: true })
}

function onVisibilityChange() {
  if (document.hidden) onPageHide()
}

const docArea = computed(() => embed.value || (route.value.kind !== 'library' && route.value.kind !== 'not-found'))

function goHome() {
  router.push(router.base)
}

onMounted(async () => {
  await loader.boot()
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('pagehide', onPageHide)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
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

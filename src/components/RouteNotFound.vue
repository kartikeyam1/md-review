<script setup lang="ts">
// Not-found states for path routes (spec #4): an unknown route, a doc that
// answered 404/410 (never the upload screen), or a pinned revision whose
// content is no longer stored.
const props = defineProps<{
  kind: 'route' | 'doc' | 'revision-gone'
  /** The landing URL (app base). */
  home: string
}>()

const emit = defineEmits<{ home: [] }>()

function onHome(e: MouseEvent) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  emit('home')
}

const TEXT = {
  route: { title: 'Page not found', body: 'There is nothing at this address.' },
  doc: { title: 'Document not found', body: "This document doesn't exist or has expired." },
  'revision-gone': { title: 'Version not available', body: 'This version of the document is no longer stored.' },
} as const
</script>

<template>
  <div class="route-not-found" :data-testid="props.kind === 'route' ? 'not-found' : 'doc-not-found'" role="status">
    <h2>{{ TEXT[props.kind].title }}</h2>
    <p>{{ TEXT[props.kind].body }}</p>
    <a class="btn btn-primary" :href="props.home" @click="onHome">Go to md-review home</a>
  </div>
</template>

<style scoped>
.route-not-found {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px 16px;
  text-align: center;
  color: var(--text-secondary);
}

.route-not-found h2 {
  font-family: var(--font-heading);
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary);
}

.route-not-found a {
  text-decoration: none;
}
</style>

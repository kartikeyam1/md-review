<script setup lang="ts">
import { ref } from 'vue'
import type { AppMode, PaneMode } from '@/types'

const appMode = ref<AppMode>('upload')
const paneMode = ref<PaneMode>('edit')
const markdown = ref('')
const filename = ref('')

function handleFileLoaded(content: string, name: string) {
  markdown.value = content
  filename.value = name
  appMode.value = 'review'
}

// Expose for future use by child components
defineExpose({ appMode, paneMode, markdown, filename, handleFileLoaded })
</script>

<template>
  <div class="app">
    <p>MD Review — scaffold working</p>
  </div>
</template>

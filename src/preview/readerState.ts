import { watchEffect } from 'vue'
import type { Enhancer } from './enhancers'
import { useReaderPrefs } from '@/composables/useReaderPrefs'

// #18 rule 6: the pane shows the reader's prefs for tests and styling hooks
// (`data-reader-font-scale`, `data-reader-width`). The prefs themselves act
// through <html> (useReaderPrefs); this only mirrors them onto the pane.
export const readerState: Enhancer = (container) => {
  const { fontScale, width } = useReaderPrefs()
  return watchEffect(() => {
    container.dataset.readerFontScale = String(fontScale.value)
    container.dataset.readerWidth = width.value
  })
}

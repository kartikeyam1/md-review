<script setup lang="ts">
import { computed } from 'vue'
import { useDocState } from '@/composables/useDocState'
import { useSessionFiles } from '@/composables/useSessionFiles'
import { breadcrumbSegments, phoneBreadcrumb, type Crumb } from '@/composables/sessionFiles'
import { useBreakpoint } from '@/composables/useBreakpoint'

// #26 rule 24: `Library › <Collection> › <Doc title> › <file>` (00 §2.4 position 8,
// above the file tabs). Shown when the doc is in a collection or has file tabs.
// On a phone it stays on one line: the collection collapses to `…` and the
// doc title ellipsizes.
const doc = useDocState()
const files = useSessionFiles()
const bp = useBreakpoint()

const segments = computed<Crumb[]>(() => {
  const all = breadcrumbSegments({
    base: doc.router.base,
    docKey: files.docKey.value ?? '',
    docTitle: doc.docTitle.value,
    collection: files.collection.value,
    file: files.currentFile.value,
  })
  return bp.value === 'phone' ? phoneBreadcrumb(all) : all
})

function go(e: MouseEvent, href: string) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  doc.router.push(href)
}
</script>

<template>
  <nav v-if="files.breadcrumbShown.value" class="doc-breadcrumb" data-testid="doc-breadcrumb" aria-label="Breadcrumb" :data-breakpoint="bp">
    <ol>
      <li v-for="s in segments" :key="s.kind" :class="['crumb', `crumb-${s.kind}`, { collapsed: s.label !== s.title }]">
        <a
          v-if="s.href"
          :href="s.href"
          :title="s.title"
          :data-testid="`breadcrumb-${s.kind}`"
          @click="go($event, s.href)"
        >{{ s.label }}</a>
        <span
          v-else
          :title="s.title"
          :data-testid="`breadcrumb-${s.kind}`"
          aria-current="page"
        >{{ s.label }}</span>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.doc-breadcrumb {
  flex-shrink: 0;
  min-width: 0;
  padding: 6px 16px 0;
  background: var(--bg-surface);
  font-size: 13px;
  line-height: 20px;
  color: var(--text-muted);
}

.doc-breadcrumb[data-breakpoint='phone'] {
  padding: 6px 12px 0;
}

ol {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  white-space: nowrap;
  overflow: hidden;
}

.crumb {
  display: flex;
  align-items: center;
  min-width: 0;
  flex-shrink: 0;
}

/* The separator belongs to the item it precedes (no extra text in the segments). */
.crumb + .crumb::before {
  content: '›';
  padding: 0 6px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.crumb a,
.crumb span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crumb a {
  color: var(--text-muted);
  text-decoration: none;
  border-radius: 4px;
}

.crumb a:hover {
  color: var(--text-primary);
  text-decoration: underline;
}

.crumb a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.crumb [aria-current='page'] {
  color: var(--text-primary);
  font-weight: 500;
}

/* Middle segments give way first (the doc title far more than the collection);
   the file — or the current doc — keeps the most room. */
.crumb-collection {
  flex-shrink: 1;
  max-width: 30%;
}

.crumb-collection.collapsed {
  flex-shrink: 0;
  max-width: none;
}

.crumb-doc {
  flex-shrink: 8;
  min-width: 2.5em;
}

.crumb-file {
  flex-shrink: 0;
  max-width: 60%;
}

.crumb-doc:last-child {
  flex-shrink: 1;
}
</style>

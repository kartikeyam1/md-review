// Lazy highlight.js languages (src/markdown/highlight.ts): the entry bundles a
// few common languages; the rest load per language on first use.
import { describe, it, expect } from 'vitest'
import hljs from 'highlight.js/lib/core'
import { FENCE_LANGUAGES, LAZY_LANGUAGES, highlightCode, highlightRevision, loadFenceLanguages } from '@/markdown/highlight'
import { useMarkdown } from '@/composables/useMarkdown'

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('lazy highlight.js languages', () => {
  it('each lazy language declares exactly its definition\'s aliases (fences find it before it loads)', async () => {
    for (const [name, { aliases }] of Object.entries(LAZY_LANGUAGES)) {
      const def = (await import(`../../node_modules/highlight.js/es/languages/${name}.js`)).default
      expect([...aliases], name).toEqual(def(hljs).aliases ?? [])
    }
  })

  it('eager languages highlight synchronously', () => {
    expect(highlightCode('const a = 1', 'typescript')).toContain('hljs-keyword')
    expect(highlightCode('def f(): pass', 'py')).toContain('hljs-keyword')
  })

  it('a lazy language renders escaped first, then highlights after it loads and the revision bumps', async () => {
    const { renderHtml } = useMarkdown()
    const src = '```kotlin\nfun main() {}\n```\n'
    const before = highlightRevision.value
    expect(renderHtml(src)).not.toContain('hljs-')
    for (let i = 0; i < 50 && highlightRevision.value === before; i++) await flush()
    expect(highlightRevision.value).toBeGreaterThan(before)
    expect(renderHtml(src)).toContain('hljs-keyword')
  })

  it('loadFenceLanguages loads the languages a source names, by alias too', async () => {
    await loadFenceLanguages('# t\n\n~~~rs\nfn main() {}\n~~~\n\n> ```golang\n> package main\n> ```\n')
    expect(hljs.getLanguage('rust')).toBeTruthy()
    expect(hljs.getLanguage('go')).toBeTruthy()
    expect(highlightCode('fn main() {}', 'rs')).toContain('hljs-keyword')
  })

  it('unknown languages stay escaped text and request nothing', async () => {
    const before = highlightRevision.value
    expect(highlightCode('resource "x" {}', 'terraform')).toBe('')
    await flush()
    expect(highlightRevision.value).toBe(before)
  })

  it('FENCE_LANGUAGES lists every eager and lazy language once, sorted', () => {
    const names = FENCE_LANGUAGES.map((l) => l.name)
    for (const n of ['javascript', 'python', ...Object.keys(LAZY_LANGUAGES), 'html', 'gradle']) expect(names).toContain(n)
    expect([...names].sort()).toEqual(names)
    expect(FENCE_LANGUAGES.find((l) => l.name === 'cpp')!.aliases).toContain('hpp')
  })
})

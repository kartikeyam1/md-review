import { shallowRef } from 'vue'
// highlight.js core + a curated language set. The default 'highlight.js' entry
// bundles every language (~1 MB minified); the languages below cover what shows
// up in review documents. Unregistered languages fall back to plain escaped code.
//
// Entry budget (#6 AC-06.8): only the languages most docs use are bundled in the
// entry, so their fences highlight on the first render. The rest are one small
// lazy chunk each, fetched the first time a fence names them; until it arrives
// that fence renders as escaped text, then `highlightRevision` bumps and the
// preview re-renders with colours. Shared and pinned docs prefetch their fence
// languages before the first render (useDocLoader), so in practice the swap is
// only seen for languages first typed in the editor, or on a slow network.
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import shell from 'highlight.js/lib/languages/shell'
import python from 'highlight.js/lib/languages/python'
import yaml from 'highlight.js/lib/languages/yaml'
import xml from 'highlight.js/lib/languages/xml'
import markdown from 'highlight.js/lib/languages/markdown'
import diff from 'highlight.js/lib/languages/diff'
import plaintext from 'highlight.js/lib/languages/plaintext'

type LanguageFn = Parameters<typeof hljs.registerLanguage>[1]

const EAGER: Record<string, LanguageFn> = {
  javascript, typescript, json, bash, shell, python, yaml, xml, markdown, diff, plaintext,
}

interface LazyLanguage {
  load: () => Promise<{ default: LanguageFn }>
  /** The definition's own `aliases` (kept in step by tests/markdown/highlight.test.ts). */
  aliases: readonly string[]
}

/** Lazy languages: one chunk each. `aliases` mirror each definition's, so a fence can find them before they load. */
const LAZY: Record<string, LazyLanguage> = {
  java: { load: () => import('highlight.js/lib/languages/java'), aliases: ['jsp'] },
  kotlin: { load: () => import('highlight.js/lib/languages/kotlin'), aliases: ['kt', 'kts'] },
  go: { load: () => import('highlight.js/lib/languages/go'), aliases: ['golang'] },
  rust: { load: () => import('highlight.js/lib/languages/rust'), aliases: ['rs'] },
  css: { load: () => import('highlight.js/lib/languages/css'), aliases: [] },
  scss: { load: () => import('highlight.js/lib/languages/scss'), aliases: [] },
  sql: { load: () => import('highlight.js/lib/languages/sql'), aliases: [] },
  dockerfile: { load: () => import('highlight.js/lib/languages/dockerfile'), aliases: ['docker'] },
  ini: { load: () => import('highlight.js/lib/languages/ini'), aliases: ['toml'] },
  c: { load: () => import('highlight.js/lib/languages/c'), aliases: ['h'] },
  cpp: { load: () => import('highlight.js/lib/languages/cpp'), aliases: ['cc', 'c++', 'h++', 'hpp', 'hh', 'hxx', 'cxx'] },
  csharp: { load: () => import('highlight.js/lib/languages/csharp'), aliases: ['cs', 'c#'] },
  ruby: { load: () => import('highlight.js/lib/languages/ruby'), aliases: ['rb', 'gemspec', 'podspec', 'thor', 'irb'] },
  php: { load: () => import('highlight.js/lib/languages/php'), aliases: [] },
  swift: { load: () => import('highlight.js/lib/languages/swift'), aliases: [] },
  groovy: { load: () => import('highlight.js/lib/languages/groovy'), aliases: [] },
  makefile: { load: () => import('highlight.js/lib/languages/makefile'), aliases: ['mk', 'mak', 'make'] },
  http: { load: () => import('highlight.js/lib/languages/http'), aliases: ['https'] },
  graphql: { load: () => import('highlight.js/lib/languages/graphql'), aliases: ['gql'] },
  properties: { load: () => import('highlight.js/lib/languages/properties'), aliases: [] },
  protobuf: { load: () => import('highlight.js/lib/languages/protobuf'), aliases: ['proto'] },
  lua: { load: () => import('highlight.js/lib/languages/lua'), aliases: ['pluto'] },
  perl: { load: () => import('highlight.js/lib/languages/perl'), aliases: ['pl', 'pm'] },
  r: { load: () => import('highlight.js/lib/languages/r'), aliases: [] },
  scala: { load: () => import('highlight.js/lib/languages/scala'), aliases: [] },
}

for (const [name, def] of Object.entries(EAGER)) hljs.registerLanguage(name, def)
// Common fence names that are not built-in aliases (registering an alias for a
// language that is not loaded yet is fine: hljs resolves it at lookup time).
const EXTRA_ALIASES: Record<string, string[]> = {
  xml: ['html', 'vue', 'svelte'],
  json: ['jsonc', 'json5'],
  groovy: ['gradle'],
  ini: ['toml'],
  bash: ['zsh', 'sh'],
  plaintext: ['text', 'txt', 'plain'],
}
for (const [languageName, aliases] of Object.entries(EXTRA_ALIASES)) hljs.registerAliases(aliases, { languageName })

/** Fence name (lower-cased name or alias) → lazy language key. */
const LAZY_BY_NAME = new Map<string, string>()
for (const [name, { aliases }] of Object.entries(LAZY)) for (const n of [name, ...aliases]) LAZY_BY_NAME.set(n, name)
for (const [name, aliases] of Object.entries(EXTRA_ALIASES)) if (LAZY[name]) for (const a of aliases) LAZY_BY_NAME.set(a, name)

/**
 * Lazy languages an eager one embeds (hljs `subLanguage`): requested when the
 * code looks like it uses them, so e.g. an html fence's <style> still gets colours.
 */
const EMBEDS: [host: string, test: RegExp, lazy: string][] = [
  ['xml', /<style/i, 'css'],
  ['javascript', /\bcss`/, 'css'],
  ['typescript', /\bcss`/, 'css'],
  ['javascript', /\b(gql|graphql)`/, 'graphql'],
  ['typescript', /\b(gql|graphql)`/, 'graphql'],
]

/** Bumped once a batch of lazy languages has registered: renders that read it re-run. */
export const highlightRevision = shallowRef(0)

const loading = new Map<string, Promise<void>>()
let batch: Promise<void>[] = []

function requestLanguage(name: string): Promise<void> {
  const existing = loading.get(name)
  if (existing) return existing
  const p = LAZY[name]!.load().then(
    (m) => { hljs.registerLanguage(name, m.default) },
    () => { loading.delete(name) }, // chunk failed: the fence stays plain text; the next render retries
  )
  loading.set(name, p)
  if (!batch.length) {
    // One re-render for every language requested by the same render pass.
    queueMicrotask(() => {
      const settled = batch
      batch = []
      void Promise.all(settled).then(() => { highlightRevision.value++ })
    })
  }
  batch.push(p)
  return p
}

/** A lazy language key for this fence name that is not registered yet (else null). */
function missingLazy(lang: string): string | null {
  const name = LAZY_BY_NAME.get(lang.toLowerCase())
  return name && !hljs.getLanguage(name) ? name : null
}

/** Highlighted HTML for `code`, or '' (markdown-it then escapes it) — the markdown-it `highlight` option. */
export function highlightCode(code: string, lang: string): string {
  if (!lang) return ''
  const def = hljs.getLanguage(lang)
  if (!def) {
    const name = missingLazy(lang)
    if (name) void requestLanguage(name)
    return ''
  }
  for (const [host, test, lazy] of EMBEDS) {
    if (def === hljs.getLanguage(host) && !hljs.getLanguage(lazy) && test.test(code)) void requestLanguage(lazy)
  }
  try {
    return hljs.highlight(code, { language: lang }).value
  } catch {
    return '' // fall through to default escaping
  }
}

/** Fence info strings' first words in a markdown source (```lang / ~~~lang). */
function fenceLanguages(source: string): Set<string> {
  const out = new Set<string>()
  for (const m of source.matchAll(/^[ \t>]*(?:`{3,}|~{3,})[ \t]*([^\s`{]+)/gm)) out.add(m[1]!.toLowerCase())
  return out
}

/**
 * Loads the lazy languages `source`'s fences name (resolves when they are
 * registered or have failed). Call before rendering when a complete first
 * render matters more than a few ms: a doc's first paint, an export.
 */
export function loadFenceLanguages(source: string): Promise<void> {
  const wanted: Promise<void>[] = []
  for (const lang of fenceLanguages(source)) {
    const name = missingLazy(lang)
    if (name) wanted.push(requestLanguage(name))
  }
  return wanted.length ? Promise.all(wanted).then(() => undefined) : Promise.resolve()
}

export interface FenceLanguage {
  name: string
  /** highlight.js's own aliases (`py`, `js`): typed, they find `name`. */
  aliases: readonly string[]
}
/** Fence languages the preview highlights: registered names + the aliases above (the #12 language step). */
export const FENCE_LANGUAGES: readonly FenceLanguage[] = [
  ...Object.keys(EAGER).map((name) => ({ name, aliases: hljs.getLanguage(name)?.aliases ?? [] })),
  ...Object.entries(LAZY).map(([name, { aliases }]) => ({ name, aliases })),
  ...Object.values(EXTRA_ALIASES).flat().map((name) => ({ name, aliases: [] })),
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

/** For tests: the lazy language keys and their declared aliases. */
export const LAZY_LANGUAGES: Readonly<Record<string, Pick<LazyLanguage, 'aliases'>>> = LAZY

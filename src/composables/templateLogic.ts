// ── Templates (#27): pure FE helpers, unit-tested in tests/items/27-templates.test.ts ──
// Variable substitution itself runs on the server only (spec decision); the FE
// only prepares content for "Save as template" and orders/filters the picker.
import type { ThemeMode } from '@/types'

export interface TemplateCollectionRef { id: string; name: string }

/** A `GET /templates` item (no content). */
export interface TemplateSummary {
  id: string
  name: string
  description: string
  contentType: 'markdown' | 'html'
  mode: 'publish' | 'review'
  collectionId: string | null
  collection: TemplateCollectionRef | null
  builtin: boolean
  variables: string[]
  created_by?: string | null
}

/** Rule 10: the picker shows its filter box above this many templates. */
export const FILTER_THRESHOLD = 8
export const showTemplateFilter = (count: number) => count > FILTER_THRESHOLD

/** Rule 1: template content is at most 1 MB. */
export const MAX_TEMPLATE_BYTES = 1024 * 1024
export const TOO_LARGE_MESSAGE = 'This document is larger than 1 MB, the limit for a template.'
export const contentBytes = (s: string) => new TextEncoder().encode(s).length
export const tooLarge = (s: string) => contentBytes(s) > MAX_TEMPLATE_BYTES

const TITLE_VAR = '{{title}}'

/**
 * HTML regions whose `<title>`/`<h1>` are not the document's: comments, `<script>`, `<style>`,
 * `<template>`, `<textarea>` and `<svg>` (an SVG `<title>` is a tooltip). Blanked to spaces of the
 * same length, so match offsets still index the original.
 */
const HTML_OPAQUE = /<!--[\s\S]*?(?:-->|$)|<(script|style|template|textarea|svg)\b[\s\S]*?(?:<\/\1\s*>|$)/gi
const blankOpaque = (html: string) => html.replace(HTML_OPAQUE, (m) => ' '.repeat(m.length))

/** Replace the inner text of the first `<tag>…</tag>` found in `masked` (same offsets as `html`). */
function replaceElementText(html: string, masked: string, tag: 'title' | 'h1'): string | null {
  const m = new RegExp(`(<${tag}\\b[^>]*>)[\\s\\S]*?(<\\/${tag}\\s*>)`, 'i').exec(masked)
  if (!m) return null
  const start = m.index + m[1].length
  const end = m.index + m[0].length - m[2].length
  return html.slice(0, start) + TITLE_VAR + html.slice(end)
}

/**
 * Rule 15 "Use {{title}} in place of this doc's title": markdown → the text of
 * the first `# ` heading (outside fenced code); html → the `<title>` text and
 * the first `<h1>` text (not inside comments, scripts, styles or SVG).
 * Nothing to replace → content unchanged, replaced false.
 */
export function applyTitleVar(content: string, contentType: 'markdown' | 'html'): { content: string; replaced: boolean } {
  if (contentType === 'html') {
    let out = content
    let replaced = false
    for (const tag of ['title', 'h1'] as const) {
      const next = replaceElementText(out, blankOpaque(out), tag)
      if (next !== null) { out = next; replaced = true }
    }
    return { content: out, replaced }
  }
  const lines = content.split('\n')
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // An opening fence may carry an info string (```js); a closing fence may not (CommonMark).
    const f = /^ {0,3}(`{3,}|~{3,})(.*?)\r?$/.exec(line)
    if (f) {
      if (!fence) { fence = f[1]; continue }
      if (f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) { fence = null; continue }
    }
    if (fence) continue
    const h = /^( {0,3}#[ \t]+)[^\r]*(\r?)$/.exec(line)
    if (h) {
      lines[i] = h[1] + TITLE_VAR + h[2]
      return { content: lines.join('\n'), replaced: true }
    }
  }
  return { content, replaced: false }
}

/** Rule 10: builtins first (in server/manifest order), then user templates by name, case-insensitive. */
export function orderTemplates<T extends TemplateSummary>(list: readonly T[]): T[] {
  const builtins = list.filter((t) => t.builtin)
  const users = list.filter((t) => !t.builtin)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id))
  return [...builtins, ...users]
}

/** The picker filter: name or description contains the text (case-insensitive). */
export function filterTemplates<T extends TemplateSummary>(list: readonly T[], q: string): T[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return [...list]
  return list.filter((t) => t.name.toLowerCase().includes(needle) || (t.description || '').toLowerCase().includes(needle))
}

/** The picker's collection default: the template's collection when it still exists, else '' (Unfiled). */
export function collectionChoice(t: Pick<TemplateSummary, 'collectionId'>, collections: readonly { id: string }[]): string {
  return t.collectionId && collections.some((c) => c.id === t.collectionId) ? t.collectionId : ''
}

/** A failed request's message: the server's `error`, else a status fallback (0 = unreachable). */
export function apiErrorText(status: number, body: unknown): string {
  const msg = body && typeof body === 'object' ? (body as { error?: unknown }).error : null
  if (typeof msg === 'string' && msg) return msg
  return status ? `The server returned ${status}` : 'Could not reach the server. Check your connection and try again.'
}

/** The current theme, from the classes applyTheme() puts on <html>. */
export function themeFromRoot(el: { classList: { contains(c: string): boolean } }): ThemeMode {
  const dark = el.classList.contains('dark')
  const style = el.classList.contains('github-theme') ? 'github-' : el.classList.contains('locus-theme') ? 'locus-' : ''
  return (style ? `${style}${dark ? 'dark' : 'light'}` : dark ? 'dark' : 'light') as ThemeMode
}

/**
 * The slash menu's catalogue, filtering and inserted text (spec #12 rules 5,
 * 12–17). Pure data + functions, no CodeMirror: `slashMenu.ts` places the text.
 *
 * Inserted text marks where the caret goes after a commit: `‸` is the caret,
 * `«x»` selects x (rule 15).
 */

/** inline: replaces `/query` in place; prefix: starts a line; block: its own paragraph (rules 12–14). */
export type SlashKind = 'inline' | 'prefix' | 'block'

export interface SlashItem {
  id: string
  label: string
  aliases: string[]
  /** One-line syntax hint shown under the label. */
  hint: string
  kind: SlashKind
  /** Inserted text with markers; `code` and `date` are built at commit time. */
  text: string
}

const TABLE_TEXT = [
  '| «Column 1» | Column 2 | Column 3 |',
  '| -------- | -------- | -------- |',
  '|          |          |          |',
  '|          |          |          |',
].join('\n')

const MERMAID_TEXT = [
  '```mermaid',
  'flowchart TD',
  '    A[«Start»] --> B{Decision}',
  '    B -->|Yes| C[Do this]',
  '    B -->|No| D[Do that]',
  '```',
].join('\n')

const heading = (n: 1 | 2 | 3): SlashItem => ({
  id: `h${n}`, label: `Heading ${n}`, aliases: ['heading', 'title', 'h'], hint: `${'#'.repeat(n)} Heading`,
  kind: 'prefix', text: `${'#'.repeat(n)} ‸`,
})

const callout = (type: string, aliases: string[]): SlashItem => ({
  id: `callout-${type.toLowerCase()}`,
  label: `Callout: ${type.charAt(0) + type.slice(1).toLowerCase()}`,
  aliases: ['callout', 'alert', ...aliases],
  hint: `> [!${type}]`,
  kind: 'block',
  text: `> [!${type}]\n> ‸`,
})

const rag = (colour: string, label: string, aliases: string[]): SlashItem => ({
  id: `rag-${colour}`,
  label: `Status: ${colour.charAt(0).toUpperCase() + colour.slice(1)}`,
  aliases: ['rag', 'status', ...aliases],
  hint: `:rag-${colour}[${label}]`,
  kind: 'inline',
  // #16 rule 10 syntax, lower-case colour, non-empty default label (rule 17).
  text: `:rag-${colour}[«${label}»]`,
})

export const SLASH_ITEMS: readonly SlashItem[] = [
  heading(1), heading(2), heading(3),
  { id: 'bullet', label: 'Bulleted list', aliases: ['ul', 'list', 'bullet'], hint: '- item', kind: 'prefix', text: '- ‸' },
  { id: 'numbered', label: 'Numbered list', aliases: ['ol', 'number', 'ordered'], hint: '1. item', kind: 'prefix', text: '1. ‸' },
  { id: 'task', label: 'Task list', aliases: ['todo', 'checkbox', 'check'], hint: '- [ ] task', kind: 'prefix', text: '- [ ] ‸' },
  { id: 'table', label: 'Table', aliases: ['grid'], hint: '| a | b | c | — 3 × 2', kind: 'block', text: TABLE_TEXT },
  { id: 'code', label: 'Code block', aliases: ['fence', 'pre', 'snippet'], hint: '```language', kind: 'block', text: '' },
  { id: 'mermaid', label: 'Mermaid diagram', aliases: ['diagram', 'flowchart', 'chart', 'graph'], hint: '```mermaid flowchart', kind: 'block', text: MERMAID_TEXT },
  callout('NOTE', ['note']),
  callout('TIP', ['tip']),
  callout('IMPORTANT', ['important']),
  callout('WARNING', ['warning', 'warn']),
  callout('CAUTION', ['caution', 'danger']),
  rag('green', 'On track', ['green']),
  rag('amber', 'At risk', ['amber', 'yellow']),
  rag('red', 'Off track', ['red']),
  { id: 'divider', label: 'Divider', aliases: ['hr', 'rule', 'line', 'separator'], hint: '---', kind: 'block', text: '---\n‸' },
  { id: 'toc', label: 'Table of contents', aliases: ['contents', 'index'], hint: '[[toc]]', kind: 'block', text: '[[toc]]\n‸' },
  { id: 'date', label: "Today's date", aliases: ['today', 'now'], hint: 'YYYY-MM-DD', kind: 'inline', text: '' },
]

/** The longest query the menu stays open for (rule 9). */
export const MAX_QUERY = 24

const words = (label: string) => label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/**
 * Rule 5: case-insensitive prefix match on label, id, alias, or any label word.
 * Ranked label-prefix → alias/id-prefix → word-prefix; ties keep catalogue order.
 */
export function filterSlashItems(query: string, items: readonly SlashItem[] = SLASH_ITEMS): SlashItem[] {
  const q = query.toLowerCase()
  if (!q) return [...items]
  const ranked: { item: SlashItem; rank: number; index: number }[] = []
  items.forEach((item, index) => {
    let rank = -1
    if (item.label.toLowerCase().startsWith(q)) rank = 0
    else if (item.id.startsWith(q) || item.aliases.some((a) => a.startsWith(q))) rank = 1
    else if (words(item.label).some((w) => w.startsWith(q))) rank = 2
    if (rank >= 0) ranked.push({ item, rank, index })
  })
  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map((r) => r.item)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The local calendar date as YYYY-MM-DD. */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The text an item inserts, with caret/selection markers. */
export function slashItemText(item: SlashItem, opts: { lang?: string; date?: Date } = {}): string {
  if (item.id === 'code') return '```' + (opts.lang ?? '') + '\n‸\n```'
  if (item.id === 'date') return localDate(opts.date) + '‸'
  return item.text
}

// ── code language step (rule 16) ────────────────────────────────────────────

export interface LangOption {
  /** Fence info string; '' = Plain text (no language). */
  lang: string
  label: string
}

const LANG_RE = /^[A-Za-z0-9_+#.-]{1,30}$/

/** A typed language the fence may carry (rule 16: `[A-Za-z0-9_+#.-]`, ≤ 30). */
export function validLanguage(text: string): boolean {
  return LANG_RE.test(text)
}

/** A fence language: its name and the aliases that also find it (highlight.js's own, e.g. `py`). */
export interface LangEntry {
  name: string
  aliases: readonly string[]
}

/**
 * "Plain text" first, then the languages whose name or alias starts with the
 * query (case-insensitive): an exact name/alias match first (`js` → javascript,
 * `py` → python), the rest alphabetically. The option is always the name.
 */
export function filterLanguages(query: string, langs: readonly LangEntry[]): LangOption[] {
  const q = query.trim().toLowerCase()
  const out: LangOption[] = []
  if (!q || 'plain text'.startsWith(q)) out.push({ lang: '', label: 'Plain text' })
  const hits: { name: string; exact: boolean }[] = []
  const seen = new Set<string>()
  for (const l of langs) {
    if (seen.has(l.name)) continue
    const keys = [l.name, ...l.aliases].map((k) => k.toLowerCase())
    if (!keys.some((k) => k.startsWith(q))) continue
    seen.add(l.name)
    hits.push({ name: l.name, exact: !!q && keys.includes(q) })
  }
  hits.sort((a, b) => Number(b.exact) - Number(a.exact) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const h of hits) out.push({ lang: h.name, label: h.name })
  return out
}

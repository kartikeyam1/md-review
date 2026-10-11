// #12 Slash menu — unit acceptance tests (docs/build/specs/12-slash-menu.md rules 1–2, 5, 12–18;
// AC-12.4, 12.5, 12.9, 12.11–12.15 text halves). The browser halves live in
// tests/e2e/items/12-slash-menu.test.mjs.
import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { ensureSyntaxTree } from '@codemirror/language'
import {
  SLASH_ITEMS, filterSlashItems, slashItemText, filterLanguages, localDate, validLanguage,
} from '@/editor/slashCatalogue'
import { canOpenSlashMenu, slashInsertion } from '@/editor/slashMenu'
import { useMarkdown, FENCE_LANGUAGES } from '@/composables/useMarkdown'

const TABLE = '| Column 1 | Column 2 | Column 3 |\n| -------- | -------- | -------- |\n|          |          |          |\n|          |          |          |'
const MERMAID = '```mermaid\nflowchart TD\n    A[Start] --> B{Decision}\n    B -->|Yes| C[Do this]\n    B -->|No| D[Do that]\n```'

const ids = (q: string) => filterSlashItems(q).map((i) => i.id)

/** A markdown state; `|` marks the position, removed from the text. */
function md(src: string, lang: 'md' | 'html' = 'md') {
  const pos = src.indexOf('|')
  const doc = pos >= 0 ? src.slice(0, pos) + src.slice(pos + 1) : src
  const state = EditorState.create({ doc, extensions: lang === 'md' ? markdown() : html() })
  ensureSyntaxTree(state, state.doc.length, 5000)
  return { state, pos }
}

/** Apply item `id` to `src`, where `/query` is typed and `|` marks the caret right after it. */
function commit(src: string, id: string, opts: { lang?: string; date?: Date } = {}) {
  const { state, pos: head } = md(src)
  const from = state.doc.sliceString(0, head).lastIndexOf('/')
  const item = SLASH_ITEMS.find((i) => i.id === id)!
  const spec = slashInsertion(state, from, head, item, opts)
  const next = state.update(spec).state
  const sel = next.selection.main
  return { doc: next.doc.toString(), from: sel.from, to: sel.to, selected: next.sliceDoc(sel.from, sel.to) }
}

describe('#12 catalogue and filtering (rule 5)', () => {
  it('the catalogue is in the spec order', () => {
    expect(SLASH_ITEMS.map((i) => i.id)).toEqual([
      'h1', 'h2', 'h3', 'bullet', 'numbered', 'task', 'table', 'code', 'mermaid',
      'callout-note', 'callout-tip', 'callout-important', 'callout-warning', 'callout-caution',
      'rag-green', 'rag-amber', 'rag-red', 'divider', 'toc', 'date',
    ])
    expect(SLASH_ITEMS.find((i) => i.id === 'callout-warning')!.label).toBe('Callout: Warning')
    for (const i of SLASH_ITEMS) expect(i.hint.length).toBeGreaterThan(0)
  })

  it('empty query → full catalogue in order', () => {
    expect(ids('')).toEqual(SLASH_ITEMS.map((i) => i.id))
  })

  it('AC-12.4 `tab` → table first; `warn` → callout-warning first', () => {
    expect(ids('tab')[0]).toBe('table')
    expect(ids('tab')).toContain('toc') // "Table of contents" — label prefix, later in catalogue
    expect(ids('warn')[0]).toBe('callout-warning')
  })

  it('case-insensitive; label-prefix ranks before alias/id-prefix before word-prefix', () => {
    expect(ids('TABLE')[0]).toBe('table')
    // "h": Heading 1–3 by label, then Divider by its "hr" alias
    expect(ids('h')).toEqual(['h1', 'h2', 'h3', 'divider'])
    expect(ids('h2')).toEqual(['h2'])
    expect(ids('rag')).toEqual(['rag-green', 'rag-amber', 'rag-red'])
    expect(ids('callout')).toEqual(['callout-note', 'callout-tip', 'callout-important', 'callout-warning', 'callout-caution'])
    // "date": id prefix (rank 2) — "Today's date" also matches by word
    expect(ids('date')).toEqual(['date'])
    // "note": alias of callout-note; word "Note" in its label too — one entry
    expect(ids('note')[0]).toBe('callout-note')
    // "contents" is an alias (and a word) of Table of contents only
    expect(ids('cont')).toEqual(['toc'])
    // "list" label words (Bulleted list, Numbered list, Task list) rank after the "list" alias of bullet
    expect(ids('list')).toEqual(['bullet', 'numbered', 'task'])
    expect(ids('yellow')).toEqual(['rag-amber'])
  })

  it('no match → empty', () => {
    expect(ids('xyz')).toEqual([])
  })
})

describe('#12 inserted text (catalogue column)', () => {
  it('table, mermaid, callouts, rag, divider, toc, code, date', () => {
    const t = (id: string, o = {}) => slashItemText(SLASH_ITEMS.find((i) => i.id === id)!, o)
    expect(t('table')).toBe(TABLE.replace('Column 1', '«Column 1»'))
    expect(t('mermaid')).toBe(MERMAID.replace('[Start]', '[«Start»]'))
    expect(t('callout-note')).toBe('> [!NOTE]\n> ‸')
    expect(t('callout-caution')).toBe('> [!CAUTION]\n> ‸')
    expect(t('rag-green')).toBe(':rag-green[«On track»]')
    expect(t('rag-amber')).toBe(':rag-amber[«At risk»]')
    expect(t('rag-red')).toBe(':rag-red[«Off track»]')
    expect(t('divider')).toBe('---\n‸')
    expect(t('toc')).toBe('[[toc]]\n‸')
    expect(t('h3')).toBe('### ‸')
    expect(t('task')).toBe('- [ ] ‸')
    expect(t('code', { lang: 'python' })).toBe('```python\n‸\n```')
    expect(t('code', { lang: '' })).toBe('```\n‸\n```')
    expect(t('date', { date: new Date(2026, 0, 5, 23, 30) })).toBe('2026-01-05‸')
    expect(localDate(new Date(2026, 11, 31, 0, 1))).toBe('2026-12-31')
  })

  it('language step: Plain text first, then the registered languages + aliases alphabetically, prefix-filtered', () => {
    const all = filterLanguages('', FENCE_LANGUAGES)
    expect(all[0]).toEqual({ lang: '', label: 'Plain text' })
    const names = all.slice(1).map((o) => o.lang)
    expect(names).toEqual([...names].sort())
    for (const l of ['python', 'typescript', 'html', 'toml', 'sh']) expect(names).toContain(l)
    expect(filterLanguages('py', FENCE_LANGUAGES)[0]!.lang).toBe('python')
    expect(filterLanguages('PY', FENCE_LANGUAGES)[0]!.lang).toBe('python')
    // highlight.js aliases find their language, an exact alias match first; the fence gets the name
    expect(filterLanguages('js', FENCE_LANGUAGES)[0]!.lang).toBe('javascript')
    expect(filterLanguages('js', FENCE_LANGUAGES).map((o) => o.lang)).toContain('json')
    expect(filterLanguages('ts', FENCE_LANGUAGES)[0]!.lang).toBe('typescript')
    const pl = filterLanguages('pl', FENCE_LANGUAGES).map((o) => o.lang)
    expect(pl[0]).toBe('')
    expect(pl).toEqual(expect.arrayContaining(['plain', 'plaintext']))
    expect(filterLanguages('zzz', FENCE_LANGUAGES)).toEqual([])
    expect(filterLanguages('x', [{ name: 'b', aliases: ['x1'] }, { name: 'a', aliases: ['xx'] }, { name: 'x', aliases: [] }]).map((o) => o.lang))
      .toEqual(['x', 'a', 'b'])
    expect(validLanguage('c++')).toBe(true)
    expect(validLanguage('objective-c.v2_#')).toBe(true)
    expect(validLanguage('bad lang')).toBe(false)
    expect(validLanguage('x'.repeat(31))).toBe(false)
    expect(validLanguage('')).toBe(false)
  })
})

describe('#12 trigger contexts (rules 1–2, AC-12.2, AC-12.3)', () => {
  const can = (src: string, lang: 'md' | 'html' = 'md') => {
    const { state, pos } = md(src, lang)
    return canOpenSlashMenu(state, pos)
  }
  it('opens at line start, after a space, after a tab', () => {
    expect(can('|')).toBe(true)
    expect(can('foo |')).toBe(true)
    expect(can('foo\t|')).toBe(true)
    expect(can('# Title\n\n|')).toBe(true)
    expect(can('- item |')).toBe(true)
  })
  it('does not open after a non-space (URLs, a/b, //)', () => {
    expect(can('see https:|')).toBe(false)
    expect(can('a|')).toBe(false)
    expect(can('/|')).toBe(false)
  })
  it('not in fenced code (incl. fence/info lines, unclosed), indented code, inline code, front matter, HTML, comments, link destinations', () => {
    expect(can('```\ncode |\n```')).toBe(false)
    expect(can('```js |\nx\n```')).toBe(false)
    expect(can('```\n|')).toBe(false)
    expect(can('~~~\nx\n|')).toBe(false)
    expect(can('Para\n\n    code |')).toBe(false)
    expect(can('Para\n\n    |')).toBe(false) // becomes an indented code block once `/` is typed
    expect(can('`a |')).toBe(false)
    expect(can('`a` and `b |')).toBe(false)
    expect(can('---\ntitle: x |\n---\n# Body')).toBe(false)
    expect(can('<div>\n  |\n</div>')).toBe(false)
    expect(can('<!-- note |')).toBe(false)
    expect(can('<!--\nnote\n|\n-->')).toBe(false)
    expect(can('[link](http: |')).toBe(false)
    expect(can('x', 'html')).toBe(false)
    expect(can('<p> |</p>', 'html')).toBe(false)
  })
  it('still opens after closed inline code, a closed link, a closed fence, or an hr at doc start', () => {
    expect(can('`a` |')).toBe(true)
    expect(can('[l](u) |')).toBe(true)
    expect(can('```\nx\n```\n|')).toBe(true)
    expect(can('- a\n    |')).toBe(true) // list continuation, not code
    expect(can('---\n\nno closing |')).toBe(true)
  })
})

describe('#12 commit: replacement, line handling, caret (rules 12–15)', () => {
  it('AC-12.5 /table on an empty line → exactly the table, `Column 1` selected', () => {
    const r = commit('/table|', 'table')
    expect(r.doc).toBe(TABLE)
    expect(r.selected).toBe('Column 1')
  })
  it('a block after a non-blank line gets a blank line before; text after it gets one after', () => {
    expect(commit('# T\n/table|', 'table').doc).toBe('# T\n\n' + TABLE)
    expect(commit('# T\n\n/table|\nnext', 'table').doc).toBe('# T\n\n' + TABLE + '\n\nnext')
    expect(commit('/table|\n\nnext', 'table').doc).toBe(TABLE + '\n\nnext')
  })
  it('AC-12.13 text before a line-prefix item → stays on its line; the prefix starts the next line', () => {
    const r = commit('Intro text /h2|', 'h2')
    expect(r.doc).toBe('Intro text\n## ')
    expect(r.from).toBe(r.doc.length)
    expect(r.to).toBe(r.from)
    // text after the query follows the prefix on the new line
    const r2 = commit('Intro text /h2|tail', 'h2')
    expect(r2.doc).toBe('Intro text\n## tail')
    expect(r2.from).toBe('Intro text\n## '.length)
  })
  it('AC-12.13 text before a divider → a blank line separates it from `---`', () => {
    const r = commit('Intro text /divider|', 'divider')
    expect(r.doc).toBe('Intro text\n\n---\n')
    expect(r.from).toBe(r.doc.length)
  })
  it('line-prefix items keep the indent when only whitespace precedes', () => {
    expect(commit('  /bullet|', 'bullet').doc).toBe('  - ')
    expect(commit('- a\n  - b\n  /task|', 'task').doc).toBe('- a\n  - b\n  - [ ] ')
  })
  it('a block on an indented line prefixes every line after the first with the indent', () => {
    const r = commit('- item\n    /table|', 'table')
    const lines = r.doc.split('\n')
    expect(lines.slice(0, 2)).toEqual(['- item', ''])
    expect(lines.slice(2)).toEqual(TABLE.split('\n').map((l) => '    ' + l))
    expect(r.selected).toBe('Column 1')
  })
  it('AC-12.11 callouts: first line `> [!TYPE]`, caret on the following `> ` line', () => {
    for (const [id, type] of [['callout-note', 'NOTE'], ['callout-tip', 'TIP'], ['callout-important', 'IMPORTANT'], ['callout-warning', 'WARNING'], ['callout-caution', 'CAUTION']]) {
      const r = commit(`/x|`, id!)
      expect(r.doc).toBe(`> [!${type}]\n> `)
      expect(r.from).toBe(r.doc.length)
    }
    // a callout followed by text: blank line after (no lazy continuation into it)
    expect(commit('/x|\nnext', 'callout-note').doc).toBe('> [!NOTE]\n> \n\nnext')
  })
  it('AC-12.12 inline RAG replaces /query in place with the label selected', () => {
    const r = commit('Status: /rag|', 'rag-green')
    expect(r.doc).toBe('Status: :rag-green[On track]')
    expect(r.selected).toBe('On track')
    expect(commit('a /r| b', 'rag-red').doc).toBe('a :rag-red[Off track] b')
  })
  it('AC-12.14 date replaces /date with the local date', () => {
    const r = commit('Due /date|', 'date', { date: new Date(2026, 9, 10, 23, 59) })
    expect(r.doc).toBe('Due 2026-10-10')
    expect(r.from).toBe(r.doc.length)
  })
  it('AC-12.9 code with a language: caret on the empty line', () => {
    const r = commit('/code|', 'code', { lang: 'python' })
    expect(r.doc).toBe('```python\n\n```')
    expect(r.from).toBe('```python\n'.length)
  })
  it('AC-12.10 mermaid: `Start` selected', () => {
    const r = commit('/mermaid|', 'mermaid')
    expect(r.doc).toBe(MERMAID)
    expect(r.selected).toBe('Start')
  })
  it('text after the query stays on the caret line of a block that ends at the caret, before the blank line', () => {
    const r = commit('/x|foo\nbar', 'callout-note')
    expect(r.doc).toBe('> [!NOTE]\n> foo\n\nbar')
    expect(r.from).toBe('> [!NOTE]\n> '.length)
    expect(commit('/divider|foo\nbar', 'divider').doc).toBe('---\nfoo\n\nbar')
    expect(commit('/toc|foo\nbar', 'toc').doc).toBe('[[toc]]\nfoo\n\nbar')
  })
  it('leading whitespace of the text after the query is dropped on its new line', () => {
    expect(commit('abc /h2| tail', 'h2').doc).toBe('abc\n## tail')
    expect(commit('  /h2|  tail', 'h2').doc).toBe('  ## tail')
  })
  it('after only list/quote markers the item becomes that item\'s content (no empty bullet left behind)', () => {
    expect(commit('- /h2|', 'h2').doc).toBe('- ## ')
    expect(commit('1. /bullet|', 'bullet').doc).toBe('1. - ')
    const t = commit('- a\n- /table|', 'table')
    expect(t.doc).toBe('- a\n- ' + TABLE.split('\n').join('\n  '))
    expect(t.selected).toBe('Column 1')
    expect(commit('> /x|', 'callout-note').doc).toBe('> > [!NOTE]\n> > ')
    expect(commit('- [ ] /x|', 'divider').doc).toBe('- [ ] ---\n      ')
    expect(commit('- /table|\n- next', 'table').doc).toBe('- ' + TABLE.split('\n').join('\n  ') + '\n\n- next')
    expect(commit('> /code| tail', 'code', { lang: '' }).doc).toBe('> ```\n> \n> ```\n>\n> tail')
  })
  it('toc after text; a block with text after the query puts that text after the block', () => {
    expect(commit('See /toc|', 'toc').doc).toBe('See\n\n[[toc]]\n')
    expect(commit('/code| tail', 'code', { lang: '' }).doc).toBe('```\n\n```\n\ntail')
  })
})

describe('#12 [[toc]] rendering (rule 18, AC-12.15)', () => {
  const render = (src: string) => {
    const div = document.createElement('div')
    div.innerHTML = useMarkdown().renderHtml(src)
    return div
  }
  it('AC-12.15 H2/H3 in order, B nested under A; hrefs are the heading ids', () => {
    const root = render('# Title\n\n[[toc]]\n\n## A\n\n### B\n\n## C\n\n#### D\n')
    const navs = root.querySelectorAll('[data-testid="inline-toc"]')
    expect(navs).toHaveLength(1)
    const nav = navs[0]!
    expect(nav.tagName).toBe('NAV')
    expect(nav.classList.contains('inline-toc')).toBe(true)
    expect(nav.getAttribute('aria-label')).toBe('Table of contents')
    const links = [...nav.querySelectorAll<HTMLAnchorElement>('a[data-testid="inline-toc-link"]')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#a', '#b', '#c'])
    expect(links.map((a) => a.textContent)).toEqual(['A', 'B', 'C'])
    // B is inside A's <li>
    expect(links[1]!.closest('li')!.parentElement!.closest('li')!.querySelector('a')!.textContent).toBe('A')
    for (const a of links) expect(root.querySelector(`[id="${a.getAttribute('href')!.slice(1)}"]`)).not.toBeNull()
    expect(root.textContent).not.toContain('[[toc]]')
  })
  it('case-insensitive, surrounding whitespace; link text is plain text; duplicate ids follow #3', () => {
    const root = render('  [[TOC]]  \n\n## Hello *world* `x`\n\n## Hello world x\n')
    const links = [...root.querySelectorAll<HTMLAnchorElement>('[data-testid="inline-toc-link"]')]
    expect(links.map((a) => a.textContent)).toEqual(['Hello world x', 'Hello world x'])
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#hello-world-x', '#hello-world-x-1'])
  })
  it('no H2/H3 → "No headings yet"', () => {
    const root = render('# Only title\n\n[[toc]]\n')
    const nav = root.querySelector('[data-testid="inline-toc"]')!
    expect(nav.textContent).toContain('No headings yet')
    expect(nav.querySelectorAll('a')).toHaveLength(0)
  })
  it('in code or mid-paragraph renders literally', () => {
    const root = render('`[[toc]]`\n\nSee [[toc]] here\n\n```\n[[toc]]\n```\n')
    expect(root.querySelector('[data-testid="inline-toc"]')).toBeNull()
    expect(root.querySelector('code')!.textContent).toBe('[[toc]]')
    expect(root.textContent).toContain('See [[toc]] here')
  })
  it('the nav keeps the paragraph line range; heading TOC data is unaffected', () => {
    const root = render('[[toc]]\n\n## A\n')
    const nav = root.querySelector('[data-testid="inline-toc"]')!
    expect(nav.getAttribute('data-line-start')).toBe('0')
    expect(nav.getAttribute('data-line-end')).toBe('1')
    expect(useMarkdown().renderWithHeadings('[[toc]]\n\n## A\n').headings.map((h) => h.id)).toEqual(['a'])
  })
})

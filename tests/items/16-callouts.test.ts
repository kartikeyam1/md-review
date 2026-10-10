// #16 Callouts (GitHub alerts) + RAG badges — unit acceptance tests
// (docs/build/specs/16-callouts.md rules 1–15; AC-16.1–16.4, 16.9–16.11, 16.13, 16.14 markup;
// 00-cross-cutting.md §2.5, §4.4, §5). Renders through the preview's own markdown-it.
import { describe, it, expect } from 'vitest'
import { useMarkdown } from '@/composables/useMarkdown'
import { extractHeadings, buildToc } from '@/markdown/headingIds'

function render(src: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = useMarkdown().renderHtml(src)
  return div
}
const callouts = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-testid="callout"]')]
const badges = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-testid="rag-badge"]')]
/** Visible text: the sr-only prefix removed. */
const visible = (el: Element) => {
  const c = el.cloneNode(true) as HTMLElement
  c.querySelectorAll('.sr-only').forEach((s) => s.remove())
  return c.textContent!.replace(/\s+/g, ' ').trim()
}

describe('#16 callouts', () => {
  it('AC-16.1 > [!NOTE] renders one note callout with title "Note" and the body', () => {
    const root = render('> [!NOTE]\n> Body text\n')
    const cs = callouts(root)
    expect(cs).toHaveLength(1)
    const c = cs[0]!
    expect(c.dataset.callout).toBe('note')
    expect(c.classList.contains('markdown-alert')).toBe(true)
    expect(c.classList.contains('markdown-alert-note')).toBe(true)
    expect(c.classList.contains('callout')).toBe(true)
    expect(c.tagName).toBe('DIV')
    const title = c.querySelector('[data-testid="callout-title"]')!
    expect(title.tagName).toBe('P')
    expect(title.classList.contains('markdown-alert-title')).toBe(true)
    expect(title.textContent!.trim()).toBe('Note')
    const ps = [...c.querySelectorAll(':scope > p:not([data-testid="callout-title"])')]
    expect(ps.map((p) => p.textContent!.trim())).toEqual(['Body text'])
    expect(root.textContent).not.toContain('[!NOTE]')
    expect(root.querySelector('blockquote')).toBeNull()
  })

  it('AC-16.2 type is case-insensitive; default titles', () => {
    const src = ['> [!tip]\n> a', '> [!Important]\n> b', '> [!WARNING]\n> c', '> [!caution]\n> d'].join('\n\n')
    const cs = callouts(render(src))
    expect(cs.map((c) => c.dataset.callout)).toEqual(['tip', 'important', 'warning', 'caution'])
    expect(cs.map((c) => c.querySelector('[data-testid="callout-title"]')!.textContent!.trim())).toEqual(['Tip', 'Important', 'Warning', 'Caution'])
  })

  it('AC-16.3 custom title with inline markdown', () => {
    const c = callouts(render('> [!WARNING] Data **loss** risk\n> body\n'))[0]!
    const title = c.querySelector('[data-testid="callout-title"]')!
    expect(title.textContent!.trim()).toBe('Data loss risk')
    expect(title.querySelector('strong')!.textContent).toBe('loss')
    expect(c.dataset.callout).toBe('warning')
  })

  it('AC-16.4 unknown type / marker not on the first line stay plain blockquotes', () => {
    const root = render('> [!DANGER]\n> x\n\n> Note: [!NOTE]\n')
    expect(callouts(root)).toHaveLength(0)
    const qs = [...root.querySelectorAll('blockquote')]
    expect(qs).toHaveLength(2)
    expect(qs[0]!.textContent).toContain('[!DANGER]')
    expect(qs[1]!.textContent).toContain('Note: [!NOTE]')
  })

  it('rule 4: missing "!", marker in a code span, marker on line 2, lazy continuation → not callouts', () => {
    const root = render([
      '> [NOTE]\n> a', '> `[!NOTE]`\n> b', '> first line\n> [!NOTE] second', '> lazy para\n[!NOTE] continued',
    ].join('\n\n'))
    expect(callouts(root)).toHaveLength(0)
    expect(root.textContent).toContain('[NOTE]')
  })

  it('rule 1: optional leading spaces, no space after ">", trailing spaces, CRLF', () => {
    const root = render('>[!NOTE]\n> a\n\n>   [!TIP]   \n> b\n\n> [!WARNING]\r\n> c\r\n')
    expect(callouts(root).map((c) => c.dataset.callout)).toEqual(['note', 'tip', 'warning'])
    expect(callouts(root)[1]!.querySelector('[data-testid="callout-title"]')!.textContent!.trim()).toBe('Tip')
  })

  it('rule 4: nested > > [!TIP] makes the inner quote a callout', () => {
    const root = render('> outer\n>\n> > [!TIP]\n> > inner\n')
    const cs = callouts(root)
    expect(cs).toHaveLength(1)
    expect(cs[0]!.dataset.callout).toBe('tip')
    expect(cs[0]!.closest('blockquote')).toBeTruthy()
  })

  it('rule 5: marker-only callout is a box with just the title', () => {
    const c = callouts(render('> [!IMPORTANT]\n'))[0]!
    expect(c.dataset.callout).toBe('important')
    expect(c.children).toHaveLength(1)
    expect(c.textContent!.trim()).toBe('Important')
  })

  it('rule 3: wrapper carries the blockquote line range; body keeps its own; role=note; svg aria-hidden', () => {
    const root = render('intro\n\n> [!NOTE]\n> line one\n>\n> line two\n\nafter\n')
    const c = callouts(root)[0]!
    expect(c.getAttribute('data-line-start')).toBe('2')
    expect(c.getAttribute('data-line-end')).toBe('6')
    const body = [...c.querySelectorAll<HTMLElement>(':scope > p:not([data-testid="callout-title"])')]
    expect(body.map((p) => p.getAttribute('data-line-start'))).toEqual(['3', '5'])
    expect(c.getAttribute('role')).toBe('note')
    const svg = c.querySelector('[data-testid="callout-title"] svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.classList.contains('octicon')).toBe(true)
    expect(svg.getAttribute('fill')).toBe('currentColor')
    // the title <p> carries no line range of its own (it is not a token)
    expect(c.querySelector('[data-testid="callout-title"]')!.hasAttribute('data-line-start')).toBe(false)
  })

  it('callout body renders lists, code (with the #14 wrapper), tables and RAG badges', () => {
    const root = render('> [!TIP]\n> - one\n> - two\n>\n> ```sh\n> ls\n> ```\n>\n> | a | b |\n> |---|---|\n> | 1 | :rag-green[ok] |\n')
    const c = callouts(root)[0]!
    expect(c.querySelectorAll('li')).toHaveLength(2)
    expect(c.querySelector('[data-testid="code-block"] [data-testid="code-copy-btn"]')).toBeTruthy()
    expect(c.querySelector('table')).toBeTruthy()
    expect(c.querySelector('td [data-testid="rag-badge"]')).toBeTruthy()
  })

  it('callout first in the doc and right after front matter', () => {
    expect(callouts(render('> [!NOTE]\n> first\n'))).toHaveLength(1)
    const root = render('---\ntitle: X\n---\n> [!CAUTION]\n> after fm\n')
    const c = callouts(root)[0]!
    expect(c.dataset.callout).toBe('caution')
    expect(c.getAttribute('data-line-start')).toBe('3')
  })

  it('two callouts separated by a blank line are two boxes', () => {
    expect(callouts(render('> [!NOTE]\n> a\n\n> [!TIP]\n> b\n'))).toHaveLength(2)
  })
})

describe('#16 RAG badges', () => {
  it('AC-16.9 three badges with data-rag and visible labels; empty label = colour name', () => {
    const root = render(':rag-green[On track] :rag-AMBER[At risk] :rag-red[]\n')
    const bs = badges(root)
    expect(bs.map((b) => b.dataset.rag)).toEqual(['green', 'amber', 'red'])
    expect(bs.map(visible)).toEqual(['On track', 'At risk', 'Red'])
    const b = bs[0]!
    expect(b.tagName).toBe('SPAN')
    expect(b.classList.contains('rag')).toBe(true)
    expect(b.classList.contains('rag-green')).toBe(true)
    expect(b.querySelector('.rag-dot')!.getAttribute('aria-hidden')).toBe('true')
    expect(b.querySelector('.sr-only')!.textContent).toBe('Green: ')
    expect(b.textContent).toBe('Green: On track')
  })

  it('AC-16.10 unknown colour, code span, escape and unclosed render literally', () => {
    const root = render(':rag-blue[x] `:rag-green[x]` \\:rag-green[x] :rag-green[unclosed\n')
    expect(badges(root)).toHaveLength(0)
    const text = root.textContent!.trim()
    expect(text).toBe(':rag-blue[x] :rag-green[x] :rag-green[x] :rag-green[unclosed')
    expect(root.querySelector('code')!.textContent).toBe(':rag-green[x]')
  })

  it('rule 12: :rag-[x] and labels over 80 chars stay literal; 80 exactly is a badge', () => {
    const l80 = 'a'.repeat(80)
    const l81 = 'a'.repeat(81)
    const root = render(`:rag-[x]\n\n:rag-red[${l80}]\n\n:rag-red[${l81}]\n`)
    const bs = badges(root)
    expect(bs).toHaveLength(1)
    expect(visible(bs[0]!)).toBe(l80)
    expect(root.textContent).toContain(':rag-[x]')
    expect(root.textContent).toContain(`:rag-red[${l81}]`)
  })

  it('AC-16.11 HTML in the label is escaped (no element created)', () => {
    const root = render(':rag-red[<img src=x onerror=alert(1)>]\n')
    expect(root.querySelector('img')).toBeNull()
    expect(visible(badges(root)[0]!)).toBe('<img src=x onerror=alert(1)>')
  })

  it('rule 10: markdown in the label is not parsed; escaped ] is part of the label', () => {
    const root = render(':rag-amber[**not bold**] :rag-green[a \\] b]\n')
    const bs = badges(root)
    expect(bs.map(visible)).toEqual(['**not bold**', 'a ] b'])
    expect(root.querySelector('strong')).toBeNull()
  })

  it('rule 13: badges in headings, lists, table cells, links; adjacent badges; badge at line start', () => {
    const root = render([
      '## Status :rag-green[On track]', '',
      '- item :rag-red[Blocked]', '',
      '| a |', '|---|', '| :rag-amber[Watch] |', '',
      '[see :rag-green[ok]](https://example.com)', '',
      ':rag-green[a]:rag-red[b]', '',
      ':rag-green[Line start]: definition-like text',
    ].join('\n'))
    expect(root.querySelector('h2 [data-testid="rag-badge"]')).toBeTruthy()
    expect(root.querySelector('li [data-testid="rag-badge"]')).toBeTruthy()
    expect(root.querySelector('td [data-testid="rag-badge"]')).toBeTruthy()
    expect(root.querySelector('a[href="https://example.com"] [data-testid="rag-badge"]')).toBeTruthy()
    expect(badges(root)).toHaveLength(7)
    expect(root.textContent).not.toContain(':rag-')
  })

  it('review fixes: entities in a label stay as typed; full label in title; label in .rag-label', () => {
    const root = render(':rag-green[AT&amp;T]\n')
    const b = badges(root)[0]!
    expect(visible(b)).toBe('AT&amp;T')
    expect(b.getAttribute('title')).toBe('AT&amp;T')
    expect(b.querySelector('.rag-label')!.textContent).toBe('AT&amp;T')
  })

  it('rule 12: syntax inside fenced code is literal', () => {
    const root = render('```\n:rag-green[x]\n```\n')
    expect(badges(root)).toHaveLength(0)
    expect(root.querySelector('pre code')!.textContent).toBe(':rag-green[x]\n')
  })

  it('AC-16.13 / rule 15: heading id and TOC text come from the visible label', () => {
    const src = '# Doc\n\n## Status :rag-green[On track]\n\n## Other :rag-red[]\n'
    const root = render(src)
    expect(root.querySelector('h2')!.id).toBe('status-on-track')
    const hs = extractHeadings(src)
    expect(hs.map((h) => [h.id, h.text])).toEqual([['doc', 'Doc'], ['status-on-track', 'Status On track'], ['other-red', 'Other Red']])
    expect(buildToc(hs).map((e) => e.text)).toEqual(['Status On track', 'Other Red'])
  })
})

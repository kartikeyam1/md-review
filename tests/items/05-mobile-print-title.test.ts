// #5 Mobile layout, print CSS, document.title — frozen unit acceptance tests
// (docs/build/specs/05-mobile-print-title.md AC-05.13, AC-05.17, AC-05.19;
// rules 5, 15, 17, 20; 00-cross-cutting.md §5).
//
// Module contract these tests pin (the spec names the files, not the exports;
// keep these names):
//
//   src/composables/useDocTitle.ts
//     docTitle({ sessionName?, content?, contentType?, filename? }): string
//       00 §5: sessionName > front-matter `title:` (quotes stripped) | HTML
//       <title> > first H1 plain text | HTML first <h1> > filename without
//       .md/.markdown/.txt/.html/.htm > 'Untitled'. Whitespace collapsed,
//       NOT truncated. `contentType` is the app's ContentType
//       ('markdown' | 'html'); absent means markdown.
//     truncateTitle(title: string, max = 80): string
//       longer than `max` characters -> the first `max` characters + '…'.
//     formatDocumentTitle(title: string): string
//       `${truncateTitle(title)} · md-review` — the document.title of an open doc.
//
//   src/composables/useMarkdown.ts  (existing) useMarkdown().renderHtml(source)
//
// Modules are imported inside each test so a missing export fails that test
// with a clear message instead of failing the whole file at import time.
import { describe, it, expect } from 'vitest'

type DocTitleInput = { sessionName?: string | null; content?: string | null; contentType?: string | null; filename?: string | null }
interface DocTitleModule {
  docTitle: (input: DocTitleInput) => string
  truncateTitle: (title: string, max?: number) => string
  formatDocumentTitle: (title: string) => string
}

// A variable specifier keeps vite from failing the whole file at transform
// time while the module does not exist yet.
const DOC_TITLE_MODULE = '@/composables/useDocTitle'

async function titles(): Promise<DocTitleModule> {
  const mod = (await import(/* @vite-ignore */ DOC_TITLE_MODULE)) as Partial<DocTitleModule>
  for (const name of ['docTitle', 'truncateTitle', 'formatDocumentTitle'] as const) {
    expect(typeof mod[name], `src/composables/useDocTitle.ts must export ${name}()`).toBe('function')
  }
  return mod as DocTitleModule
}

async function render(source: string): Promise<Document> {
  const { useMarkdown } = await import('@/composables/useMarkdown')
  const html = useMarkdown().renderHtml(source)
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html')
}

const md = (content: string, extra: DocTitleInput = {}): DocTitleInput => ({ content, contentType: 'markdown', ...extra })
const html = (content: string, extra: DocTitleInput = {}): DocTitleInput => ({ content, contentType: 'html', ...extra })

// ── AC-05.13 / rule 17: H1 plain text ───────────────────────────────────────
describe('#5 docTitle — first H1 plain text (rule 17, #3 rule 2 semantics)', () => {
  it('AC-05.13 `# **Launch** [plan](http://x) 🚀` -> document.title "Launch plan 🚀 · md-review", doc-title "Launch plan 🚀"', async () => {
    const { docTitle, truncateTitle, formatDocumentTitle } = await titles()
    const t = docTitle(md('# **Launch** [plan](http://x) 🚀\n\nBody.\n', { filename: 'launch.md' }))
    expect(t).toBe('Launch plan 🚀')
    expect(formatDocumentTitle(t)).toBe('Launch plan 🚀 · md-review')
    expect(truncateTitle(t)).toBe('Launch plan 🚀')
  })

  it('AC-05.13 inline code, entities and inline HTML contribute only their text', async () => {
    const { docTitle } = await titles()
    expect(docTitle(md('# The `docTitle` rule\n'))).toBe('The docTitle rule')
    expect(docTitle(md('# R&amp;D &lt;3\n'))).toBe('R&D <3')
    expect(docTitle(md('# Hello <em>there</em>\n'))).toBe('Hello there')
    expect(docTitle(md('# Read [the *guide*](https://example.com/g)\n'))).toBe('Read the guide')
  })

  it('AC-05.13 an H1 that is only an image uses its alt text', async () => {
    const { docTitle } = await titles()
    expect(docTitle(md('# ![Company logo](logo.png)\n\nText.\n', { filename: 'x.md' }))).toBe('Company logo')
  })

  it('AC-05.13 the first H1 wins; H2s, fenced "# lines" and later H1s are ignored; setext H1 counts', async () => {
    const { docTitle } = await titles()
    expect(docTitle(md('## Intro\n\n```\n# not a heading\n```\n\n# Real title\n\n# Second\n', { filename: 'a.md' }))).toBe('Real title')
    expect(docTitle(md('Setext title\n============\n\nBody.\n', { filename: 'a.md' }))).toBe('Setext title')
  })

  it('rule 17: whitespace is collapsed to single spaces', async () => {
    const { docTitle } = await titles()
    expect(docTitle(md('# x\n', { sessionName: '  Q3   review\n\tplan  ' }))).toBe('Q3 review plan')
    expect(docTitle(md('# Spaced    out   title\n'))).toBe('Spaced out title')
  })
})

// ── rule 17 / 00 §5 precedence ──────────────────────────────────────────────
describe('#5 docTitle — precedence (00 §5)', () => {
  it('AC-05.16 / §5.1 sessionName wins over front matter and H1', async () => {
    const { docTitle } = await titles()
    const src = '---\ntitle: "FM title"\n---\n# Heading title\n'
    expect(docTitle(md(src, { sessionName: 'Q3 review', filename: 'q3.md' }))).toBe('Q3 review')
  })

  it('AC-05.12 / §5.2 front-matter title (quotes stripped) beats the H1', async () => {
    const { docTitle } = await titles()
    expect(docTitle(md('---\ntitle: "Q3 Plan"\nowner: me\n---\n# Something else\n', { filename: 'q3.md' }))).toBe('Q3 Plan')
    expect(docTitle(md("---\ntitle: 'single quoted'\n---\n# H\n"))).toBe('single quoted')
    expect(docTitle(md('---\ntitle: Bare words\n---\n# H\n'))).toBe('Bare words')
  })

  it('§5.2 front-matter value keeps colons after the first one (`title: a: b` -> "a: b")', async () => {
    const { docTitle } = await titles()
    expect(docTitle(md('---\ntitle: a: b\n---\n# H\n'))).toBe('a: b')
  })

  it('§5.2 an empty front-matter title falls through to the H1', async () => {
    const { docTitle } = await titles()
    expect(docTitle(md('---\ntitle:\nstatus: draft\n---\n# From heading\n'))).toBe('From heading')
    expect(docTitle(md('---\ntitle: ""\n---\n# From heading\n'))).toBe('From heading')
  })

  it('AC-05.12 / §5.3 without front matter the H1 is used', async () => {
    const { docTitle } = await titles()
    expect(docTitle(md('# Something else\n\nBody.\n', { filename: 'q3.md' }))).toBe('Something else')
  })

  it('AC-05.12 / §5.4 no H1 -> filename without .md/.markdown/.txt/.html/.htm', async () => {
    const { docTitle } = await titles()
    expect(docTitle(md('Just a paragraph.\n\n## Only an H2\n', { filename: 'notes.md' }))).toBe('notes')
    expect(docTitle(md('text\n', { filename: 'report.final.markdown' }))).toBe('report.final')
    expect(docTitle(md('text\n', { filename: 'README.txt' }))).toBe('README')
    expect(docTitle(html('<p>no title, no h1</p>', { filename: 'deck.html' }))).toBe('deck')
    expect(docTitle(html('<p>x</p>', { filename: 'page.htm' }))).toBe('page')
    expect(docTitle(md('text\n', { filename: 'data.json' }))).toBe('data.json')
  })

  it('§5.5 nothing at all -> "Untitled"; a blank sessionName does not count', async () => {
    const { docTitle } = await titles()
    expect(docTitle(md('plain text only\n'))).toBe('Untitled')
    expect(docTitle(md('', { filename: '' }))).toBe('Untitled')
    expect(docTitle(md('# Real\n', { sessionName: '   ' }))).toBe('Real')
  })
})

// ── AC-05.14 / rule 17: HTML documents ──────────────────────────────────────
describe('#5 docTitle — HTML documents (rule 17)', () => {
  it('AC-05.14 the HTML <title> wins over its <h1>', async () => {
    const { docTitle } = await titles()
    const doc = '<!doctype html><html><head><title>Board deck</title></head><body><h1>Other heading</h1></body></html>'
    expect(docTitle(html(doc, { filename: 'deck.html' }))).toBe('Board deck')
  })

  it('AC-05.14 parsing the title never executes the document (scripts, event handlers)', async () => {
    const { docTitle } = await titles()
    const w = window as unknown as Record<string, unknown>
    delete w.__t05script; delete w.__t05img
    const doc = `<!doctype html><html><head><title>Safe title</title>
<script>window.__t05script = 1; window.parent.__t05script = 1</script></head>
<body><img src="x:invalid" onerror="window.__t05img = 1; window.parent.__t05img = 1"><h1>H</h1></body></html>`
    expect(docTitle(html(doc, { filename: 'x.html' }))).toBe('Safe title')
    // An onerror handler would fire asynchronously; give it a chance.
    await new Promise((r) => setTimeout(r, 50))
    expect(w.__t05script).toBeUndefined()
    expect(w.__t05img).toBeUndefined()
  })

  it('rule 17: HTML without <title> uses the first <h1> text; a document with no <head> works', async () => {
    const { docTitle } = await titles()
    expect(docTitle(html('<!doctype html><html><body><h1>First <b>bold</b> h1</h1><h1>Second</h1></body></html>', { filename: 'a.html' }))).toBe('First bold h1')
    expect(docTitle(html('<h1 id="nb">No body tag here</h1><p>Fragment.</p>', { filename: 'nobody.html' }))).toBe('No body tag here')
  })

  it('edge: a <title> only inside a comment or an SVG is not the document title', async () => {
    const { docTitle } = await titles()
    expect(docTitle(html('<!doctype html><html><head><!-- <title>Commented</title> --></head><body><h1>Visible</h1></body></html>', { filename: 'c.html' }))).toBe('Visible')
    expect(docTitle(html('<!doctype html><html><body><svg><title>Icon</title></svg><h1>Visible</h1></body></html>', { filename: 's.html' }))).toBe('Visible')
  })
})

// ── AC-05.17: truncation ────────────────────────────────────────────────────
describe('#5 docTitle — truncation (AC-05.17)', () => {
  const H1_120 = 'A'.repeat(40) + 'B'.repeat(40) + 'C'.repeat(40)

  it('AC-05.17 a 120-char H1 -> document.title is its first 80 chars + "… · md-review"', async () => {
    const { docTitle, formatDocumentTitle } = await titles()
    const t = docTitle(md(`# ${H1_120}\n`, { filename: 'long.md' }))
    expect(t, 'docTitle itself is not truncated').toBe(H1_120)
    expect(formatDocumentTitle(t)).toBe(`${H1_120.slice(0, 80)}… · md-review`)
  })

  it('AC-05.17 truncateTitle: > 80 chars -> 80 + "…"; exactly 80 is unchanged', async () => {
    const { truncateTitle } = await titles()
    expect(truncateTitle(H1_120)).toBe(`${H1_120.slice(0, 80)}…`)
    expect(truncateTitle(H1_120.slice(0, 80))).toBe(H1_120.slice(0, 80))
    expect(truncateTitle('short')).toBe('short')
  })
})

// ── AC-05.19 / rule 20: absolute source lines ───────────────────────────────
describe('#5 front-matter line offset (AC-05.19, rule 20)', () => {
  // line 0 ---, 1 a: 1, 2 b: 2, 3 ---, 4 # Title, 5 '', 6 paragraph, 7 '',
  // 8 list, 9 '', 10 fence open … 12 fence close, 13 '', 14 mermaid … 17, 18 '',
  // 19 table header, 20 sep, 21 row
  const SRC = [
    '---', 'a: 1', 'b: 2', '---',
    '# Title', '',
    'Paragraph on line six.', '',
    '- item on line eight', '',
    '```js', 'const x = 1', '```', '',
    '```mermaid', 'graph LR', '  A --> B', '```', '',
    '| h1 | h2 |', '|----|----|', '| c1 | c2 |', '',
  ].join('\n')

  it('AC-05.19 the h1 on source line 4 has data-line-start="4"; the paragraph on line 6 has data-line-start="6"', async () => {
    const doc = await render(SRC)
    const h1 = doc.querySelector('h1')
    expect(h1?.getAttribute('data-line-start')).toBe('4')
    expect(h1?.getAttribute('data-line-end')).toBe('5')
    const p = [...doc.querySelectorAll('p')].find((e) => e.textContent?.includes('Paragraph on line six'))
    expect(p?.getAttribute('data-line-start')).toBe('6')
    expect(p?.getAttribute('data-line-end')).toBe('7')
  })

  it('AC-05.19 every body block is offset, including fences, mermaid and tables (rule 20)', async () => {
    const doc = await render(SRC)
    const ul = doc.querySelector('ul')
    expect(ul?.getAttribute('data-line-start')).toBe('8')
    const pre = doc.querySelector('pre')
    expect(pre?.getAttribute('data-line-start')).toBe('10')
    expect(pre?.getAttribute('data-line-end')).toBe('13')
    const mermaid = doc.querySelector('.mermaid')
    expect(mermaid?.getAttribute('data-line-start')).toBe('14')
    const table = doc.querySelector('table:not(.frontmatter)')
    expect(table?.getAttribute('data-line-start')).toBe('19')
  })

  it('AC-05.19 the front-matter table spans 0..endLine', async () => {
    const doc = await render(SRC)
    const fm = doc.querySelector('table.frontmatter')
    expect(fm, 'front matter still renders as a table').not.toBeNull()
    expect(fm?.getAttribute('data-line-start')).toBe('0')
    expect(fm?.getAttribute('data-line-end')).toBe('4')
  })

  it('AC-05.19 documents without front matter keep their line numbers', async () => {
    const doc = await render('# Title\n\nParagraph.\n')
    expect(doc.querySelector('h1')?.getAttribute('data-line-start')).toBe('0')
    expect(doc.querySelector('p')?.getAttribute('data-line-start')).toBe('2')
  })

  it('AC-05.19 CRLF front matter is offset the same way', async () => {
    const doc = await render(SRC.replace(/\n/g, '\r\n'))
    expect(doc.querySelector('h1')?.getAttribute('data-line-start')).toBe('4')
  })
})

// ── rule 5: table wrapper ───────────────────────────────────────────────────
describe('#5 table-scroll wrapper (rule 5)', () => {
  it('rule 5: every rendered table (incl. front matter) is wrapped in div.table-scroll with no data-line-*', async () => {
    const doc = await render('---\ntitle: T\n---\n# H\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> - | x | y |\n>   |---|---|\n>   | 3 | 4 |\n')
    const tables = [...doc.querySelectorAll('table')]
    expect(tables.length).toBe(3)
    for (const t of tables) {
      const w = t.parentElement
      expect(w?.tagName).toBe('DIV')
      expect(w?.classList.contains('table-scroll')).toBe(true)
      expect(w?.getAttribute('data-testid')).toBe('table-scroll')
      expect(w?.getAttribute('tabindex')).toBe('0')
      expect(w?.getAttribute('role')).toBe('region')
      expect(w?.getAttribute('aria-label')).toBe('Table')
      expect(w?.hasAttribute('data-line-start')).toBe(false)
      expect(w?.hasAttribute('data-line-end')).toBe(false)
      expect(w?.children.length, 'the wrapper holds only its table').toBe(1)
    }
    // the table keeps its own line range
    const body = tables.find((t) => !t.classList.contains('frontmatter') && t.closest('blockquote') === null)
    expect(body?.getAttribute('data-line-start')).toBe('5')
  })
})

// ── rule 15: autolink class ─────────────────────────────────────────────────
describe('#5 autolink class (rule 15)', () => {
  it('rule 15 / AC-05.9: linkified bare URLs and <…> autolinks get class "autolink"; [text](url) links do not', async () => {
    const doc = await render('See [spec](https://ex.com/a), https://ex.com/b and <https://ex.com/c>. Jump to [intro](#intro).\n')
    const a = (href: string) => doc.querySelector(`a[href="${href}"]`)
    expect(a('https://ex.com/a')?.classList.contains('autolink')).toBe(false)
    expect(a('https://ex.com/b')?.classList.contains('autolink')).toBe(true)
    expect(a('https://ex.com/c')?.classList.contains('autolink')).toBe(true)
    expect(a('#intro')?.classList.contains('autolink')).toBe(false)
  })
})

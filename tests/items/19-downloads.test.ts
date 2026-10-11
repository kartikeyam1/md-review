// #19 Downloads — pure logic (docs/build/specs/19-downloads.md rules 4, 7, AC-19.3)
// and the DOM clean-up of the self-contained HTML export (rule 7b, 7d–7f).
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  sanitizeBase,
  mdFilename,
  htmlExportFilename,
  htmlSourceFilename,
  cleanExportDom,
  assembleHtmlDocument,
  exportThemeClasses,
  stripChromeCss,
  inlineImages,
  diagramsSettled,
  diagramKey,
} from '@/composables/useDownload'

describe('#19 filenames (rule 4)', () => {
  it('AC-19.3 .md names: notes → notes.md, a.txt → a.md, x/y:z.md → x-y-z.md, empty → document.md', () => {
    expect(mdFilename('notes')).toBe('notes.md')
    expect(mdFilename('a.txt')).toBe('a.md')
    expect(mdFilename('x/y:z.md')).toBe('x-y-z.md')
    expect(mdFilename('')).toBe('document.md')
  })

  it('rule 4: .md/.markdown kept as-is (case-insensitive); .TXT stripped; other extensions get .md appended', () => {
    expect(mdFilename('pasted.md')).toBe('pasted.md')
    expect(mdFilename('Weekly Update.md')).toBe('Weekly Update.md')
    expect(mdFilename('README.MARKDOWN')).toBe('README.MARKDOWN')
    expect(mdFilename('Notes.TXT')).toBe('Notes.md')
    expect(mdFilename('data.csv')).toBe('data.csv.md')
    expect(mdFilename('.env.md')).toBe('.env.md')
  })

  it('rule 4: forbidden and control characters become "-", the result is trimmed, blank → document', () => {
    expect(sanitizeBase('a\\b*c?d"e<f>g|h')).toBe('a-b-c-d-e-f-g-h')
    expect(sanitizeBase('tab\there\u0000x\u007f')).toBe('tab-here-x-')
    expect(sanitizeBase('   spaced.md  ')).toBe('spaced.md')
    expect(sanitizeBase('   ')).toBe('document')
    expect(sanitizeBase(undefined as unknown as string)).toBe('document')
    expect(mdFilename('Plan 🚀.md')).toBe('Plan 🚀.md')
    expect(mdFilename('dot.')).toBe('dot.md')
    expect(htmlExportFilename('dot.')).toBe('dot.html')
    expect(sanitizeBase('...')).toBe('document')
  })

  it('edge: a very long name is cut to 200 characters plus the extension (code points, never half an emoji)', () => {
    const long = 'x'.repeat(250)
    expect(mdFilename(`${long}.md`)).toBe(`${'x'.repeat(200)}.md`)
    expect(htmlExportFilename(`${long}.md`)).toBe(`${'x'.repeat(200)}.html`)
    expect(htmlSourceFilename(`${long}.html`)).toBe(`${'x'.repeat(200)}.html`)
    const emoji = '🚀'.repeat(210)
    expect(Array.from(mdFilename(emoji).replace(/\.md$/, '')).length).toBe(200)
    expect(mdFilename(emoji).replace(/\.md$/, '')).toBe('🚀'.repeat(200))
  })

  it('rule 4: .html export replaces the extension; HTML source keeps .html/.htm or appends .html', () => {
    expect(htmlExportFilename('plan.md')).toBe('plan.html')
    expect(htmlExportFilename('notes')).toBe('notes.html')
    expect(htmlExportFilename('a.b.markdown')).toBe('a.b.html')
    expect(htmlExportFilename('.env.md')).toBe('.env.html')
    expect(htmlExportFilename('')).toBe('document.html')
    expect(htmlSourceFilename('report.html')).toBe('report.html')
    expect(htmlSourceFilename('old.HTM')).toBe('old.HTM')
    expect(htmlSourceFilename('page')).toBe('page.html')
    expect(htmlSourceFilename('a:b.html')).toBe('a-b.html')
  })
})

function frag(html: string): HTMLElement {
  const div = document.createElement('div')
  div.className = 'preview-pane github-mode markdown-body'
  div.innerHTML = html
  return div
}

describe('#19 cleanExportDom (rule 7e–7f)', () => {
  it('strips app chrome: code toolbars, fold controls, anchors, reactions, copy status; unwraps code blocks', () => {
    const root = frag([
      '<h2 id="s" class="foldable-heading" data-folded="true" data-line-start="1" data-line-end="2">',
      '<button class="heading-fold-toggle" data-testid="heading-fold-toggle">v</button>Section',
      '<button class="heading-fold-ellipsis" data-testid="heading-fold-ellipsis"></button>',
      '<span class="section-reactions"><button class="section-reaction-chip">👍 1</button></span>',
      '<button class="heading-anchor" data-testid="heading-anchor">#</button></h2>',
      '<p hidden="until-found" data-fold-hidden="">Folded body</p>',
      '<div class="code-block" data-testid="code-block"><div class="code-toolbar" data-testid="code-toolbar" data-export-strip><span class="code-lang-label">js</span><button class="code-copy-btn">Copy</button></div><pre data-line-start="4"><code class="language-js">x</code></pre></div>',
      '<div class="sr-only code-copy-status" data-testid="code-copy-status" data-export-strip>Copied</div>',
      '<p class="comment-highlight" data-line-start="9">Commented</p>',
    ].join(''))
    cleanExportDom(root)
    const html = root.innerHTML
    expect(root.querySelector('button')).toBeNull()
    expect(html).not.toContain('code-copy-btn')
    expect(html).not.toContain('heading-fold-toggle')
    expect(html).not.toContain('heading-anchor')
    expect(html).not.toContain('section-reaction')
    expect(html).not.toContain('code-toolbar')
    expect(html).not.toContain('code-copy-status')
    expect(html).not.toContain('comment-highlight')
    expect(html).not.toContain('data-line-')
    expect(html).not.toContain('data-testid')
    expect(root.querySelector('[hidden]')).toBeNull()
    expect(root.querySelector('[data-fold-hidden]')).toBeNull()
    expect(root.querySelector('[data-folded]')).toBeNull()
    expect(root.querySelector('h2')!.id).toBe('s')
    expect(root.querySelector('h2')!.textContent).toBe('Section')
    expect(root.querySelector('.code-block')).toBeNull()
    expect(root.querySelector(':scope > pre > code.language-js')!.textContent).toBe('x')
    expect(root.querySelector('p')!.textContent).toBe('Folded body')
  })

  it('removes zoom-trigger attributes, scripts and inline event handlers; keeps details as they are', () => {
    const root = frag([
      '<div class="mermaid" data-zoomable="mermaid" data-testid="zoom-trigger" tabindex="0" role="button" aria-label="Open diagram full screen" data-source="graph LR; A-->B" data-rendered-key="k" data-processed="true"><svg id="m1"><g></g></svg></div>',
      '<img src="data:image/png;base64,AAAA" alt="x" data-zoomable="image" data-testid="zoom-trigger" tabindex="0" role="button" aria-label="Open image full screen: x" onerror="alert(1)">',
      '<script>alert(2)</script>',
      '<a href="#s" onclick="evil()">jump</a>',
      '<details><summary>More</summary><p>Inside</p></details>',
      '<details open><summary>Open one</summary><p>Shown</p></details>',
      '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" checked> done</li></ul>',
    ].join(''))
    cleanExportDom(root)
    const m = root.querySelector('.mermaid')!
    for (const a of ['data-zoomable', 'data-testid', 'tabindex', 'role', 'aria-label', 'data-source', 'data-rendered-key', 'data-processed']) {
      expect(m.hasAttribute(a), a).toBe(false)
    }
    expect(m.querySelector('svg')).not.toBeNull()
    const img = root.querySelector('img')!
    for (const a of ['data-zoomable', 'data-testid', 'tabindex', 'role', 'onerror']) expect(img.hasAttribute(a), a).toBe(false)
    expect(img.getAttribute('alt')).toBe('x')
    expect(root.querySelector('script')).toBeNull()
    expect(root.querySelector('a')!.hasAttribute('onclick')).toBe(false)
    expect(root.querySelector('a')!.getAttribute('href')).toBe('#s')
    const details = root.querySelectorAll('details')
    expect(details.length).toBe(2)
    expect(details[0].hasAttribute('open')).toBe(false)
    expect(details[1].hasAttribute('open')).toBe(true)
    const box = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(box.disabled).toBe(true)
    expect(box.checked).toBe(true)
  })

  it('rule 7d: a diagram that failed or never rendered is exported as <pre><code> of its source', () => {
    const root = frag([
      '<div class="mermaid" data-source="graph LR; X-->Y"><pre class="mermaid-error">Diagram error: bad</pre></div>',
      '<div class="mermaid">graph TD; P-->Q</div>',
    ].join(''))
    cleanExportDom(root)
    expect(root.querySelector('.mermaid')).toBeNull()
    const codes = [...root.querySelectorAll('pre > code')].map((c) => c.textContent)
    expect(codes).toEqual(['graph LR; X-->Y', 'graph TD; P-->Q'])
  })
})

describe('#19 assembleHtmlDocument (rule 7a–7c)', () => {
  it('builds one document: doctype, lang, charset, viewport, escaped title, theme classes, inline CSS, main.preview-pane', () => {
    const out = assembleHtmlDocument({
      title: 'Plan <A> & "B"',
      htmlClass: 'dark github-theme',
      themeStyle: 'github',
      mainClass: 'preview-pane markdown-body github-mode',
      css: '.preview-pane{color:red}',
      body: '<h1 id="plan">Plan</h1>',
    })
    expect(out.startsWith('<!doctype html>')).toBe(true)
    expect(out).toContain('<html lang="en" class="dark github-theme" data-theme-style="github">')
    expect(out).toContain('<meta charset="utf-8">')
    expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(out).toContain('<title>Plan &lt;A&gt; &amp; "B"</title>')
    expect(out).toContain('<style>.preview-pane{color:red}</style>')
    expect(out).toContain('<main class="preview-pane markdown-body github-mode"><h1 id="plan">Plan</h1></main>')
    expect(out).not.toMatch(/<script|<link/i)
  })

  it('a stray </style> in the CSS cannot end the style element early', () => {
    const out = assembleHtmlDocument({ title: 't', htmlClass: '', themeStyle: 'default', mainClass: 'preview-pane', css: 'a{content:"</style><script>x</script>"}', body: '' })
    const doc = new DOMParser().parseFromString(out, 'text/html')
    expect(doc.querySelectorAll('script').length).toBe(0)
    expect(doc.querySelectorAll('style').length).toBe(1)
    expect(out.match(/<\/style>/gi)!.length).toBe(1)
  })

  it('exportThemeClasses maps each of the 6 themes to the <html> and <main> classes the app uses', () => {
    expect(exportThemeClasses('light')).toEqual({ htmlClass: '', themeStyle: 'default', mainClass: 'preview-pane' })
    expect(exportThemeClasses('dark')).toEqual({ htmlClass: 'dark', themeStyle: 'default', mainClass: 'preview-pane' })
    expect(exportThemeClasses('github-light')).toEqual({ htmlClass: 'github-theme', themeStyle: 'github', mainClass: 'preview-pane markdown-body github-mode' })
    expect(exportThemeClasses('github-dark')).toEqual({ htmlClass: 'dark github-theme', themeStyle: 'github', mainClass: 'preview-pane markdown-body github-mode' })
    expect(exportThemeClasses('locus-light')).toEqual({ htmlClass: 'locus-theme', themeStyle: 'locus', mainClass: 'preview-pane' })
    expect(exportThemeClasses('locus-dark')).toEqual({ htmlClass: 'dark locus-theme', themeStyle: 'locus', mainClass: 'preview-pane' })
  })
})

describe('#19 stripChromeCss (rule 7e: no chrome styling in the export)', () => {
  it('drops chrome rules and chrome selectors from lists, keeps everything else, recurses into @media', () => {
    const css = [
      '/* a comment { with braces } */',
      ':root .preview-pane { font-size: 15px; }',
      '.preview-pane .code-copy-btn { opacity: 0; }',
      '.preview-pane .code-block:hover .code-copy-btn,\n.preview-pane p { color: red; }',
      '.preview-pane :is(h1, h2):hover > .heading-anchor, .preview-pane h3 { x: 1; }',
      '@media (hover: none) { .preview-pane .code-copy-btn { opacity: 1; } .preview-pane .x { y: 2; } }',
      '@media print { .preview-pane .heading-fold-toggle { display: none; } }',
      '.preview-pane .octicon-info { --octicon: url("data:image/svg+xml,%3Csvg%3E"); content: "{"; }',
      '.preview-pane [data-zoomable] { cursor: zoom-in; }',
    ].join('\n')
    const out = stripChromeCss(css)
    expect(out).not.toMatch(/code-copy|heading-anchor|heading-fold|data-zoomable|a comment/)
    expect(out).toContain(':root .preview-pane {')
    expect(out).toMatch(/\.preview-pane p \{ color: red; \}/)
    expect(out).toMatch(/\.preview-pane h3 \{ x: 1; \}/)
    expect(out).toMatch(/@media \(hover: none\) \{\s*\.preview-pane \.x \{ y: 2; \}\s*\}/)
    expect(out).not.toContain('@media print')
    expect(out).toContain('content: "{";')
    expect(out).toContain('url("data:image/svg+xml,%3Csvg%3E")')
  })
})

describe('#19 inlineImages (rule 7g)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const png = (n: number) => new Blob([new Uint8Array(n)], { type: 'image/png' })
  function stubFetch(map: Record<string, { blob?: Blob; status?: number; length?: number } | 'throw'>) {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      const r = map[url]
      if (!r || r === 'throw') throw new TypeError('network')
      const headers = new Headers(r.length !== undefined ? { 'content-length': String(r.length) } : {})
      return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, headers, blob: async () => r.blob! } as unknown as Response
    }))
    return calls
  }

  it('inlines backend and relative images, keeps data: URIs, leaves external images absolute and unfetched', async () => {
    const api = 'https://api.example.test'
    const rel = new URL('/pics/rel.png', location.href).href
    const calls = stubFetch({ [`${api}/paste/x/files/assets/a.png`]: { blob: png(10) }, [rel]: { blob: png(5) } })
    const root = frag([
      `<img alt="att" src="${api}/paste/x/files/assets/a.png">`,
      '<img alt="rel" src="/pics/rel.png" srcset="/pics/rel@2x.png 2x">',
      '<img alt="data" src="data:image/png;base64,AAAA">',
      '<img alt="ext" src="https://cdn.example.org/e.png">',
    ].join(''))
    await inlineImages(root, { apiBase: api })
    const src = (alt: string) => root.querySelector(`img[alt="${alt}"]`)!.getAttribute('src')!
    expect(src('att')).toMatch(/^data:image\/png;base64,/)
    expect(src('rel')).toMatch(/^data:image\/png;base64,/)
    expect(root.querySelector('img[alt="rel"]')!.hasAttribute('srcset')).toBe(false)
    expect(src('data')).toBe('data:image/png;base64,AAAA')
    expect(src('ext')).toBe('https://cdn.example.org/e.png')
    expect(calls).not.toContain('https://cdn.example.org/e.png')
  })

  it('keeps the absolute URL on a failed fetch, a non-image response, or past the size cap (Content-Length checked first)', async () => {
    const api = 'https://api.example.test'
    const u = (n: string) => `${api}/paste/x/files/assets/${n}.png`
    stubFetch({
      [u('gone')]: { status: 404, blob: png(1) },
      [u('err')]: 'throw',
      [u('html')]: { blob: new Blob(['<p>'], { type: 'text/html' }) },
      [u('big')]: { blob: png(1), length: 50 },
      [u('fits')]: { blob: png(30) },
      [u('over')]: { blob: png(30) },
    })
    const root = frag(['gone', 'err', 'html', 'big', 'fits', 'over'].map((n) => `<img alt="${n}" src="${u(n)}">`).join(''))
    await inlineImages(root, { apiBase: api, maxBytes: 40 })
    const src = (alt: string) => root.querySelector(`img[alt="${alt}"]`)!.getAttribute('src')!
    for (const n of ['gone', 'err', 'html', 'big', 'over']) expect(src(n), n).toBe(u(n))
    expect(src('fits')).toMatch(/^data:image\/png;base64,/)
  })
})

describe('#19 diagramsSettled (rule 7d / 8)', () => {
  it('waits while a diagram is undrawn or still drawn for the previous theme; failed ones count as settled', async () => {
    const root = frag('<div class="mermaid" data-rendered-key="old"><svg></svg></div><div class="mermaid"><pre class="mermaid-error"></pre></div>')
    const node = root.querySelector<HTMLElement>('.mermaid')!
    const key = diagramKey('dark')
    expect(key).toBe(JSON.stringify({ theme: 'dark' }))
    const t0 = Date.now()
    setTimeout(() => { node.dataset.renderedKey = key }, 250)
    await diagramsSettled(root, 3000, key)
    const waited = Date.now() - t0
    expect(waited).toBeGreaterThanOrEqual(200)
    expect(waited).toBeLessThan(2000)
    // Without a key any drawn diagram is settled at once; the wait gives up at its limit.
    const undrawn = frag('<div class="mermaid">graph LR; A-->B</div>')
    const t1 = Date.now()
    await diagramsSettled(undrawn, 200)
    expect(Date.now() - t1).toBeLessThan(1000)
  })
})
